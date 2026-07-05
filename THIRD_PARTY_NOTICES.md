# Third-party notices

## conpty.dll / OpenConsole.exe

`bin/conpty.dll` and `bin/OpenConsole.exe` are unmodified binaries from the
[Microsoft Windows Terminal](https://github.com/microsoft/terminal) project
(MIT License, Copyright (c) Microsoft Corporation), redistributed here the same
way the [node-pty](https://github.com/microsoft/node-pty) project redistributes
them (taken from node-pty 1.1.0 `prebuilds/win32-x64/conpty/`).

They provide the modern passthrough ConPTY implementation. rowpty loads
`conpty.dll` when it is present next to `rowpty.exe` and otherwise falls back
to the operating system's built-in ConPTY.
