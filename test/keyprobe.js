// Prints the char codes of raw stdin bytes until it sees "q", then exits 0.
// Used to verify rowpty forwards input bytes (incl. 0x7f DEL) untouched.
const codes = [];
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (buf) => {
  for (const b of buf) {
    if (b === 0x71 /* q */) {
      process.stdout.write("CODES:" + codes.join(",") + "\n");
      process.exit(0);
    }
    codes.push(b);
  }
});
setTimeout(() => {
  process.stdout.write("CODES:timeout:" + codes.join(",") + "\n");
  process.exit(3);
}, 8000);
