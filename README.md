# rowpty

Windows ConPTY host that runs a terminal program one row shorter than the real
console and keeps the bottom row reserved for a status line — the native
Windows counterpart of a POSIX-PTY status-row runner.

Built for [ai-battery](../ai-battery), but generic: any command can be hosted
and any command line can supply the status text.

```
rowpty.exe [--interval SECONDS] [--reserve N] [--status-cmd CMD] [--settle-ms N] -- CHILD [ARGS...]
```

`--status-cmd` is run periodically with `{MAXWIDTH}` replaced by the usable
status width; its first line of stdout becomes the bottom-row text.

## Build

Requires only stock Windows (.NET Framework 4.8's in-box `csc.exe`):

```
build.cmd
```

Produces `bin\rowpty.exe`. See `DESIGN.md` for architecture and rationale.
