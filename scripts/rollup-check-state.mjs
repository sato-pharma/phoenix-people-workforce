#!/usr/bin/env node
// WHAT A PULL REQUEST'S REQUIRED CHECKS ARE SAYING — and it is THREE answers, not two.
//
// `rollup-prs.mjs` learned in #4886 to hold a PR out of a roll-up when its REQUIRED checks have
// FAILED. That guard is right and stays: a member whose required check is red makes the roll-up red,
// so the owner's single approval can never go green until somebody else's unrelated fix lands, which
// is the exact opposite of "never hand him more than one merge at a time" (AGENTS.md §6).
//
// But it only ever asked "has this terminally failed?", so the third answer — NOTHING HAS FINISHED
// YET — was read as the first. Measured 2026-09-30: `--apply` built roll-up #4896 from #4895 (green)
// and #4894 (required checks still queued). #4894's own checks then failed on four TypeScript errors
// in `src/lib/phoenix-crm/server/list.ts` and two of its tests. The roll-up inherited that red and
// could never merge — and because a roll-up's members must not be merged separately, it held the
// GREEN PR hostage to another session's fix. #4896 was closed, #4895 merged alone, and the roll-up
// cost one wasted CI run to achieve nothing.
//
// TREATING PENDING AS RED IS NOT THE FIX. A roll-up is usually built minutes after a PR is opened,
// when every required check is `QUEUED` or `IN_PROGRESS` — the normal case, and the one the tool is
// most wanted for. Refusing it would make the script propose nothing exactly when it is needed, so
// pending must keep its own classification: still a candidate, not yet safe to BUILD from. That is
// why this module answers with two lists rather than a boolean, and why `--apply` WAITS on the
// pending list instead of judging it.
//
// The classification stays where it was; only the build gains a wait. So a pending PR still reads
// ROLL UP in the report, and `--apply` is what refuses to commit to it early.
'use strict';

/**
 * A conclusion that will not change on its own and blocks the merge.
 *
 * `FAILURE`, `TIMED_OUT`, `CANCELLED` and `ERROR` are the four terminal states a required check lands
 * in. `STARTUP_FAILURE` is the same class — the workflow never began, so nothing is coming.
 */
export const TERMINAL_FAILURE = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR', 'STARTUP_FAILURE']);

/**
 * A conclusion that will not change on its own and does NOT block the merge.
 *
 * `NEUTRAL` and `SKIPPED` sit here rather than with the failures because neither is a red check and
 * neither is going to become one — waiting on either would be waiting for ever. Anything in NEITHER
 * set is PENDING, which deliberately includes `ACTION_REQUIRED` and an empty state: an answer this
 * module does not recognise must never read as finished-and-fine.
 */
export const TERMINAL_SUCCESS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/**
 * The REQUIRED checks of one PR, split into the ones that have terminally FAILED and the ones that
 * have not finished — each named with its state, so a report never has to say "something is red".
 *
 * 🔴 THE REQUIRED LIST IS NEVER HARDCODED, HERE OR ANYWHERE. It has rotted five times
 * (4 -> 5 -> 6 -> 4 -> 2) and three names stopped being check NAMES on 2026-09-27 (AGENTS.md §2,
 * §7), so a constant would disqualify PRs on a name nothing reports any more — or, the quiet
 * direction, miss the one name that actually gates. The caller reads
 * `branches/main/protection/required_status_checks` live and passes the Set in.
 *
 * `required === null` means the gate could NOT be read. Then every check counts, red or unfinished, AND
 * nothing counts as CONFIRMED: a PR with no objection to raise reads as unproven rather than as green,
 * because the safe direction is a PR that merges on its own — a false SEPARATE costs one extra CI run
 * and is visible in the report, while a false roll-up is the incident this exists to prevent. That last
 * half was missing until #4937 was built over a member whose checks were still running (see below), and
 * `requiredGateUsable` is what stops `--apply` reaching this state at all.
 *
 * A required name that appears NOWHERE in the rollup is PENDING, not absent. A PR opened seconds ago
 * reports an empty array, and reading that as "nothing is red, build it" is the 2026-09-30 failure in
 * its purest form — the build would commit to a PR before a single check had even been queued.
 *
 * Handles both shapes `statusCheckRollup` returns: a CheckRun (`name`, `status` + `conclusion`) and a
 * StatusContext (`context` + `state`).
 *
 * @param {ReadonlyArray<Record<string, unknown>> | null | undefined} statusCheckRollup
 * @param {Set<string> | null} required
 * @returns {{ red: string[], pending: string[] }}
 */
export function requiredCheckState(statusCheckRollup, required) {
  const red = [];
  const pending = [];
  const seen = new Set();
  // Required contexts SEEN to finish in a non-blocking state. Counted rather than inferred, because
  // "nothing objected" and "every required check passed" are two different facts and the gap between
  // them is this function's one historical bug (see below).
  const confirmed = new Set();
  for (const entry of statusCheckRollup ?? []) {
    const name = entry?.name ?? entry?.context ?? '';
    // `||`, not `??`. A CheckRun that has not concluded carries `conclusion: ""` — verified against the
    // live API on 2026-09-30, where an IN_PROGRESS job reads `{conclusion: "", status: "IN_PROGRESS"}`,
    // not `conclusion: null`. An empty string is not nullish, so `??` stopped there and every unfinished
    // required check was labelled `not started`, including one that had been running for three minutes.
    // The verdict was right either way (neither `""` nor `IN_PROGRESS` is a terminal success), but the
    // wait's own progress line is the only place a session sees what it is waiting for.
    const state = String(entry?.conclusion || entry?.state || entry?.status || '').toUpperCase();
    if (required !== null && !required.has(name)) continue;
    seen.add(name);
    const label = name || 'an unnamed check';
    if (TERMINAL_FAILURE.has(state)) red.push(`${label} (${state.toLowerCase()})`);
    else if (!TERMINAL_SUCCESS.has(state)) pending.push(`${label} (${state ? state.toLowerCase() : 'not started'})`);
    else if (required !== null) confirmed.add(name);
  }
  if (required !== null) {
    for (const name of required) if (!seen.has(name)) pending.push(`${name} (not reported yet)`);
  }
  if (red.length === 0 && pending.length === 0 && confirmed.size === 0) {
    // 🔴 "NOTHING OBJECTED" IS NOT "EVERY REQUIRED CHECK PASSED", AND ZERO CONFIRMED IS THE ULTIMATE
    // SUBSET OF ALL OF THEM.
    //
    // The clause above enumerates the required names and calls the ones nobody reported PENDING, which
    // is what makes a fresh PR unbuildable. It can only enumerate a list it HAS. With no usable list —
    // `null` because protection could not be read, or an EMPTY Set because protection answered with an
    // empty `contexts` array — nothing is enumerated and the only thing left judging the PR is the loop
    // over the checks that EXIST. A PR seconds old has none; a PR whose only reported check is
    // `mobile (skipped)` has none that gates. Both then answer two empty lists, which every caller
    // reads as "finished, and nothing is red".
    //
    // Measured 2026-09-30 against the code as it then stood: roll-up #4937 was opened at 14:49:58Z
    // carrying #4936, whose `validate` and `checks` did not finish until 14:51:14Z and 14:51:48Z and
    // had only started at 14:48:13Z. Two empty lists is the one reading that could have carried it.
    //
    // The EMPTY-Set half is the quieter one, because it arrives on a SUCCESSFUL API call: the classic
    // `required_status_checks.contexts` array is deprecated in favour of `checks`, and a rule moved to a
    // ruleset leaves it empty — at which point every PR in the repository reads as finished green at
    // once. `requiredGateUsable` below refuses a build on either, and this counts the gate itself so a
    // single member can never be promoted even if a build is reached some other way.
    pending.push(required === null || required.size === 0
      ? 'no required check could be confirmed — the required-check list is unusable, so nothing here is '
        + 'known to be a check that gates'
      : 'no required check could be confirmed green');
  }
  return { red, pending };
}

/**
 * Whether the required list is something a BUILD may be judged against at all.
 *
 * Reporting can proceed on an unread gate — it judges on every failed check and says so — but a roll-up
 * cannot: proving a member green means naming the contexts that gate `main` and seeing every one of them
 * succeed. Without that list there is nothing to see every one of, so `--apply` refuses rather than
 * building on an absence.
 *
 * An EMPTY list is refused for the same reason and is the quieter of the two. `main` is protected with
 * required checks, so zero contexts means the SHAPE changed, not that nothing gates: the classic
 * `required_status_checks.contexts` array is deprecated in favour of `checks`, and a rule moved to a
 * ruleset leaves it empty. An empty Set makes `requiredCheckState` skip every entry and enumerate
 * nothing, so every PR in the repository would read as finished green at once — a total fail-open
 * wearing a successful API call.
 *
 * @param {Set<string> | null} required
 * @returns {{ usable: true } | { usable: false, why: string }}
 */
export function requiredGateUsable(required) {
  if (required === null) {
    return {
      usable: false,
      why: 'the required-check list could not be read, so no member can be PROVEN green — and a member '
        + 'that nothing objected to is not the same thing',
    };
  }
  if (required.size === 0) {
    return {
      usable: false,
      why: 'branch protection returned an EMPTY required list. `main` is protected with required checks, '
        + 'so zero means the shape changed (the `contexts` array is deprecated in favour of `checks`, and '
        + 'a ruleset leaves it empty) — judged against an empty list every PR reads as green at once',
    };
  }
  return { usable: true };
}

/**
 * Poll the members whose required checks have not finished, until they have or the wait runs out.
 *
 * THE LOOP LIVES HERE, not in the script, because everything that can go wrong in it is a decision
 * rather than a call: promoting a member on a FAILED read, re-reading one that has already gone red,
 * running past the deadline, or looping for ever when nothing is coming. Those are testable offline
 * and a live `--apply` is not — it pushes a branch and opens a PR, so there is no way to rehearse it.
 * Everything that touches the network or the clock is injected.
 *
 * A failed read is NOT news: `reread` answering `null` keeps the previous reading, so a flaky call can
 * never promote a pending member to green. That direction matters more than it looks — the whole point
 * of the wait is that a member is carried only once its checks have been SEEN to pass.
 *
 * 🔴 AND A MEMBER CAN CHANGE UNDER THE WAIT, WHICH IS THE SAME BUG ONE STEP LATER. The checks are
 * re-read live while the commit to be merged was captured before the wait, so a member whose branch is
 * pushed meanwhile hands back GREEN CHECKS FOR A DIFFERENT COMMIT — and the roll-up then carries a
 * commit nothing verified, which is exactly what waiting was supposed to stop. It is not a rare race:
 * on 2026-09-30 #4907's head moved twice inside fifteen minutes while its checks ran. Its file set was
 * measured on the old head too, so a new push can also break the disjointness the group was chosen for.
 * `reread` therefore answers `{ stale: '<why>' }` when the PR is no longer the thing we measured — a
 * moved head, or a PR that is no longer open — and a stale member stops being waited on and is never
 * built from. It is not refused, only out of date: the next run measures it afresh.
 *
 * @param {object} input
 * @param {ReadonlyArray<{ number: number, red?: ReadonlyArray<string>, pending?: ReadonlyArray<string> }>} input.members
 * @param {number} input.timeoutMs how long to keep waiting, from the first call to `now()`.
 * @param {number} input.pollMs how long to sleep between reads.
 * @param {(number: number) => ({ red: string[], pending: string[] } | { stale: string } | null)} input.reread
 *   one member's checks, read again; `{ stale }` when the PR is no longer what was measured, and `null`
 *   when the read failed.
 * @param {(ms: number) => void} input.sleep
 * @param {() => number} [input.now]
 * @param {(progress: { left: Array<{ number: number, pending: string[] }>, msLeft: number }) => void} [input.onPoll]
 * @returns {Array<{ number: number, red: string[], pending: string[], stale: string | null }>} the final
 *   reading per member.
 */
export function waitForRequiredChecks({ members, timeoutMs, pollMs, reread, sleep, now = () => Date.now(), onPoll }) {
  const state = (members ?? []).map((m) => ({
    number: m.number,
    red: [...(m.red ?? [])],
    pending: [...(m.pending ?? [])],
    stale: null,
  }));
  const deadline = now() + timeoutMs;
  // A member that has already gone red, or gone stale, is never waited on again: nothing it reports
  // later can make it buildable, and re-reading it would only slow the wait for the ones that can
  // still settle.
  const stillRunning = () => state.filter((m) => m.red.length === 0 && m.stale === null && m.pending.length > 0);

  while (stillRunning().length > 0 && now() < deadline) {
    sleep(pollMs);
    for (const member of stillRunning()) {
      const fresh = reread(member.number);
      if (!fresh) continue;
      if (fresh.stale) {
        member.stale = fresh.stale;
        continue;
      }
      // An answer that is neither stale nor two lists is NO NEWS, exactly like a failed read. It must
      // never be read as a verdict: the empty-list reading of a malformed answer says "finished, and
      // nothing is red", which is the one direction that would carry an unverified member.
      if (!Array.isArray(fresh.red) || !Array.isArray(fresh.pending)) continue;
      member.red = fresh.red;
      member.pending = fresh.pending;
    }
    if (onPoll) {
      onPoll({
        left: stillRunning().map((m) => ({ number: m.number, pending: [...m.pending] })),
        msLeft: Math.max(0, deadline - now()),
      });
    }
  }
  return state;
}

/**
 * Which members `--apply` may actually build the roll-up branch from, once the wait has stopped.
 *
 * Three outcomes and each is a different sentence to the reader:
 *
 *   * every required check finished green -> CARRY it;
 *   * a required check failed, whether before the wait or during it -> LEAVE IT OUT. This is #4886's
 *     rule, now also covering a PR that was green-looking only because nothing had run yet;
 *   * a required check never finished inside the wait -> LEAVE IT OUT too, and say that it is a
 *     TIMEOUT rather than a failure. The PR is fine; we simply will not bet a roll-up on a check we
 *     have not seen, and it rolls up on the next run for free;
 *   * the PR is no longer what was measured — its head moved, or it stopped being open -> LEAVE IT
 *     OUT, and say STALE. This one outranks the other three, because a green reading taken after the
 *     head moved describes a commit the build would not merge; the sha, the checks and the file set
 *     have to be the same PR or they are not evidence about anything.
 *
 * Dropping members is always safe: the group was chosen for DISJOINT file sets, and every subset of a
 * disjoint set is disjoint. What is not safe is carrying one whose verdict we never saw.
 *
 * @param {ReadonlyArray<{ number: number, red?: ReadonlyArray<string>, pending?: ReadonlyArray<string>, stale?: string | null }>} members
 * @returns {{ carry: number[], dropped: Array<{ number: number, kind: 'red' | 'pending' | 'stale', why: string }> }}
 */
export function membersReadyToBuild(members) {
  const carry = [];
  const dropped = [];
  for (const member of members ?? []) {
    const red = member?.red ?? [];
    const pending = member?.pending ?? [];
    if (member?.stale) {
      dropped.push({
        number: member.number,
        kind: 'stale',
        why: `${member.stale} — the checks we waited for describe a different commit, so it is not `
          + 'refused, only out of date, and the next run measures it afresh',
      });
    } else if (red.length > 0) {
      dropped.push({
        number: member.number,
        kind: 'red',
        why: `required check(s) failing: ${red.join(', ')} — a roll-up carrying this could never go green`,
      });
    } else if (pending.length > 0) {
      dropped.push({
        number: member.number,
        kind: 'pending',
        why: `required check(s) had not finished when the wait ran out: ${pending.join(', ')} — it is not `
          + 'refused, only unproven, and it rolls up on the next run',
      });
    } else {
      carry.push(member.number);
    }
  }
  return { carry, dropped };
}
