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

function blankLine() {
  return Array(COLS).fill(" ");
}

function parseCsiParams(raw) {
  const privateMode = raw.startsWith("?");
  const body = privateMode ? raw.slice(1) : raw;
  const values = body
    .split(";")
    .map((part) => {
      const number = Number.parseInt(part, 10);
      return Number.isFinite(number) ? number : 0;
    });
  return { privateMode, values };
}

function renderTerminal(text) {
  const screen = Array.from({ length: ROWS }, blankLine);
  const scrollback = [];
  let row = 0;
  let col = 0;
  let i = 0;

  const scroll = () => {
    scrollback.push(screen.shift().join(""));
    screen.push(blankLine());
    row = ROWS - 1;
  };

  const clearLineFrom = (targetRow, startCol) => {
    for (let x = Math.max(0, startCol); x < COLS; x += 1) {
      screen[targetRow][x] = " ";
    }
  };

  const clearDisplayFrom = (startRow, startCol) => {
    clearLineFrom(startRow, startCol);
    for (let y = startRow + 1; y < ROWS; y += 1) {
      clearLineFrom(y, 0);
    }
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === "\x1b") {
      const next = text[i + 1];
      if (next === "[") {
        let cursor = i + 2;
        let params = "";
        while (cursor < text.length && !/[A-Za-z~]/.test(text[cursor])) {
          params += text[cursor];
          cursor += 1;
        }
        if (cursor >= text.length) break;
        const final = text[cursor];
        const parsed = parseCsiParams(params);
        const p = parsed.values;
        if (final === "H" || final === "f") {
          row = Math.min(ROWS - 1, Math.max(0, (p[0] || 1) - 1));
          col = Math.min(COLS - 1, Math.max(0, (p[1] || 1) - 1));
        } else if (final === "J") {
          const mode = p[0] || 0;
          if (mode === 2 || mode === 3) {
            for (let y = 0; y < ROWS; y += 1) screen[y] = blankLine();
            row = 0;
            col = 0;
            if (mode === 3) scrollback.length = 0;
          } else {
            clearDisplayFrom(row, col);
          }
        } else if (final === "K") {
          const mode = p[0] || 0;
          if (mode === 2) {
            clearLineFrom(row, 0);
          } else {
            clearLineFrom(row, col);
          }
        }
        i = cursor + 1;
        continue;
      }
      if (next === "]") {
        const bel = text.indexOf("\x07", i + 2);
        if (bel >= 0) {
          i = bel + 1;
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (ch === "\r") {
      col = 0;
    } else if (ch === "\n") {
      row += 1;
      if (row >= ROWS) scroll();
    } else if (ch >= " ") {
      if (col >= COLS) {
        col = 0;
        row += 1;
        if (row >= ROWS) scroll();
      }
      screen[row][col] = ch;
      col += 1;
    }
    i += 1;
  }

  return [...scrollback, ...screen.map((line) => line.join(""))].join("\n");
}

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

// 2c) status row is repainted after the child wipes it, even with unchanged text
// Regression test for: dirty repaints were dedup-skipped and ED-to-end
// (ESC[0J, which reaches the real bottom row) was not detected, so the
// battery bar stayed invisible while Codex streamed a response.
{
  const res = await runInPty([
    ROWPTY,
    "--interval", "60",
    "--status-cmd", "cmd /d /c echo BATT-{MAXWIDTH}",
    "--",
    process.execPath, path.join(HERE, "wipeprobe.js")
  ]);
  const wipeAt = res.out.lastIndexOf("WIPE-NOW");
  check("wipe probe ran", wipeAt >= 0, res.out.slice(-300));
  if (wipeAt >= 0) {
    const after = res.out.slice(wipeAt);
    const repainted = after.includes(`\x1b[${ROWS};1H`) && after.includes("BATT-");
    check("status row repainted after ED wipe with unchanged text", repainted,
      "post-wipe output lacks a bottom-row repaint: " + JSON.stringify(after.slice(0, 300)));
  }
}

// 2d) without a host scroll region, rowpty clears its painted status row before
// forwarding the next child output. Otherwise the status row can be scrolled into
// the transcript as a stale "screen capture" frame.
{
  const res = await runInPty([
    ROWPTY,
    "--interval", "0.5",
    "--status-cmd", "cmd /d /c echo BATT-{MAXWIDTH}",
    "--",
    process.execPath,
    "-e",
    "console.log('before-status'); setTimeout(()=>console.log('after-status-output'), 2200)"
  ]);
  const delayedAt = res.out.indexOf("after-status-output");
  const beforeDelayed = delayedAt >= 0 ? res.out.slice(0, delayedAt) : res.out;
  const statusAt = beforeDelayed.indexOf("BATT-" + (COLS - 4));
  const clearAt = beforeDelayed.lastIndexOf(`\x1b[${ROWS};1H\x1b[K`);
  check("status row painted before delayed output", delayedAt > 0 && statusAt >= 0 && statusAt < delayedAt,
    JSON.stringify(res.out.slice(0, 500)));
  check("painted status row clears before next child output", clearAt > statusAt,
    "statusAt=" + statusAt + " clearAt=" + clearAt + " delayedAt=" + delayedAt);
}

// 2e) Codex-like redraws should leave a clean final response history. This
// catches the user-visible failure mode where previous TUI frames remain in the
// scrollback like stale screenshots.
{
  const codexLikeScript = [
    "const esc='\\x1b';",
    "const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));",
    "const w=(s)=>process.stdout.write(s);",
    "function line(row,text){w(`${esc}[${row};1H${text}${esc}[K`)}",
    "function frame(n){",
    "  w(`${esc}[?25l${esc}[H${esc}[2J`);",
    "  line(1,`AI_BATTERY_CODEX_FRAME_${n}`);",
    "  line(2,'>- OpenAI Codex (fake renderer)');",
    "  line(4,'user: explain terminal row rendering');",
    "  line(6,`assistant streaming draft frame ${n}`);",
    "  line(8,`AI_BATTERY_TRANSIENT_FRAME_${n}_MUST_NOT_REMAIN`);",
    "}",
    "for (let i=1;i<=8;i++){frame(i); await sleep(120);}",
    "w(`${esc}[H${esc}[2J`);",
    "line(1,'AI_BATTERY_CODEX_FINAL_HISTORY');",
    "line(3,'user: explain terminal row rendering');",
    "line(5,'assistant: final response line 1');",
    "line(6,'assistant: final response line 2');",
    "line(8,'AI_BATTERY_FINAL_RESPONSE_DONE');",
    "w(`${esc}[?25h`);",
    "await sleep(900);"
  ].join("");
  const res = await runInPty([
    ROWPTY,
    "--interval", "0.5",
    "--status-cmd", "cmd /d /c echo AI_BATTERY_CODEX_STATUS",
    "--",
    process.execPath,
    "--input-type=module",
    "-e",
    codexLikeScript
  ]);
  const rendered = renderTerminal(res.out);
  const transient = rendered.match(/AI_BATTERY_TRANSIENT_FRAME_\d+_MUST_NOT_REMAIN/g) || [];
  const staleFrames = rendered.match(/AI_BATTERY_CODEX_FRAME_\d+/g) || [];
  const statusCopies = rendered.match(/AI_BATTERY_CODEX_STATUS/g) || [];
  check("Codex-like final history is visible", rendered.includes("AI_BATTERY_FINAL_RESPONSE_DONE"),
    JSON.stringify(rendered.slice(-800)));
  check("Codex-like transient frames are absent from rendered history", transient.length === 0,
    transient.slice(0, 5).join(", "));
  check("Codex-like stale frame headers are absent from rendered history", staleFrames.length === 0,
    staleFrames.slice(0, 5).join(", "));
  check("rowpty status marker does not leak into rendered history after exit", statusCopies.length === 0,
    "statusCopies=" + statusCopies.length);
}

// 3) non-console stdio is rejected cleanly (direct spawn, no pty)
{
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(ROWPTY, ["--", "cmd", "/d", "/c", "echo hi"], { encoding: "utf8" });
  check("non-console run exits 2", res.status === 2, "status=" + res.status + " err=" + (res.stderr || "").trim());
}

console.log(failures === 0 ? "ALL PASS" : failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
