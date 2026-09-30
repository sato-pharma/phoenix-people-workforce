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
 * Whether the required-check list can be judged against at all.
 *
 * Two unusable shapes, and BOTH answer green today if nothing else is wrong. `null` is an unreadable
 * gate; an EMPTY Set is worse, because it arrives on a successful read — the classic
 * `required_status_checks.contexts` array is deprecated, and a rule moved to a ruleset leaves it empty.
 * `--apply` refuses the whole run on either, rather than discovering it one member at a time.
 *
 * @param {Set<string> | null} required
 * @returns {{ usable: boolean, why: string }}
 */
export function requiredGateUsable(required) {
  if (required === null) {
    return { usable: false, why: 'branch protection could not be read, so no check can be confirmed as the gate' };
  }
  if (required.size === 0) {
    return {
      usable: false,
      why: 'branch protection named NO required checks — the classic contexts array is empty, which is what '
        + 'a rule moved to a ruleset looks like, so every PR would read green at once',
    };
  }
  return { usable: true, why: `${required.size} required check(s): ${[...required].join(', ')}` };
}

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
 * `required === null` means the gate could NOT be read. Then every check counts, red or unfinished,
 * because the safe direction is a PR that merges on its own: a false SEPARATE costs one extra CI run
 * and is visible in the report, while a false roll-up is the incident this exists to prevent.
 *
 * A required name that appears NOWHERE in the rollup is PENDING, not absent. A PR opened seconds ago
 * reports an empty array, and reading that as "nothing is red, build it" is the 2026-09-30 failure in
 * its purest form — the build would commit to a PR before a single check had even been queued.
 *
 * 🔴 AND A CHECK THAT RAN BEFORE THE HEAD COMMIT EXISTED IS NOT THIS COMMIT'S CHECK. `statusCheckRollup`
 * is the rollup of the PR's latest commit, but right after a push it can still carry the PREVIOUS
 * commit's runs — green ones — so a member reads finished-and-green while its real checks have not
 * started. That is the one account left standing for roll-up #4937, after a peer session ruled out both
 * of the causes we each proposed: its script was byte-identical to `main` including the stale-sha guard,
 * and #4936's checks had already started, so neither an old copy nor a null rollup explains it. The
 * stale-SHA guard cannot see this one either, because the head never moved — only the checks were old.
 *
 * So when `headCommittedAt` is given, any required check whose `startedAt` predates it is PENDING: its
 * verdict belongs to a commit the build would not merge. An entry with no `startedAt` is also pending —
 * unjudgeable is not the same as fine. Both directions only ever wait longer, never build sooner.
 *
 * Handles both shapes `statusCheckRollup` returns: a CheckRun (`name`, `status` + `conclusion`) and a
 * StatusContext (`context` + `state`).
 *
 * @param {ReadonlyArray<Record<string, unknown>> | null | undefined} statusCheckRollup
 * @param {Set<string> | null} required
 * @param {string | null} [headCommittedAt] ISO date of the PR's head commit. Omitted, the staleness
 *   test is skipped, which is what every existing caller and fixture gets.
 * @returns {{ red: string[], pending: string[] }}
 */
export function requiredCheckState(statusCheckRollup, required, headCommittedAt = null) {
  const red = [];
  const pending = [];
  const seen = new Set();
  // Required names seen to FINISH non-blocking. Only a gate that named them can confirm anything, so
  // this stays 0 for an unreadable or empty gate — see the clause at the end.
  let confirmed = 0;
  const headAt = headCommittedAt ? Date.parse(headCommittedAt) : NaN;
  for (const entry of statusCheckRollup ?? []) {
    const name = entry?.name ?? entry?.context ?? '';
    // `conclusion` comes back as an EMPTY STRING for a running check, not as null, and `??` does not
    // skip an empty string — so reading it first printed a running check as "not started". Take the
    // first NON-EMPTY of the three instead, or the report misdescribes the very state it is waiting on.
    const state = String(
      [entry?.conclusion, entry?.state, entry?.status].find((v) => v !== null && v !== undefined && v !== '') ?? '',
    ).toUpperCase();
    if (required !== null && !required.has(name)) continue;
    seen.add(name);
    const label = name || 'an unnamed check';
    // 🔴 THE STALENESS TEST ONLY APPLIES WHERE THE SHAPE CAN ANSWER IT. A StatusContext — the legacy
    // commit-status shape — reports `state` and `context` and has no `startedAt` at all, so holding it to
    // a start time would make it pend FOR EVER: it can never gain one, the wait always times out, and
    // that member could never be built from again. Pointed out by a peer session reviewing this change,
    // and measured: two green StatusContexts came back as two "no start time" pending entries.
    //
    // A CheckRun always carries `startedAt` here, so a CheckRun missing one stays pending — that is a
    // genuine anomaly, not a shape we simply cannot time. This repo's required checks are Actions jobs,
    // i.e. CheckRuns, so nothing real loses the protection.
    const isStatusContext = entry?.context !== undefined && entry?.name === undefined;
    if (Number.isFinite(headAt) && !isStatusContext) {
      const startedAt = entry?.startedAt ? Date.parse(String(entry.startedAt)) : NaN;
      if (!Number.isFinite(startedAt)) {
        pending.push(`${label} (no start time, so it cannot be tied to this commit)`);
        continue;
      }
      if (startedAt < headAt) {
        pending.push(`${label} (ran before this commit existed — it is the previous commit's result)`);
        continue;
      }
    }
    if (TERMINAL_FAILURE.has(state)) red.push(`${label} (${state.toLowerCase()})`);
    else if (!TERMINAL_SUCCESS.has(state)) pending.push(`${label} (${state ? state.toLowerCase() : 'not started'})`);
    else if (required !== null && required.has(name)) confirmed += 1;
  }
  if (required !== null) {
    for (const name of required) if (!seen.has(name)) pending.push(`${name} (not reported yet)`);
  }
  // 🔴 NOTHING RED AND NOTHING PENDING IS NOT THE SAME AS GREEN. Both empty can also mean this function
  // had no usable gate to judge against, and then it was answering "all clear" about a question it never
  // asked. Found by a peer session, reproduced here against this module:
  //
  //   required = EMPTY Set, both required checks IN_PROGRESS -> {red: [], pending: []}  (built from)
  //   required = EMPTY Set, no checks at all                 -> {red: [], pending: []}  (built from)
  //   required = null,      no checks at all                 -> {red: [], pending: []}  (built from)
  //   required = null,      only a non-gating check green    -> {red: [], pending: []}  (built from)
  //
  // The empty Set is the dangerous one, because it arrives on a 200: `readProtectionContexts()` treats
  // `contexts: []` as a successful read, and the classic `required_status_checks.contexts` array is
  // deprecated — a rule moved to a ruleset empties it. At that moment EVERY open PR reads green at once.
  //
  // So a green answer now requires something CONFIRMED: a named required check seen to finish
  // non-blocking. A name is only counted when the gate actually named it, which is why `required === null`
  // can never confirm anything — we will not certify a gate we could not read.
  if (red.length === 0 && pending.length === 0 && confirmed === 0) {
    pending.push(`nothing could be confirmed green — ${requiredGateUsable(required).why}`);
  }
  return { red, pending };
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
