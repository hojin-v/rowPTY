// Emits a clear-to-end-of-screen (ED 0) that wipes the real bottom row,
// to verify rowpty repaints the status line even though its text is unchanged.
const w = (s) => process.stdout.write(s);
w("wipeprobe-start\n");
setTimeout(() => {
  w("WIPE-NOW");
  w("\x1b[0J");
}, 2500);
setTimeout(() => process.exit(0), 5000);
