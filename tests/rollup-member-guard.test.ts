import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { rollupMemberHeads, rollupMembers, isRollupBranch } from "../scripts/rollup-duplicate-guard.mjs";
import {
  rollupHolding,
  rollupMemberDenial,
  rollupStaleDenial,
  staleRollupMembers,
  unreadableRollups,
} from "../scripts/rollup-member-guard.mjs";
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

/**
 * A roll-up PR body in the exact shape `rollup-prs.mjs --apply` writes it.
 *
 * `sha` is optional on purpose: a body WITHOUT one is a roll-up built before the carried sha was
 * recorded, and those must read UNKNOWN rather than stale — otherwise shipping this guard would
 * have blocked every roll-up already open at the time.
 */
const bodyFor = (members: Array<{ n: number; title: string; files: number; sha?: string }>) =>
  [
    "Rolls up several open pull requests into ONE merge, so the CI bill is paid once instead of 2 times (about 28 billable minutes).",
    "",
    "Each is carried by merging its own head commit, so authorship and history are preserved:",
    "",
    ...members.map((m) => `- #${m.n} — ${m.title} (${m.files} files)${m.sha ? ` @ ${m.sha}` : ""}`),
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

  // ── 6. The carried sha, and the gap between BUILDING and MERGING ──────────────────────────────
  //
  // 🔴 `--apply` ALREADY RE-READS EVERY HEAD AND THEN STOPS LOOKING. Its build loop takes a last
  // look at each member's sha and skips one that moved, so the branch is always made of commits
  // whose checks and file sets were measured. The approval, though, arrives minutes later and
  // nothing looks again. Measured 2026-10-02: #5191 was built at 20:54:51Z from #5188's head
  // 4df18d572; #5188's own session pushed f93c220e8 at 20:58:41Z — "my own fix made every click a
  // no-op — pass functions, not strings" — and the roll-up merged at 21:12:41Z carrying the commit
  // its author had already replaced. #5188 was then left CONFLICTING against the squash of its own
  // first commit, and a conflicted PR gets NO CI run at all, so it could not go green again on its
  // own and had to be rebuilt by hand. Eighteen minutes of gap, one shipped non-fix.
  const CARRIED = "4df18d572d484e5902d0f1d1f276b4af16364e68";
  const PUSHED_SINCE = "f93c220e8024d4bc2aca660dd990eef94fa0cd8a";
  const UNMOVED = "a".repeat(40);
  const staleBody = bodyFor([
    { n: 5188, title: "fix(new-hire-mailbox): typing into a console field must clear it first", files: 3, sha: CARRIED },
    { n: 5189, title: "docs(traps): git grep's rev form is the one count that does not lie", files: 2, sha: UNMOVED },
  ]);

  // Recording the sha must not disturb the member list C13's first clause is built on.
  assert.deepEqual(rollupMembers(staleBody), [5188, 5189], "recording a carried sha must not change how members parse");
  assert.deepEqual(
    rollupMemberHeads(staleBody).map((m: { number: number; sha: string | null }) => [m.number, m.sha]),
    [[5188, CARRIED], [5189, UNMOVED]],
    "each member line must yield the commit it was carried at",
  );

  // The 2026-10-02 failure itself: one member pushed since the build, one untouched.
  const verdict = staleRollupMembers({
    recorded: rollupMemberHeads(staleBody),
    live: [{ number: 5188, headRefOid: PUSHED_SINCE }, { number: 5189, headRefOid: UNMOVED }],
  });
  assert.deepEqual(
    verdict.moved.map((m: { number: number }) => m.number),
    [5188],
    "the member whose head moved after the build must be the one reported",
  );
  assert.equal(verdict.moved[0].carried, CARRIED, "the refusal has to say which commit is being shipped");
  assert.equal(verdict.moved[0].now, PUSHED_SINCE, "and which one supersedes it");
  assert.deepEqual(verdict.unrecorded, [], "both members recorded a sha");
  assert.deepEqual(verdict.unread, [], "and both heads were readable");

  assert.deepEqual(
    staleRollupMembers({
      recorded: rollupMemberHeads(staleBody),
      live: [{ number: 5188, headRefOid: CARRIED }, { number: 5189, headRefOid: UNMOVED }],
    }).moved,
    [],
    "a roll-up whose members have not moved must merge freely — this guard must not block the common case",
  );

  // 🔴 THE TWO FAIL-OPEN SHAPES. Either one reading as "moved" would have blocked every roll-up
  // open on the day this shipped, and every merge whose member list runs past the 50-PR window.
  const oldBody = bodyFor([{ n: 4901, title: "fix(x): built before the carried sha was recorded", files: 2 }]);
  const older = staleRollupMembers({
    recorded: rollupMemberHeads(oldBody),
    live: [{ number: 4901, headRefOid: PUSHED_SINCE }],
  });
  assert.deepEqual(older.moved, [], "a body recording no sha must never read as moved");
  assert.deepEqual(older.unrecorded, [4901], "it is UNKNOWN, and must be reported as such");

  const blind = staleRollupMembers({
    recorded: rollupMemberHeads(staleBody),
    live: [{ number: 5188, headRefOid: null }],
  });
  assert.deepEqual(blind.moved, [], "a head that could not be read must never read as moved");
  assert.deepEqual(blind.unread, [5188, 5189], "an unread member and a missing one are both reported");

  assert.deepEqual(staleRollupMembers({ recorded: undefined as never, live: undefined as never }).moved, []);

  // The words it refuses with: a refusal that does not say what to do instead gets forced through.
  const stale = rollupStaleDenial({
    rollup: { number: 5191, headRefName: "codex/rollup-20261002-2054" },
    moved: verdict.moved,
  });
  assert.match(stale, /^C13 /, "every clause names itself first");
  assert.match(stale, /gh pr close 5191/, "rebuilding is the way out, not merging it anyway");
  assert.match(stale, /--verify-heads/, "and it must name the read that shows exactly what moved");
  assert.match(stale, /PHX_MERGE_OK=1/, "a guard with no way past it gets deleted instead of used");
  assert.ok(
    stale.includes("4df18d57") && stale.includes("f93c220e8"),
    "the refusal must name both shas — a session cannot judge 'stale' without them",
  );

  // ── 7. The wiring for the sha: the builder RECORDS it, C13 COMPARES it ───────────────────────
  const builder = flat("scripts/rollup-prs.mjs");
  assert.ok(
    builder.includes("files) @ ${p.headRefOid}"),
    "scripts/rollup-prs.mjs: the body must record the sha each member was carried at — with nothing recorded there is nothing to compare at merge time",
  );
  assert.ok(builder.includes("--verify-heads"), "scripts/rollup-prs.mjs: the read-only check must exist to be recommended");
  assert.ok(
    builder.includes("staleRollupMembers("),
    "scripts/rollup-prs.mjs: --verify-heads must use the same decision C13 does, not a second copy of it",
  );
  assert.ok(
    guard.includes("staleRollupMembers("),
    `${GUARD}: C13 must actually compare the carried shas — recording them and never reading them back is the comment that already failed`,
  );
  assert.ok(
    /deny\(rollupStaleDenial\(/.test(guard),
    `${GUARD}: a stale roll-up must be DENIED, not merely reported`,
  );
  assert.ok(
    guard.includes("number,headRefName,headRefOid,body"),
    `${GUARD}: the heads must come from the same single PR listing the member list does, so both answers describe one snapshot`,
  );
}
