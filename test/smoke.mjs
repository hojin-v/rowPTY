// Smoke-tests bin/rowpty.exe inside a node-pty ConPTY.
// Run from the rowpty repo root with the ai-battery checkout as a sibling:
//   node test\smoke.mjs
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROWPTY = path.join(HERE, "..", "bin", "rowpty.exe");
const require = createRequire(path.join(HERE, "..", "..", "ai-battery", "package.json"));
const pty = require("node-pty");

const ROWS = 30;
const COLS = 100;

function runInPty(argv, { input = null, inputDelayMs = 500, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const term = pty.spawn(argv[0], argv.slice(1), {
      name: "xterm-256color",
      cols: COLS,
      rows: ROWS,
      cwd: path.join(HERE, ".."),
      env: process.env
    });
    let out = "";
    const chunks = [];
    const started = Date.now();
    term.onData((d) => {
      out += d;
      chunks.push({ t: Date.now() - started, data: d });
    });
    term.onExit(({ exitCode }) => resolve({ out, chunks, exitCode }));
    if (input !== null) setTimeout(() => term.write(input), inputDelayMs);
    setTimeout(() => { try { term.kill(); } catch {} }, timeoutMs);
  });
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (ok ? "" : "  -- " + detail));
  if (!ok) failures += 1;
}

// 1) passthrough + delayed output + status row + exit code
{
  const res = await runInPty([
    ROWPTY,
    "--interval", "1",
    "--status-cmd", "cmd /d /c echo BATT-{MAXWIDTH}",
    "--",
    "cmd", "/d", "/c", "echo first & ping -n 3 127.0.0.1 >nul & echo delayed-marker & exit /b 7"
  ]);
  check("child stdout passes through", res.out.includes("first"), res.out.slice(0, 400));
  const delayed = res.chunks.find((c) => c.data.includes("delayed-marker"));
  check("delayed output arrives without any input", Boolean(delayed) && delayed.t >= 1200,
    delayed ? "t=" + delayed.t : "marker missing");
  check("status text painted", res.out.includes("BATT-" + (COLS - 4)),
    "expected BATT-" + (COLS - 4));
  check("status painted on bottom row", res.out.includes(`\x1b[${ROWS};1H`),
    "no CUP to row " + ROWS);
  check("exit code propagates", res.exitCode === 7, "exitCode=" + res.exitCode);
}

// 2) keys reach a VT-mode child as single keypresses (node/libuv view)
{
  const res = await runInPty([
    ROWPTY,
    "--",
    process.execPath, path.join(HERE, "keyprobe.js")
  ], { input: "a\r\x7f" + "q", inputDelayMs: 1500 });
  const m = res.out.match(/CODES:([0-9,]*)/);
  check("keyprobe replied", Boolean(m), res.out.slice(-400));
  if (m) {
    const codes = m[1].split(",").filter(Boolean).map(Number);
    check("letter 'a' (97) forwarded", codes.includes(97), m[1]);
    check("Enter arrives as CR (13)", codes.includes(13), m[1]);
    check("Backspace arrives as one key (127 or 8)", codes.includes(127) || codes.includes(8), m[1]);
  }
}

// 2b) keys reach a win32-events child (crossterm view: Codex CLI, ratatui apps)
// Regression test for: forcing ENABLE_VIRTUAL_TERMINAL_INPUT on the inner
// console broke Enter/Backspace in crossterm TUIs.
{
  const { spawnSync } = await import("node:child_process");
  const probeExe = path.join(HERE, "Win32KeyProbe.exe");
  const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const compile = spawnSync(csc, ["/nologo", "/optimize+", "/out:" + probeExe, path.join(HERE, "Win32KeyProbe.cs")], { encoding: "utf8" });
  check("win32 key probe compiles", compile.status === 0, (compile.stdout || "") + (compile.stderr || ""));

  if (compile.status === 0) {
    const res = await runInPty([ROWPTY, "--", probeExe], { input: "\r\x7f" + "q", inputDelayMs: 1500 });
    const m = res.out.match(/EVENTS:((?:vk=\d+,ch=\d+;)*)/);
    check("win32 probe replied", Boolean(m) && !res.out.includes("EVENTS:timeout"), res.out.slice(-400));
    if (m) {
      check("Enter is a VK_RETURN key event (vk=13)", m[1].includes("vk=13,ch=13;"), m[1]);
      check("Backspace is a VK_BACK key event (vk=8)", m[1].includes("vk=8,"), m[1]);
    }
  }
}

// 3) non-console stdio is rejected cleanly (direct spawn, no pty)
{
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(ROWPTY, ["--", "cmd", "/d", "/c", "echo hi"], { encoding: "utf8" });
  check("non-console run exits 2", res.status === 2, "status=" + res.status + " err=" + (res.stderr || "").trim());
}

console.log(failures === 0 ? "ALL PASS" : failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
