import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `new-session.mjs --remove` must not refuse a worktree whose commits ARE on origin, merely because
// they arrived under another branch's name.
//
// The third gate protects real work: commits that exist nowhere but this folder. It answered the
// question with two tests — is there a remote branch of THIS worktree's own name (`ls-remote
// --heads origin <branch>`), and did a PR from that branch merge. Both are about the branch NAME.
//
// `new-session.mjs <task> --from origin/<their-branch>` creates a worktree carrying somebody else's
// commits on a fresh local branch that has never been pushed. Both name tests then answer no, and
// the gate reports the SOURCE branch's own commits as stranded — while they sit on origin, backed
// up, under the name they were pushed with.
//
// Measured on 2026-09-08: `--remove pharmacy-guard` refused over ca2b5445a and ff1b6f2c8, both of
// which answered `git branch -r --contains` with origin/claude/zealous-dewdney-7afb5e, and both of
// which were ancestors of that branch's live tip.
//
// The refusal had no exit. The rescue ref it advises is LOCAL, so it cannot satisfy a check that
// asks the remote; and the only thing that would is pushing the branch — which AGENTS.md forbids
// outright, because pushing a possibly-merged branch opens a conflicting PR and a conflicted PR
// runs no CI at all. So the documented way out led somewhere the rules refuse to go, and the
// working answer was to bypass the gate by hand. A guard with no legitimate exit is a guard people
// learn to step around, which is the failure this pins against.
//
// PINNED AS THE SHAPE, not the wording. What must survive is that the gate asks whether the tip is
// reachable from a remote ref, that it confirms the candidate against the REMOTE rather than a
// remote-tracking ref (`git fetch` never prunes, so a stale one outlives the branch GitHub deleted
// on merge), and that an error still refuses.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

export function runWorktreeRemoveRemoteContainmentTests() {
  const source = read("scripts/new-session.mjs");

  // ── The gate asks about REACHABILITY, not only about the branch name ───────
  assert.match(
    source,
    /"branch",\s*"-r",\s*"--contains",\s*"HEAD"/,
    "the removal gate must ask whether the worktree's tip is reachable from a remote ref — asking "
      + "only whether a remote branch of this worktree's own name exists reports another branch's "
      + "commits as stranded when they are on origin",
  );

  // ── …and that answer must be one of the escapes, not merely computed ───────
  // A check whose result never reaches the condition is the shape that reads as fixed and is not.
  const refusalStart = source.indexOf("if (unpushed");
  const refusalEnd = source.indexOf("REFUSED — commits here");
  assert.ok(
    refusalStart !== -1 && refusalEnd > refusalStart,
    "could not isolate the refusal condition — this test is measuring nothing until it can",
  );
  assert.ok(
    source.slice(refusalStart, refusalEnd).includes("onAnotherRemoteBranch"),
    "the reachability answer must gate the refusal itself — computing it and refusing anyway is "
      + "indistinguishable from not having it",
  );

  // ── A stale remote-tracking ref must not be able to answer it ──────────────
  // `git fetch` never prunes, so refs/remotes/origin/<branch> outlives the branch GitHub deletes on
  // merge. Reading containment out of the local refs alone would let a deleted branch vouch for
  // commits the remote no longer has.
  const containmentStart = source.indexOf("const onAnotherRemoteBranch");
  const containmentEnd = source.indexOf("delete_branch_on_merge is ON");
  assert.ok(
    containmentStart !== -1 && containmentEnd > containmentStart,
    "could not isolate the containment check — this test is measuring nothing until it can",
  );
  const containment = source.slice(containmentStart, containmentEnd);
  assert.match(
    containment,
    /ls-remote/,
    "the candidate refs must be confirmed against the REMOTE — a remote-tracking ref survives the "
      + "branch being deleted, so on its own it can vouch for commits origin no longer holds",
  );

  // ── It must fail CLOSED ────────────────────────────────────────────────────
  // Offline, or with a git that errors, the strict refusal is the safe answer: refusing costs a
  // folder that stays on disk, and the alternative costs work that existed nowhere else.
  assert.match(
    containment,
    /catch\s*\{\s*return null;/,
    "the containment check must fail closed — an error here has to leave the refusal standing, "
      + "never wave a worktree through because git could not answer",
  );

  // ── The summary line must not claim the branch itself is on origin ─────────
  // It printed "present, and the branch is on origin" for every non-merged case. Once a tip can be
  // backed up under ANOTHER name, that sentence is false exactly when this fix is what saved it,
  // and it would read as confirmation that the branch was pushed when it never was.
  assert.match(
    source,
    /not this branch's name/,
    "the summary must say WHICH ref backs the commits when it is not this branch — otherwise the "
      + "removal reports the branch as pushed when it was never pushed at all",
  );
}
