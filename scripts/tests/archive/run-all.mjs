// Every regression test for the two archive sweeps. Run: node run-all.mjs
//
// What each one pins, and the break that was watched firing for it on 2026-10-09:
//   test-lock         the repo sweep's lock: atomic create, stale takeover, a real 4-way sweep race
//   test-lock-window  the defect itself — the old check-then-write gives 6 winners of 6, 'wx' gives 1
//   test-verify       --verify reports a document LOST only when no copy of its content exists
//   test-scan         a refresh keeps a tree the scan missed, and drops one that is really gone
//   test-sibling-lock the scratchpad sweep's lock, fired by the Stop hook in every session
//   test-guard-verify  the delete guard refuses a wipe that would take the last copy of a document,
//                      allows one where every document is held, and FAILS OPEN on its own errors
//   test-ownpath-repair the sweep and verify WRITE DOWN the own-path copy they just used: the
//                      unchanged fast path repoints a dead pointer, a recorded destination that is
//                      gone is no longer trusted, and verify's pass one heals instead of only
//                      reporting (added 2026-10-09, with 1,946 dead pointers on the real archive)
//   test-prune-pointers a dead pointer is a TOMBSTONE: recoverDeleted asks if (shas[sha]) without
//                      checking the path, so the guarded prune drops only an entry a gitBlobs twin
//                      still blocks — the break watches an unguarded prune resurrect a document
//   test-history-guard  recoverDeleted existence-checks BOTH guards but never writes on existence
//                      alone: a dead pointer asks the archive by CONTENT, so a document held
//                      nowhere is written back while a de-duplicated one is only repointed —
//                      break A leaves the lost document lost, break B resurrects the duplicate
//   test-sweep-reuse    the guard's sweep-then-verify speed-up (2026-11-06): an unchanged sweep
//                      does not rewrite the index, a copy is still written down, verify on the
//                      reused state still finds a LOST document, and a skipped sweep is never reused
import { spawnSync } from "node:child_process";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SUITES = ["test-lock.mjs", "test-lock-window.mjs", "test-verify.mjs", "test-scan.mjs", "test-sibling-lock.mjs", "test-guard-verify.mjs", "test-ownpath-repair.mjs", "test-prune-pointers.mjs", "test-history-guard.mjs", "test-sweep-reuse.mjs"];

let failed = 0, skipped = 0;
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [path.join(HERE, s)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const pass = (out.match(/^PASS/gm) || []).length;
  const fail = (out.match(/^FAIL/gm) || []).length;
  if (r.status === 3) { skipped++; console.log(`SKIP  ${s.padEnd(22)} a live sweep holds the lock`); continue; }
  if (r.status !== 0 || fail) { failed++; console.log(`FAIL  ${s.padEnd(22)} ${pass} passed, ${fail} failed`); console.log(out.split("\n").filter((l) => l.startsWith("FAIL")).map((l) => "        " + l).join("\n")); }
  else console.log(`ok    ${s.padEnd(22)} ${pass} assertions`);
}
console.log(failed ? `\n${failed} suite(s) FAILED` : `\nall suites pass${skipped ? ` (${skipped} skipped)` : ""}`);
process.exit(failed ? 1 : 0);
