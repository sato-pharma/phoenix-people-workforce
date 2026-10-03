// Is this PR a MEMBER of an open roll-up — i.e. is merging it the thing that destroys the roll-up?
//
// WHY THIS EXISTS, AND WHY A COMMENT WAS NEVER GOING TO DO IT. `rollup-prs.mjs --apply` builds one
// branch carrying several small PRs so the owner approves ONE merge instead of several, and a merge
// costs two full CI runs whatever its size. The moment a member is merged on its own, the roll-up
// stops replacing anything: its files become byte-identical on `main` (the `carried` verdict) and it
// can only be closed, so the saving is gone and the member has paid its own `main` run anyway.
//
// 🔴 THE WINDOW IS ABOUT THREE MINUTES AND IT HAS BEEN LOST AT LEAST FOUR TIMES. AGENTS.md records
// three members lost on 2026-09-30 — one roll-up opened at 13:16 lost both members by 13:18:55, the
// first ninety seconds after being commented on, and #4814 went the same way that morning. It
// happened twice more on 2026-10-01/02: #5092 was merged eighteen seconds after a roll-up carrying
// it was opened, and #5100 merged one minute fifty-four seconds BEFORE the roll-up built to carry
// it. Different sessions, different days, the rule written down and loaded every time.
//
// The documented reason is in the rule itself — *"a comment on a PR is not enforcement"*. Every
// guard so far has been prose that the session pressing merge never reads, because it is reading the
// PR it was told to merge, not the PR that quietly became a member of something else. So this is
// mechanical: `bash-guard.mjs` clause C13 calls it before every `gh pr merge`.
//
// NOTHING NEW HAS TO BE MARKED. The roll-up's own PR body already lists its members in a fixed
// machine-written shape, and `rollupMembers()` already parses exactly that shape. A separate label,
// draft flip or registry file would be a second source of truth that can drift out of step with the
// body; this one cannot, because it IS the body.

/**
 * The open roll-up that carries `merging`, or `null` when none does.
 *
 * Pure on purpose: reading PR bodies is an API call, so the caller fetches and this decides. That is
 * the same split `overlappingRollup` uses, and it is what lets the whole decision table be tested
 * without a network.
 *
 * @param merging  The PR number about to be merged.
 * @param rollups  Open roll-up PRs, each `{ number, headRefName, members }` — the caller filters to
 *                 the roll-up branch prefix and resolves `members` with `rollupMembers(body)`.
 * @returns `{ number, headRefName }` of the roll-up holding it, or `null`.
 */
export function rollupHolding({ merging, rollups }) {
  const target = Number(merging);
  if (!Number.isInteger(target) || target <= 0) return null;

  for (const rollup of rollups ?? []) {
    // 🔴 MERGING THE ROLL-UP ITSELF IS THE WHOLE POINT — never refuse that. It cannot be a member of
    // itself (`--apply` refuses to nest roll-ups), but a body naming its own number would otherwise
    // make the one correct merge the only one this blocks.
    if (Number(rollup.number) === target) return null;
  }

  for (const rollup of rollups ?? []) {
    const members = (rollup.members ?? []).map(Number).filter((n) => Number.isInteger(n));
    if (members.includes(target)) {
      return { number: Number(rollup.number), headRefName: rollup.headRefName ?? null };
    }
  }
  return null;
}

/**
 * Open roll-ups whose member list could not be read at all.
 *
 * 🔴 REPORTED, NOT REFUSED — and that is a deliberate difference from `overlappingRollup`, which
 * refuses to BUILD over an unreadable body. The costs are not symmetric. Refusing to build wrongly
 * delays one roll-up; refusing to MERGE wrongly blocks every merge in the repository for as long as
 * that PR stays open, and a roll-up body is machine-written, so an unparseable one means a human
 * opened a `codex/rollup-*` branch by hand. Blocking the whole repo on that costs far more than the
 * one roll-up it might protect, so C13 warns and allows. The stand-down is still there for the
 * opposite case.
 */
export function unreadableRollups(rollups) {
  return (rollups ?? [])
    .filter((r) => ((r.members ?? []).filter((n) => Number.isInteger(Number(n))).length === 0))
    .map((r) => ({ number: Number(r.number), headRefName: r.headRefName ?? null }));
}

/**
 * Members whose head has MOVED since the roll-up carried them.
 *
 * 🔴 THE BUILD CHECKS THE SHA AND THEN STOPS LOOKING, AND THE MERGE IS MINUTES LATER. `--apply`
 * re-reads each member's head immediately before merging it into the branch and skips one that
 * moved, so the branch is always built from commits whose checks and file sets were measured. But
 * the roll-up then waits for the owner's approval, and nothing looks again. Measured 2026-10-02:
 * #5191 was built at 20:54:51Z from #5188's head `4df18d572`; its author pushed the real fix at
 * 20:58:41Z; the roll-up merged at 21:12:41Z and shipped the superseded commit. The member was left
 * CONFLICTING against the squash of its own first commit — which earns it NO CI run at all, so it
 * could not go green on its own and needed a hand-built merge to recover.
 *
 * Pure, for the same reason as {@link rollupHolding}: the caller does the API reads and this
 * decides, so the whole table is testable without a network.
 *
 * @param recorded  `[{ number, sha }]` from {@link rollupMemberHeads} — what the body says was carried.
 * @param live      `[{ number, headRefOid }]` read back now, one row per member.
 * @returns `{ moved, unrecorded, unread }`. Only `moved` is a refusal. `unrecorded` is a body with
 *          no sha on that line (a roll-up built before this shipped) and `unread` is a member the
 *          caller could not read — both UNKNOWN, and a caller must report them rather than refuse,
 *          because an unknown that blocks would block every merge on this guard's own blind spot.
 */
export function staleRollupMembers({ recorded, live }) {
  const seen = new Map();
  for (const row of live ?? []) {
    const number = Number(row?.number);
    if (Number.isInteger(number)) seen.set(number, row);
  }

  const moved = [];
  const unrecorded = [];
  const unread = [];
  for (const entry of recorded ?? []) {
    const number = Number(entry?.number);
    if (!Number.isInteger(number)) continue;
    const row = seen.get(number);
    const head = row?.headRefOid == null ? '' : String(row.headRefOid);
    if (head === '') {
      unread.push(number);
      continue;
    }
    if (entry.sha == null) {
      unrecorded.push(number);
      continue;
    }
    if (head !== String(entry.sha)) moved.push({ number, carried: String(entry.sha), now: head });
  }
  return { moved, unrecorded, unread };
}

/** What C13 prints when a roll-up's member has moved. Kept beside the decision it explains. */
export function rollupStaleDenial({ rollup, moved }) {
  const lines = moved
    .map((m) => `  #${m.number}: carried ${m.carried.slice(0, 9)}, now ${m.now.slice(0, 9)}`)
    .join('\n');
  return (
    `C13 — roll-up #${rollup.number}${rollup.headRefName ? ` (${rollup.headRefName})` : ''} carries a ` +
    'commit its author has already replaced:\n\n' +
    `${lines}\n\n` +
    'Merging it now ships the SUPERSEDED commit and leaves that member conflicting against the ' +
    'squash of its own earlier work — and a conflicted PR gets NO CI run at all, so it cannot go ' +
    'green again on its own.\n\n' +
    '🔴 THIS IS MEASURED, NOT HYPOTHETICAL. On 2026-10-02 roll-up #5191 was built at 20:54:51Z from ' +
    "#5188's head 4df18d572. Its own session pushed the real fix four minutes later — \"my own fix " +
    'made every click a no-op — pass functions, not strings" — and the roll-up merged at 21:12:41Z ' +
    'carrying the broken one. The member then sat CONFLICTING and had to be rebuilt by hand. ' +
    "`--apply` re-reads each head before it merges, but it stops looking once the branch is pushed, " +
    'and the approval came eighteen minutes later.\n\n' +
    'REBUILD IT instead — the members are still open, so nothing is lost:\n' +
    `  gh pr close ${rollup.number}\n  node scripts/rollup-prs.mjs --apply\n\n` +
    'To see exactly what moved before deciding:\n  node scripts/rollup-prs.mjs --verify-heads\n\n' +
    'If you mean to ship the older commit anyway, stand this down for one command:\n' +
    '  PHX_MERGE_OK=1 <cmd>   ($env:PHX_MERGE_OK=1; <cmd> in PowerShell)'
  );
}

/** What C13 prints when it refuses. Kept here so the test reads the real words, not a paraphrase. */
export function rollupMemberDenial({ merging, rollup }) {
  return (
    `C13 — PR #${merging} is a MEMBER of the open roll-up #${rollup.number}` +
    `${rollup.headRefName ? ` (${rollup.headRefName})` : ''}, which exists to replace this merge.\n\n` +
    'Merging it on its own destroys the roll-up: its files become byte-identical on `main` (the ' +
    '`carried` verdict), so it can no longer replace anything and can only be closed — and this PR ' +
    'has paid its own `main` run anyway. That is two full CI runs where the roll-up would have ' +
    'bought one, about 28 billable minutes.\n\n' +
    '🔴 THIS IS NOT A HYPOTHETICAL. The window is about three minutes and it has been lost at least ' +
    'four times: three members on 2026-09-30 (one roll-up lost both of its own inside ninety seconds ' +
    'of being commented on), #5092 merged eighteen seconds after its roll-up opened, and #5100 ' +
    'merged a minute and fifty-four seconds before the roll-up built to carry it. Every one of those ' +
    'sessions had the rule loaded. A comment on a PR is not enforcement, which is why this is a ' +
    'clause and not a note.\n\n' +
    `MERGE THE ROLL-UP INSTEAD — that is the one approval replacing this one:\n  gh pr merge ${rollup.number} --squash\n\n` +
    'Once it lands, this PR is CARRIED, and:\n  node scripts/rollup-prs.mjs --settle\n' +
    'closes it after proving every file byte-identical on `main`. Never merge it to "catch up".\n\n' +
    'If the roll-up is wrong — it is red, it is stale, or the owner asked for THIS PR specifically — ' +
    'close the roll-up first, or stand this down for one command:\n' +
    '  PHX_MERGE_OK=1 <cmd>   ($env:PHX_MERGE_OK=1; <cmd> in PowerShell)'
  );
}
