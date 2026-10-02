import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { rollupMembers, isRollupBranch } from "../scripts/rollup-duplicate-guard.mjs";
import { rollupHolding, rollupMemberDenial, unreadableRollups } from "../scripts/rollup-member-guard.mjs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * MERGING A ROLL-UP'S MEMBER IS REFUSED MECHANICALLY, NOT COMMENTED ON.
 *
 * A roll-up exists so the owner approves ONE merge instead of several; a merge costs two full CI
 * runs whatever its size. The moment a member is merged on its own the roll-up replaces nothing —
 * its files go byte-identical on `main` (the `carried` verdict), so it can only be closed, and the
 * member has paid its own `main` run regardless.
 *
 * 🔴 THE RULE EXISTED AND DID NOT HOLD. AGENTS.md has said "check `gh pr list` for an open
 * `codex/rollup-*` before merging anything small" since 2026-09-30, and the ~3-minute window has
 * been lost at least four times since: three members that day (one roll-up lost both of its own
 * within ninety seconds of being commented on), #5092 merged eighteen seconds after its roll-up
 * opened, and #5100 merged 1m54s before the roll-up built to carry it. Every session had the rule
 * loaded. The rule names its own reason — *a comment on a PR is not enforcement* — so the owner
 * asked for a guard instead (2026-10-02: "make rollup-prs guard its members instead of commenting
 * on them").
 *
 * What this pins, in the order the failures happened:
 *
 *  1. THE DECISION. A member is held; a non-member is not; the roll-up ITSELF is never refused,
 *     because merging it is the whole point.
 *  2. THE SOURCE OF TRUTH. Membership is read from the roll-up's own body through the SAME
 *     `rollupMembers` the builder writes, so the guard cannot drift from the thing it guards. A
 *     second registry — a label, a draft flip, a file — is the failure mode this avoids.
 *  3. THE FAIL DIRECTION. An unreadable body warns and ALLOWS. That is the opposite of
 *     `overlappingRollup`'s stance on the same input and the asymmetry is the point: refusing to
 *     build delays one roll-up, refusing to merge would block the whole repository.
 *  4. THE WIRING. `bash-guard.mjs` must actually call it, before C10, and honour the stand-down.
 *
 * Comments are stripped before every source read: this file's prose spells the strings it pins, and
 * a test that matched its own explanation would pin nothing (AGENTS.md §2.1).
 */

const GUARD = ".claude/hooks/bash-guard.mjs";
const flat = (path: string) => stripComments(readFileSync(path, "utf8")).replace(/\s+/g, " ");

/** A roll-up PR body in the exact shape `rollup-prs.mjs --apply` writes it. */
const bodyFor = (members: Array<{ n: number; title: string; files: number }>) =>
  [
    "Rolls up several open pull requests into ONE merge, so the CI bill is paid once instead of 2 times (about 28 billable minutes).",
    "",
    "Each is carried by merging its own head commit, so authorship and history are preserved:",
    "",
    ...members.map((m) => `- #${m.n} — ${m.title} (${m.files} files)`),
    "",
    "Their file sets are disjoint, which is the condition this was built on — two PRs touching one file "
      + "can merge cleanly and still be wrong together, `tests/run-tests.ts` being the standing example.",
  ].join("\n");

export function runRollupMemberGuardTests() {
  // ── 1. The decision ──────────────────────────────────────────────────────────────────────────
  const body = bodyFor([
    { n: 5101, title: "docs(agents): relocate nine hooks' evidence into docs/", files: 4 },
    { n: 5100, title: "fix(rollup): --settle proves a carried path by its own delta", files: 3 },
  ]);
  const rollups = [{ number: 5102, headRefName: "codex/rollup-20261002-0759", members: rollupMembers(body) }];

  assert.deepEqual(rollupMembers(body), [5101, 5100], "the body's member list must parse to exactly its two members");

  for (const member of [5101, 5100]) {
    const held = rollupHolding({ merging: member, rollups });
    assert.ok(held, `#${member} is a member of #5102 and must be held`);
    assert.equal(held?.number, 5102);
    assert.equal(held?.headRefName, "codex/rollup-20261002-0759", "the refusal must name the roll-up's branch");
  }

  assert.equal(rollupHolding({ merging: 5099, rollups }), null, "a PR no roll-up carries merges freely");
  // 🔴 The one merge this must NEVER block. A guard whose only refusal is the correct action would
  // be worse than no guard: it would be uninstalled the first time it fired.
  assert.equal(rollupHolding({ merging: 5102, rollups }), null, "the roll-up itself is the thing to merge");
  assert.equal(
    rollupHolding({ merging: 5102, rollups: [{ number: 5102, headRefName: "codex/rollup-x", members: [5102, 5101] }] }),
    null,
    "even a body that names its own number must not make the roll-up refuse itself",
  );

  // Junk in, no refusal out — a merge of the CURRENT branch reaches the hook with no number at all.
  assert.equal(rollupHolding({ merging: Number.NaN, rollups }), null);
  assert.equal(rollupHolding({ merging: 0, rollups }), null);
  assert.equal(rollupHolding({ merging: 5101, rollups: [] }), null, "no open roll-up, nothing to protect");
  assert.equal(rollupHolding({ merging: 5101, rollups: undefined as never }), null);

  // ── 2. One source of truth, and the prose that must not be read as a member ──────────────────
  // The body quotes `tests/run-tests.ts` and can carry a title like "fix(#4123 regression)". A
  // looser `#\d+` sweep over the body would make either one a phantom member and refuse a merge for
  // nothing — which is how a guard earns its own removal.
  const noisy = bodyFor([{ n: 4901, title: "fix(#4123 regression): the one that mattered", files: 2 }]);
  assert.deepEqual(rollupMembers(noisy), [4901], "only the list shape counts — a title's own issue reference is not a member");
  assert.equal(rollupHolding({ merging: 4123, rollups: [{ number: 9, headRefName: "codex/rollup-z", members: rollupMembers(noisy) }] }), null);

  // Only roll-up branches are consulted at all.
  assert.equal(isRollupBranch("codex/rollup-20261002-0759"), true);
  assert.equal(isRollupBranch("codex/landing-speed"), false);

  // ── 3. The fail direction ────────────────────────────────────────────────────────────────────
  const unreadable = [{ number: 77, headRefName: "codex/rollup-handmade", members: rollupMembers("written by hand, no list") }];
  assert.equal(
    rollupHolding({ merging: 5101, rollups: unreadable }),
    null,
    "an unreadable roll-up body must NOT refuse — that would block every merge in the repo while it stays open",
  );
  // `r` is annotated because these modules are untyped `.mjs`: the callback parameter is otherwise
  // implicitly `any`, which `tsc --noEmit` refuses and the local suite cannot see — it runs under
  // `--experimental-strip-types`, which ERASES types rather than checking them.
  assert.deepEqual(
    unreadableRollups(unreadable).map((r: { number: number }) => r.number),
    [77],
    "but it must be reported, so the one case this cannot judge is still visible",
  );
  assert.deepEqual(unreadableRollups(rollups), [], "a readable roll-up is never reported as unreadable");

  // ── 4. The words it refuses with ─────────────────────────────────────────────────────────────
  // The denial has to say what to do instead, or the session's next move is to force it through.
  const denial = rollupMemberDenial({ merging: 5101, rollup: { number: 5102, headRefName: "codex/rollup-20261002-0759" } });
  assert.match(denial, /^C13 /, "every clause names itself first — that is how a refusal is attributed");
  assert.match(denial, /gh pr merge 5102 --squash/, "it must name the merge that replaces this one");
  assert.match(denial, /--settle/, "and how the held PR is closed once the roll-up lands");
  assert.match(denial, /PHX_MERGE_OK=1/, "a guard with no way past it gets deleted instead of used");

  // ── 5. The wiring ────────────────────────────────────────────────────────────────────────────
  const guard = flat(GUARD);
  assert.ok(guard.includes("rollup-member-guard.mjs"), `${GUARD}: C13 must load the shared decision, not re-implement it`);
  assert.ok(guard.includes("rollup-duplicate-guard.mjs"), `${GUARD}: membership must be parsed by the builder's own rollupMembers`);
  assert.ok(
    /rollupHolding\(\{ merging: Number\(prNumber\), rollups \}\)/.test(guard),
    `${GUARD}: the guard must be asked about the PR actually being merged`,
  );
  assert.ok(
    /if \(holding\) deny\(rollupMemberDenial\(/.test(guard),
    `${GUARD}: a held PR must be DENIED — reporting it and continuing is the comment that already failed`,
  );
  // Order matters: C10 would wave through a six-file member, so the membership test cannot sit behind it.
  assert.ok(
    guard.indexOf("rollupHolding(") < guard.indexOf("changedFiles < minFiles"),
    `${GUARD}: C13 must run BEFORE C10's size check — a member is the wrong merge at any size`,
  );
  // It rides inside the same block C10 guards, so the stand-down and the `--help` exemption already
  // cover it; pinned here so a refactor cannot lift it out into an unguarded path.
  assert.ok(
    guard.indexOf("PHX_MERGE_OK") < guard.indexOf("rollupHolding("),
    `${GUARD}: C13 must sit inside the stand-down check, not above it`,
  );
  // The roster is read RAW, not stripped: it is deliberately a comment, and it is the only place a
  // session that has just been denied can find out what C13 is. Stripping comments for the wiring
  // checks above is right (a test must not match the prose explaining itself); stripping them here
  // would assert the roster away.
  const guardRaw = readFileSync(GUARD, "utf8").replace(/\s+/g, " ");
  assert.ok(
    guardRaw.includes("C13 a MERGE of a PR that is a MEMBER of an open roll-up"),
    `${GUARD}: the clause roster at the top is how a session learns what refused it`,
  );
}
