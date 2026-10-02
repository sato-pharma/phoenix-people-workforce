#!/usr/bin/env node
// WHEN A PR'S WORK IS ALREADY ON `main`, AND WHY ONE SHARED FILE BREAKS THE ANSWER.
//
// `--settle` closes a PR whose content a roll-up already carried, and it proves that by comparing
// EVERY file byte-for-byte against `main`. Failing closed is the right direction and stays: a PR closed
// on a guess is work thrown away, while a PR left open costs one avoidable CI run.
//
// But one path in this repo can never stay byte-identical: `tests/run-tests.ts` is the suite registry,
// so every PR that adds a test appends to it, and the moment ANY other PR registers a suite the
// carried PR's copy differs from `main` in a way that says nothing about whether its own work landed.
//
// Measured 2026-09-30, and reported by a peer session that closed the PR by hand: after roll-up #4937
// merged, `--settle` closed #4930 and left #4936 open although all of #4936's work was on `main` — two
// of its three files byte-identical, and its registry lines present (imported at line 606, registered
// at 3388). The comparison was not wrong about the bytes; it was answering the wrong question about
// this one file.
//
// SO THE RULE IS NARROWED FOR THAT PATH ONLY, and narrowed rather than loosened: every line the PR
// ADDED to the registry must be present on `main`. Nothing here accepts "most files match" — every
// other path still has to be byte-identical, and a registry line that is missing still means NOT
// carried. What it drops is the requirement that the rest of the file be untouched by other people.
'use strict';

/**
 * The one path whose byte-identity says nothing about whether a PR's own work landed.
 *
 * It is a single named path, not a pattern: a pattern would quietly extend this exception to the next
 * shared file somebody adds, and the whole point is that this rule is allowed to be weaker ONLY where
 * the file is a registry every PR appends to.
 */
export const SHARED_REGISTRY_PATH = 'tests/run-tests.ts';

/**
 * Whether every line a PR ADDED to the suite registry is present on `main`.
 *
 * Added lines only. A line the PR DELETED is not evidence of anything — a roll-up merge can legitimately
 * leave a deletion in place — and a line it merely moved appears on both sides.
 *
 * Blank lines and lines that are only punctuation (`);`, `}`, `,`) are ignored: they appear hundreds of
 * times in the registry, so finding one proves nothing, and requiring them would make the answer depend
 * on unrelated formatting. What is left is the import and the `await runTest(` registration, which are
 * the two lines that decide whether the suite actually runs.
 *
 * @param {ReadonlyArray<string>} addedLines the `+` lines of the PR's own delta for the registry.
 * @param {string} mainSource the registry as it stands on `main`.
 * @returns {{ landed: boolean, missing: string[] }} `landed` is false when ANY meaningful added line is
 *   absent — the failing-closed direction, unchanged.
 */
export function registryAddedLinesLanded(addedLines, mainSource) {
  const main = String(mainSource ?? '');
  const missing = [];
  for (const raw of addedLines ?? []) {
    const line = String(raw ?? '').trim();
    // Punctuation-only and blank lines carry no identity, so their presence would be meaningless and
    // their absence would be a false negative on a reformat.
    if (line === '' || /^[)\]},;]+$/.test(line)) continue;
    if (!main.includes(line)) missing.push(line);
  }
  return { landed: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------------------------
// WHY BYTE-IDENTITY IS THE WRONG QUESTION FOR EVERY PATH, NOT JUST THE REGISTRY — 2026-10-02.
//
// Measured the night of 2026-10-01. Roll-up #5098 merged and carried #5096's relocation verbatim:
// the account it moved out of `AGENTS.md` appeared once at #5096's merge base, zero times on its
// branch, and zero times on `main` afterwards, with the destination doc byte-identical. Its work had
// fully landed. `--settle` still refused to close it, because `main`'s `AGENTS.md` had moved past the
// branch's copy (114,585 bytes against the PR's 115,060) — the roll-up carried a SECOND member that
// touched the same file. Two of the three carried members that night needed a human decision for this
// reason, and the one that reached the owner cost him a turn.
//
// THE OWNER ASKED FOR PATCH-IDS, AND A PATCH-ID CANNOT ANSWER IT ALONE. `git patch-id` compares one
// diff with another, and `git cherry` uses exactly that to ask "is my commit already upstream" — but a
// roll-up is a SQUASH of several members, so the carrier commit's diff is strictly larger than any one
// member's and their patch-ids never match. Measured on #5096: its own patch-id was
// `828169aa16aa0b5f9940dc89c67558b4e5a5ad1d`, which equals the roll-up's slice for its two files and
// nothing in `main`'s history. So the instrument is the question patch-id is a means to — IS THIS
// DELTA ALREADY APPLIED — asked per path by reverse-applying the PR's own delta against `main`'s tree.
// `git apply --check --reverse` answers it exactly: it succeeds only when every line the delta adds is
// present and every line it removes is gone.
//
// FAILING CLOSED IS UNCHANGED AND IS THE WHOLE SAFETY STORY. An empty delta, an unreadable tree, a
// patch that does not apply, any error at all: NOT carried, PR left open. The cost of a false negative
// is one avoidable CI run; the cost of a false positive is a person's work closed on a guess.

/**
 * Whether a path's delta is proven landed, given the three readings the caller took.
 *
 * Kept pure so the decision is testable without a repository: `blobsEqual` is the fast path that was
 * the whole test before today, and `reverseApplies` is `git apply --check --reverse` against `main`.
 *
 * @param {{ blobsEqual?: boolean, hasDelta?: boolean, reverseApplies?: boolean }} r
 * @returns {boolean} true only when one of the two proofs holds.
 */
export function pathDeltaLanded(r) {
  if (r?.blobsEqual === true) return true;
  // No delta of our own for this path means there is nothing to prove landed — and nothing that
  // justifies holding the PR open either, but the bytes already disagreed, so answer NOT carried.
  if (r?.hasDelta !== true) return false;
  return r?.reverseApplies === true;
}
