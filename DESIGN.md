# rowpty — Windows ConPTY host with a reserved status row

## Problem

`ai-battery` keeps a one-line status bar on the terminal's bottom row while a TUI
(Codex CLI, Claude Code) runs. On WSL/Linux/macOS this works with a POSIX PTY:
the child is told the terminal is one row shorter, the host paints the real
bottom row, and paints are timed to happen only when child output has settled.

On native Windows, two approaches failed:

1. **node-pty (ConPTY) from Node** — broken scrollback, whole-terminal
   corruption, output stalls until the next keypress, intermittent status row.
   Suspected causes: node-pty's conout worker-socket layer, Node's raw-mode
   handling of the host console, and cross-process paint races.
2. **Overlay (child inherits the real console, separate process repaints a row
   every second)** — the child TUI and the painter fight over the same screen:
   flicker, battery line landing inside the Codex prompt area.

rowpty is a single-purpose native host that ports the POSIX runner's design
directly onto raw Win32 ConPTY, with everything (I/O pump + painting) in one
process so console writes can be serialized.

## Constraints

- **Language: C# 5 ONLY**, target .NET Framework 4.8, compiled with the in-box
  `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`. That compiler predates
  C# 6, so: no `$""` interpolation, no `?.`, no `nameof`, no expression-bodied
  members, no `using static`, no async/await... wait, async/await IS C# 5 — allowed
  but prefer plain threads. No NuGet, no external references beyond default
  (System.dll is fine).
- Single source file `src/RowPty.cs`, single output `bin\rowpty.exe`.
- No third-party dependencies. All Win32 via P/Invoke (kernel32).
- Must run on stock Windows 10 1903+ / Windows 11 (CreatePseudoConsole).

## CLI contract

```
rowpty.exe [options] -- CHILD.exe [ARGS...]

--interval SECONDS   status refresh period (float, default 10, min 0.5)
--reserve N          rows reserved at the bottom (default 1, clamp 1..5)
--status-cmd CMD     full Windows command line executed to fetch status text.
                     Occurrences of the literal token {MAXWIDTH} are replaced
                     with (cols - 4) before each run. Optional; when absent the
                     status row shows nothing (still reserved).
--settle-ms N        quiet time after child output before painting (default 50)
--version / --help
```

Exit codes: child's exit code; 2 for usage errors or when stdin/stdout is not a
real console.

Everything after `--` is the child command. The caller (ai-battery) resolves
`.cmd`/`.ps1`/`.js` wrappers itself, so rowpty just quotes argv into a command
line (standard MSVCRT quoting: wrap in quotes when the arg contains space/tab/quote,
double embedded backslashes before a quote, escape quotes) and hands it to
CreateProcess with lpApplicationName = NULL.

## Architecture

```
real console (Windows Terminal / conhost)
   │  raw VT modes, UTF-8 CP
   ├── stdin  ── InputPump thread ──► ConPTY input pipe
   ├── stdout ◄─ OutputPump thread ── ConPTY output pipe   (rows-N sized ConPTY)
   └── stdout ◄─ Painter (main loop) — bottom row, serialized with OutputPump
child process attached to the ConPTY, believes terminal is rows-N tall
```

### Startup

1. `GetStdHandle` in/out. `GetConsoleMode` on both; if either fails → stderr
   message, exit 2.
2. Save original modes + input/output code pages. Set:
   - input: mode = `ENABLE_EXTENDED_FLAGS (0x80) | ENABLE_WINDOW_INPUT (0x08)`
     (line/echo/processed/mouse/quick-edit/insert all off; VT input NOT set —
     rowpty reads win32 INPUT_RECORDs, see InputPump below).
   - output: `ENABLE_PROCESSED_OUTPUT (0x1) | ENABLE_VIRTUAL_TERMINAL_PROCESSING (0x4) | DISABLE_NEWLINE_AUTO_RETURN (0x8)`.
   - `SetConsoleCP(65001)`, `SetConsoleOutputCP(65001)`.
3. `SetConsoleCtrlHandler`: return TRUE for CTRL_C_EVENT and CTRL_BREAK_EVENT
   (bytes flow to the child instead); for CTRL_CLOSE_EVENT run Cleanup and
   return FALSE.
4. Read size via `GetConsoleScreenBufferInfo` (srWindow width/height, min 20x4).
5. Create two pipe pairs (`CreatePipe`, default security, 0 size), then
   `CreatePseudoConsole({cols, rows-N}, inRead, outWrite, 0, out hPC)`. Close
   the child-side handles (inRead, outWrite) in the parent after creation.
6. `STARTUPINFOEX` + `InitializeProcThreadAttributeList` (1 attribute) +
   `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016, hPC)`
   + `CreateProcess(NULL, cmdline, ..., EXTENDED_STARTUPINFO_PRESENT, NULL env,
   cwd = current, &siEx, &pi)`. STARTUPINFO.cb = sizeof(STARTUPINFOEX);
   do NOT set STARTF_USESTDHANDLES.

### Input: win32-input-mode forwarding (NOT a byte pump)

Writing plain VT bytes ("\r", "\x7f") into the ConPTY input pipe makes the
inner conhost synthesize KEY_EVENTs with `wVirtualKeyCode=0` (verified with
test/Win32KeyProbe.cs). win32-event consumers — crossterm TUIs such as Codex
CLI — then cannot recognize Enter (needs vk=13) or Backspace (needs vk=8).
Windows Terminal itself feeds ConPTY with the **win32-input-mode** protocol
instead; rowpty must do the same.

- **InputPump** (background thread): loop `ReadConsoleInputW(hStdIn, records)`.
  For each `KEY_EVENT_RECORD` (both key-down and key-up):
  - **Repair** events whose `wVirtualKeyCode == 0` but `UnicodeChar != 0`
    (these appear when rowpty itself runs under a plain-byte feeder):
    ch 13 → vk 13 (VK_RETURN); ch 8 or 127 → vk 8 (VK_BACK) with ch forced
    to 8; ch 9 → vk 9 (VK_TAB); ch 27 → vk 27 (VK_ESCAPE); otherwise
    `VkKeyScanW(ch)` — low byte becomes vk, and the shift-state high byte maps
    into dwControlKeyState (1→SHIFT_PRESSED 0x10, 2→LEFT_CTRL_PRESSED 0x08,
    4→LEFT_ALT_PRESSED 0x02); if VkKeyScanW returns -1 leave vk 0.
  - Encode as a win32-input-mode sequence and write to the conpty input pipe:
    `ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _` — all decimal integers:
    Vk = wVirtualKeyCode, Sc = wVirtualScanCode, Uc = (int)UnicodeChar,
    Kd = bKeyDown (1/0), Cs = dwControlKeyState, Rc = wRepeatCount.
  - Only encode this way while `win32InputModeEnabled` is true (see below);
    before that, fall back to writing the key-down UnicodeChar as UTF-8 bytes
    (skip char 0), which is enough for the sub-second window before the inner
    conpty announces the mode.
  - Ignore MOUSE_EVENT and WINDOW_BUFFER_SIZE_EVENT records (size changes are
    handled by the main-loop poll).
- **win32InputModeEnabled**: OutputPump scans each output chunk (same cheap
  ESC scan as the clear-screen detection) for `ESC[?9001h` → set the flag,
  `ESC[?9001l` → clear it. ConPTY emits `?9001h` at startup, so the flag flips
  almost immediately.
- **OutputPump** (background thread): loop `ReadFile(conptyOutRead, buf 16384)`
  → under `lock(ConsoleLock)` `WriteFile(hStdOut)`. After each chunk set
  `Volatile.Write(ref lastOutputTicks, Stopwatch ticks)` and `screenDirty = true`.
  ReadFile returning FALSE/0 bytes (pipe closed) → exit thread.
- **StatusFetcher** (background thread, only when --status-cmd given): every
  refresh request, run the status command with stdout redirected
  (`ProcessStartInfo`, UseShellExecute=false, RedirectStandardOutput=true,
  CreateNoWindow=true, StandardOutputEncoding=UTF8), 1500 ms timeout then Kill.
  Trim trailing CR/LF. Non-empty + exit 0 → store into `statusText` (volatile,
  under a small lock). Signal main loop that a paint is wanted. Never let an
  exception escape (catch-all; keep previous text).

### Main loop (~20 Hz)

Every 50 ms tick:
1. Child exited (`Process`/`WaitForSingleObject` 0 ms)? → break.
2. Every ~200 ms: re-read console size; if changed →
   `ResizePseudoConsole(hPC, {cols, rows-N})`, recompute status row, request
   status refetch (MAXWIDTH changed), force paint.
3. Refresh due (`now >= nextFetch`)? → enqueue fetch on StatusFetcher,
   `nextFetch = now + interval`.
4. Paint policy (port of the Python runner):
   - if `screenDirty` and `now - lastOutput >= settleMs` → paint, clear dirty;
   - else if `screenDirty` and `now - lastPaint >= 750 ms` → paint anyway
     (child streaming continuously), clear dirty;
   - else if status text changed since last paint → paint.
5. Paint = under `lock(ConsoleLock)` write UTF-8 bytes of:
   `ESC 7  ESC [0m  ESC [{row};1H  ESC [1G  {line}  ESC [K  ESC [0m  ESC 8`
   where `row = rows` (the real bottom row; with --reserve 2 the extra rows
   above stay blank), and `line` = statusText ANSI-aware fitted to `cols - 1`:
   strip pattern `\x1b\[[0-?]*[ -/]*[@-~]` to measure; if too long use the
   stripped text truncated; pad with spaces to exactly the width.
   Skip the write entirely if the padded line AND row are unchanged since the
   last paint and this paint wasn't forced (resize / clear-screen detection).
6. Clear-screen detection: OutputPump scans each chunk (cheap byte scan for
   ESC) for `\x1bc`, `\x1b[2J`, `\x1b[3J`, `\x1b[?1049h/l`; if seen, set a
   `forceRepaint` flag the main loop honors for the next ~3 paints.

### Shutdown

1. Wait for the child, get exit code.
2. `ClosePseudoConsole`, close pipe handles, join pumps (with timeout).
3. Clear the status row: `ESC 7 ESC [0m ESC [{row};1H ESC [2K ESC 8`.
4. Restore original console modes and code pages.
5. `Environment.Exit(childExitCode)`.

Wrap the whole run in try/finally so modes/CPs are restored even on exceptions.

## Why this can work where node-pty didn't

- Same-process, lock-serialized console writes: the status line can never be
  interleaved into the middle of a child escape sequence, and paints happen at
  output-settle boundaries (the POSIX runner's proven policy) instead of a
  blind 1 s repaint from a separate process.
- No worker/socket relay on the conout path: pipe → console, one hop.
- Host console modes are set explicitly and exactly once (VT input+output,
  UTF-8), rather than whatever Node's tty layer chooses.
- Input is a pure byte passthrough — no DEL/BS rewriting.

Residual risk: the OS ConPTY still mediates the child's output. On current
Win11 builds plain scrolled lines are emitted as ordinary linefeed scrolling,
so the outer terminal keeps scrollback; if a regression appears, the
`AI_BATTERY_WIN_LAYOUT=overlay` fallback in ai-battery remains.

## Build

`build.cmd` at repo root:

```
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /warn:4 /out:bin\rowpty.exe src\RowPty.cs
```

## Test plan

`test/smoke.mjs` (run with the node + node-pty from the ai-battery checkout)
spawns `bin\rowpty.exe --interval 1 --status-cmd "cmd /d /c echo BATT {MAXWIDTH}" -- cmd /d /c <script>`
inside a node-pty ConPTY and asserts:
1. child stdout appears;
2. output produced 2 s after start arrives with no input written;
3. the status text `BATT` appears, positioned via `ESC[<rows>;1H`;
4. bytes written to the pty (including `\x7f`) reach the child untouched
   (child = `findstr`-style echo loop or a tiny node script printing char codes);
5. exit code propagates (child exits 7 → rowpty exits 7).
