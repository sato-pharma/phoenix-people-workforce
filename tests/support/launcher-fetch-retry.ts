import assert from "node:assert/strict";

/** The exact line the 21:00 field day run died on, 2026-10-08, when the memory fold fetched in the same second. */
export const LOST_LOCK_2026_10_08 =
  "error: cannot lock ref 'refs/remotes/origin/main': is at 201fe135170c422363b04240b6d4303120cda0d6 but expected d5fedeacffd454e00ee63d86690dfbed234bafc7";

/**
 * 🔴 A FETCH THAT LOSES A LOCK IS RETRIED, NOT FATAL. Both scheduled launchers — the memory fold's
 * `run-fold.mjs` and the CRM field day's `run-nightly.mjs` — fire at 21:00 Cairo and fetch
 * `origin/main` into the same `.git`; on 2026-10-08 they did it in the same second and the field day
 * died on the lock, so there were no papers that night. They run outside every checkout on node
 * builtins only, so they cannot share a module: each carries the same tiny retry, and this one check
 * holds both to it. Pass the COMMENT-FREE source; the launcher's own RETRYABLE pattern is run against
 * real error text, so a pattern that reads right but matches nothing fails here.
 */
export function assertFetchRetriesALostLock(code: string, file: string) {
  const pattern = /const RETRYABLE = \/(.+)\/i;/.exec(code);
  assert.ok(pattern, `${file}: the fetch retry must name its retryable failures in one RETRYABLE pattern`);
  const retryable = new RegExp(pattern![1], "i");
  for (const text of [
    LOST_LOCK_2026_10_08,
    "error: Unable to create 'F:/Phoenix Workforce/phoenix-workforce/.git/refs/remotes/origin/main.lock': File exists.",
    "fatal: unable to access 'https://github.com/x/y.git/': Recv failure: Connection was reset",
  ]) assert.ok(retryable.test(text), `${file}: a lost lock or a network blip must be retried: ${text.slice(0, 60)}`);
  for (const text of ["fatal: couldn't find remote ref main", "fatal: not a git repository", "error: pathspec 'x' did not match"]) {
    assert.ok(!retryable.test(text), `${file}: a real failure must throw at once, never be retried: ${text}`);
  }
  assert.ok(
    /const fetchMain = \(\) =>/.test(code) && /^\s*fetchMain\(\);$/m.test(code),
    `${file}: the run must fetch through fetchMain(), not a bare git fetch`,
  );
  assert.equal(
    [...code.matchAll(/git\(\["fetch"/g)].length,
    1,
    `${file}: the only fetch is the one inside fetchMain — a second bare fetch would race unguarded`,
  );
  assert.ok(/attempt >= 5/.test(code), `${file}: the retry must be bounded — a stuck lock may not hang a nightly job`);
}
