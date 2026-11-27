// One racer for the modelled stat->write window: both algorithms, against a scratch lock.
//   argv: <old|new> <lockPath> <startAtMs> <gapMs>
//   prints: <won|lost|err:CODE> <arrival delta from the barrier, ms>
// The gap stands in for what actually makes the production bug reachable — the scheduler
// preempting a process between its two syscalls. On an idle box those two syscalls are ~1us
// apart, which is why four real sweeps never collided; under load the gap is real.
//
// The arrival delta is printed because a race whose processes did not reach the barrier together
// proves nothing: the first run of this test "passed" the old form only because five of the six
// were still starting up when the winner wrote the lock.
import fs from "node:fs";

const [mode, LOCK, startAt, gapMs] = [process.argv[2], process.argv[3], Number(process.argv[4]), Number(process.argv[5])];
const STALE = 15 * 60 * 1000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const spinUntil = (t) => {
  const coarse = t - 25;
  if (Date.now() < coarse) Atomics.wait(sleeper, 0, 0, coarse - Date.now()); // no busy-wait for the long part
  while (Date.now() < t) { /* tight barrier for the last 25ms */ }
};

spinUntil(startAt);
const arrival = Date.now() - startAt;
const say = (r) => process.stdout.write(`${r} ${arrival}`);

if (mode === "new") {
  // The shipped form: one atomic call decides it.
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" });
    say("won");
  } catch (e) {
    say(e.code === "EEXIST" ? "lost" : "err:" + e.code);
  }
} else {
  // The old form: check, then write.
  let fresh = false;
  try { fresh = Date.now() - fs.statSync(LOCK).mtimeMs < STALE; } catch { /* no lock yet */ }
  if (fresh) say("lost");
  else {
    spinUntil(Date.now() + gapMs);
    try { fs.writeFileSync(LOCK, String(process.pid)); say("won"); } catch { say("err"); }
  }
}
