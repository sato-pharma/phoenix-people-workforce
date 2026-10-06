// The guard that refuses a session widening its own permissions must actually be TESTED somewhere.
//
// WHY THIS EXISTS. `risky-allow-guard.mjs` denies a Write or Edit that adds a risky `allow` wildcard
// to any Claude settings file — the entries that would hand a session a blank cheque, such as
// `Bash(python -c ' *)`, `Bash(node -e " *)`, `Bash(npx *)` or `Bash(railway run *)`. It is a GLOBAL
// hook, in `~/.claude/hooks/`, so no repository could ever see it weaken.
//
// 🔴 IT ALREADY CARRIED A 12-CASE SELFTEST, AND THAT SUITE HAD NEVER RUN. It was named in no
// `HOOK_SELFTESTS` entry and in no file under `tests/`, so by this repo's own rule it executed only
// when a human typed it (docs/testing.md: a test not registered never runs). The owner asked for it to
// be pinned on 2026-10-06, after the same gap was closed for the delete guard and the Next step guard.
//
// 🔴 IT TAKES `--selftest`, NOT `selftest`. The other two pinned hooks take the bare word, and a sweep
// for the bare word is precisely how this suite stayed invisible: the probe ran, printed nothing, exited
// 0, and read as "no selftest here". The flag is asserted below for that reason.
//
// WHAT IS ASSERTED. The same three layers as verify-shipped-selftest.test.ts and
// next-step-guard-decisions.test.ts — with one difference stated plainly rather than papered over:
//   1. the selftest runs and reports 0 failed;
//   2. the case COUNT never falls — catches deleting a case, which layer 1 reports as a clean run;
//   3. the load-bearing cases are still present BY NAME — but this selftest prints its case labels ONLY
//      on failure, so layer 3 reads them out of the SOURCE instead of the output. That is weaker: it
//      proves the case is written, not that it ran. The count ratchet is what covers the gap between
//      those two, which is why both layers are here rather than either alone.
//
// It drives the mirrored copy as a subprocess. A green run here means the copy committed at this sha is
// sound, never that the laptop's hook is — `claude-scripts-backup.mjs` (HOOK_SELFTESTS) runs the live
// file hourly for that half, and it exists only on the owner's machine.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOOK = join(REPO_ROOT, ".claude", "cloud-context", "laptop-hooks", "risky-allow-guard.mjs");

// A ratchet, not an equality: cases may RISE and must never FALL.
const MIN_CASES = 12;

// Read from the SOURCE, because this selftest prints labels only when a case fails. Each of these is a
// case whose removal would let a specific class of over-broad rule through unnoticed.
const LOAD_BEARING = [
  "all risky wildcards hit", // the positive set — every blank-cheque pattern
  "no benign rule hits", // the negative set; without it the guard may deny exact commands
  "Write surfaces the risky allow entry", // a whole settings object written at once
  "Edit adding the wildcard line is caught", // one appended line, the common shape
  "managed settings", // managed-settings.json counts as a settings file
];

export function runRiskyAllowGuardPinTests() {
  assert.ok(
    existsSync(HOOK),
    `the pinned copy of risky-allow-guard.mjs must exist at ${HOOK}. ` +
      "It is produced by `node scripts/sync-cloud-context.mjs` (PINNED_HOOKS) — if that stopped mirroring it, " +
      "fix the sync rather than deleting this test, because a missing copy is how CI comes to test nothing.",
  );

  const source = readFileSync(HOOK, "utf8");

  assert.ok(
    source.includes("--selftest"),
    "the pinned copy must still accept `--selftest`. If the flag was renamed, update the hourly " +
      "HOOK_SELFTESTS entry in claude-scripts-backup.mjs in the same change — otherwise the hourly run " +
      "silently exercises nothing, which is the state this test was written to end.",
  );

  assert.ok(
    source.includes("riskyHits"),
    "the pinned copy must be the real guard — it no longer contains riskyHits, the function that decides " +
      "whether an allow entry is a blank cheque.",
  );

  const run = spawnSync(process.execPath, [HOOK, "--selftest"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
    timeout: 120_000,
  });

  const output = `${run.stdout || ""}${run.stderr || ""}`;

  assert.equal(
    run.status,
    0,
    `risky-allow-guard.mjs --selftest must exit 0.\nexit=${run.status}\n${output}`,
  );

  assert.ok(
    /SELFTEST OK/.test(output),
    `the selftest must print SELFTEST OK on success, which is what proves it reached the end rather than ` +
      `returning early.\n${output}`,
  );

  const summary = /(\d+) cases, (\d+) failed/.exec(output);
  assert.ok(summary, `the selftest must print its own summary line so this test can read the counts; got:\n${output}`);

  const cases = Number(summary[1]);
  const failed = Number(summary[2]);

  assert.equal(failed, 0, `the risky-allow guard selftest reported ${failed} failed case(s):\n${output}`);

  assert.ok(
    cases >= MIN_CASES,
    `the risky-allow guard selftest has ${cases} cases and must never drop below ${MIN_CASES}. ` +
      "Cases were deleted, not fixed — a green run with fewer cases is exactly what this ratchet exists to catch. " +
      "If cases were genuinely consolidated, lower MIN_CASES in the same commit and say why in the message.",
  );

  for (const fragment of LOAD_BEARING) {
    assert.ok(
      source.includes(fragment),
      `the risky-allow guard selftest no longer contains the case "${fragment}". ` +
        "Each of these covers a distinct way an over-broad allow rule reaches the settings file — a whole " +
        "object written at once, a single appended line, the managed settings path, and the negative set that " +
        "keeps the guard from denying exact commands.",
    );
  }
}
