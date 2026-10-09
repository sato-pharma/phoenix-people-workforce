// A rule-recomputing script must refuse to run from a checkout that is BEHIND origin/main.
//
// WHY THIS EXISTS. 2026-10-09, between 19:16 and 19:29 Cairo, three store-split rulings merged and
// shipped: #5685's twelve warehouse stems, #5687's طاى جروب, #5689's `تامين` government word. At
// 19:35 a session ran `backfill-attribution-store-split.ts --apply 2026-09` in the PRIMARY checkout,
// whose local `main` is never fast-forwarded and still sat at 077e838dd, and wrote 423 net rows to
// production computed by pre-merge code — 26 relocation cells short on CNS (289 against 309) and
// Anti Infective (47 against 53). The figure was quoted to the owner before anyone noticed, and only
// a re-run from a worktree on origin/main caught it. The same stale tree had already printed
// `DRIFTED — 213 cells / 45,021.99 EGP` minutes after a correct rebuild.
//
// Nothing downstream could have caught it: the split preserves every line's unit total, so the
// units-based publication drift check reads clean by construction.
//
// WHAT IS PINNED. Not equality with origin/main — a feature branch is legitimately AHEAD, and a
// session verifying its own unmerged rule change has to be able to run these scripts. The test is
// ancestry, and the end-to-end half runs against a REAL bare remote and a clone genuinely one commit
// behind it, so the fetch, the ancestry read and the exit code are exercised together rather than
// mocked.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  STALE_TREE_EXIT_CODE,
  STALE_TREE_OVERRIDE_ENV,
  decideTreeVerdict,
  readTreeState,
  type TreeState,
} from "../scripts/lib/tree-is-current.ts";

/** Every script that brings its own copy of the rule to a production number. */
const GUARDED_SCRIPTS = [
  "scripts/backfill-attribution-store-split.ts",
  "scripts/check-store-split-drift.ts",
  "scripts/check-closing-publication-drift.ts",
] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A bare remote plus a clone, so `origin/main` is a real remote-tracking ref. */
function buildRemoteAndClone(root: string): { clone: string; remote: string } {
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", "--quiet", remote, seed);
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  writeFileSync(join(seed, "rule.txt"), "the rule, first version\n");
  git(seed, "add", "rule.txt");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "push", "--quiet", "origin", "main");
  git(root, "clone", "--quiet", remote, clone);
  git(clone, "config", "user.email", "test@example.com");
  git(clone, "config", "user.name", "Test");
  // The ruling that merges while the other tree is not looking.
  writeFileSync(join(seed, "rule.txt"), "the rule, with the twelve stems\n");
  git(seed, "commit", "--quiet", "-am", "the ruling the stale tree will not have");
  git(seed, "push", "--quiet", "origin", "main");
  return { clone, remote };
}

export function runStoreSplitStaleTreeGuardTests() {
  const root = mkdtempSync(join(tmpdir(), "phx-stale-tree-"));
  try {
    const { clone } = buildRemoteAndClone(root);

    // END TO END: a clone that has never fetched the ruling is BEHIND, and the guard says so. Its
    // own origin/main ref still points at the seed until readTreeState fetches — which is the whole
    // point, because the primary checkout is exactly this shape.
    const behind = readTreeState(clone);
    assert.equal(
      behind.originMainIsAncestor,
      false,
      "a clone one commit behind the remote must not count as holding origin/main",
    );
    assert.equal(behind.behindCount, 1, "the guard must count how many commits are missing");
    assert.ok(behind.fetched, "readTreeState must fetch origin/main itself — a stale local ref is the bug");
    const refusal = decideTreeVerdict(behind, { scriptName: "check-store-split-drift" });
    assert.equal(refusal.allow, false, "a behind tree must be REFUSED, not warned about");
    assert.match(refusal.message, /REFUSING TO RUN/, `the refusal must say so plainly:\n${refusal.message}`);
    assert.match(
      refusal.message,
      /1 commit\(s\) BEHIND origin\/main/,
      `the refusal must carry how far behind it is:\n${refusal.message}`,
    );
    assert.ok(
      refusal.message.includes(String(behind.head)) && refusal.message.includes(String(behind.originMain)),
      `the refusal must name both shas so the reader can check it:\n${refusal.message}`,
    );
    assert.match(
      refusal.message,
      /new-session\.mjs/,
      `the refusal must name the way out, or a session tries another spelling:\n${refusal.message}`,
    );
    assert.ok(
      refusal.message.includes(`${STALE_TREE_OVERRIDE_ENV}=1`),
      `the refusal must hand back the stand-down:\n${refusal.message}`,
    );

    // A tree AHEAD of origin/main is fine: that is every feature branch, including one carrying the
    // rule change being verified. Refusing it would make the guard the first thing switched off.
    writeFileSync(join(clone, "local.txt"), "my own unmerged change\n");
    git(clone, "add", "local.txt");
    git(clone, "commit", "--quiet", "-m", "my branch, on top of the ruling");
    git(clone, "fetch", "--quiet", "origin", "main");
    git(clone, "merge", "--quiet", "--no-edit", "origin/main");
    const ahead = readTreeState(clone);
    assert.equal(ahead.originMainIsAncestor, true, "a tree containing origin/main must be allowed");
    const allowed = decideTreeVerdict(ahead, { scriptName: "check-store-split-drift" });
    assert.equal(allowed.allow, true, "a tree that holds every commit on main must run");
    assert.match(
      allowed.message,
      /holds every commit on origin\/main/,
      `the allowed line is the proof that travels with the numbers:\n${allowed.message}`,
    );

    // FAIL OPEN, LOUDLY, and only when git cannot answer at all: a repository with no remote (a
    // cloud export, a tarball) must still be able to run the script.
    const orphan = join(root, "orphan");
    git(root, "init", "--quiet", "--initial-branch=main", orphan);
    git(orphan, "config", "user.email", "test@example.com");
    git(orphan, "config", "user.name", "Test");
    writeFileSync(join(orphan, "a.txt"), "a\n");
    git(orphan, "add", "a.txt");
    git(orphan, "commit", "--quiet", "-m", "only commit");
    const noRemote = readTreeState(orphan);
    assert.equal(noRemote.originMain, null, "a repo with no origin has no origin/main to compare against");
    const warned = decideTreeVerdict(noRemote, { scriptName: "check-store-split-drift" });
    assert.equal(warned.allow, true, "no origin/main must not make the script unusable");
    assert.match(
      warned.message,
      /CANNOT CHECK THIS TREE/,
      `failing open must be LOUD, or it is the old silent defect:\n${warned.message}`,
    );

    // The stand-down works, and says what it costs.
    const overridden = decideTreeVerdict(behind, {
      override: true,
      scriptName: "backfill-attribution-store-split",
    });
    assert.equal(overridden.allow, true, `${STALE_TREE_OVERRIDE_ENV} must stand the guard down`);
    assert.ok(
      overridden.message.includes(STALE_TREE_OVERRIDE_ENV),
      `the stand-down must announce itself:\n${overridden.message}`,
    );
    assert.match(
      overridden.message,
      /this tree's code, not main's/,
      `the stand-down must say whose code the numbers carry:\n${overridden.message}`,
    );

    // An unknown ancestry answer (git present, ref present, merge-base unreadable) is treated as
    // unknown rather than as a pass: only an explicit false refuses.
    const unknown: TreeState = {
      behindCount: null,
      fetched: true,
      head: "aaaaaaa",
      originMain: "bbbbbbb",
      originMainIsAncestor: null,
    };
    assert.equal(
      decideTreeVerdict(unknown, { scriptName: "x" }).allow,
      true,
      "an unknown ancestry must not block, but must not claim the tree is current either",
    );

    // The exit code is its own, so a caller can tell a stale tree from bad flags (64).
    assert.equal(STALE_TREE_EXIT_CODE, 69, "the stale-tree exit code is EX_UNAVAILABLE");
    assert.notEqual(STALE_TREE_EXIT_CODE, 64, "it must not collide with the unknown-flag refusal");

    // WIRING. Every guarded script must call the guard BEFORE it reaches production, and each file
    // is sliced at its own call rather than scanned whole, so an unrelated addition elsewhere
    // cannot stand in for the call.
    for (const script of GUARDED_SCRIPTS) {
      const source = readFileSync(resolve(script), "utf8");
      assert.match(
        source,
        /import \{ assertTreeIsCurrent \} from "\.\/lib\/tree-is-current\.ts";/,
        `${script} must import the guard`,
      );
      const call = source.indexOf("assertTreeIsCurrent(");
      const client = source.indexOf("getSupabaseAdmin()");
      assert.ok(call > 0, `${script} must CALL assertTreeIsCurrent, not merely import it`);
      assert.ok(
        call < client,
        `${script} must check the tree before it builds a production client (call at ${call}, client at ${client})`,
      );
      const name = /assertTreeIsCurrent\("([^"]+)"\)/.exec(source)?.[1];
      assert.equal(
        name,
        script.replace("scripts/", "").replace(".ts", ""),
        `${script} must name itself in the guard, so the refusal says which script refused`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
