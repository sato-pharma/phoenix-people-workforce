import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * THE MIRROR SCRIPT REFUSES A FLAG INSTEAD OF IGNORING IT.
 *
 * `scripts/sync-cloud-context.mjs` parsed NO arguments at all until 2026-10-15, so `--check` — the
 * flag a session reaches for to ASK whether the cloud mirror has drifted — was silently ignored and
 * the script did its one job: it rewrote the whole mirror into whatever checkout the caller happened
 * to be standing in, and exited 0, which reads exactly like a clean check.
 *
 * 🔴 WHAT THAT COST, MEASURED THE DAY IT WAS FOUND: 7 modified tracked files and 1 untracked mirror
 * note in a worktree another live session shared, byte-for-byte what an open fold PR already carried,
 * so the write produced nothing at all. Undoing it is then not the session's to do — a
 * `git restore --source=HEAD` on those paths is refused by the auto-mode classifier as irreversible
 * local destruction, correctly, because it cannot tell a script's own output from the owner's
 * uncommitted work. The price of a flag that did nothing was a dirty shared worktree only the owner
 * could authorise cleaning.
 *
 * WHAT THIS PINS, AND WHY IN THIS SHAPE:
 *
 *  1. THE REFUSAL ITSELF, by RUNNING the script. Exit 2, nothing written, and the message carries the
 *     ask-vs-fix split, because a refusal that does not say what to run instead sends the reader back
 *     to the flag.
 *  2. NOTHING IS WRITTEN. The guard is the one thing a source read cannot prove, so the README's size
 *     and mtime are read either side of every refused run.
 *  3. 🔴 THE NO-ARGUMENT RUN IS DELIBERATELY NOT EXERCISED. Running it IS the write — it would rewrite
 *     this checkout's mirror from whatever `~/.claude` holds on the machine running the suite, which
 *     on a CI runner is nothing at all. Its behaviour is pinned by `tests/cloud-mirror-drift.test.ts`
 *     (the LF rule) and by `scripts/module-memory/fold.mjs`, which is the only caller.
 *  4. THE GATE MUST PRECEDE THE MEMORY-SOURCE CHECK. A cloud runner has no `~/.claude`, so if the
 *     existence check came first the refusal would be exit 1 "memory source not found" there and
 *     exit 2 here — and every case below would pass on this laptop and fail on the box. That ordering
 *     is the only thing read from the source, after comments are stripped.
 *
 * THE BREAK DIRECTION: delete the `refuseArguments` call and case 1 fails on both machines — exit 2
 * becomes exit 1 (no memory dir on CI) or a full mirror write (on the laptop), and case 2 catches the
 * second one by the README's own bytes.
 */

const SYNC = "scripts/sync-cloud-context.mjs";
const README = ".claude/cloud-context/README.md";

const run = (...args: string[]) =>
  spawnSync(process.execPath, [SYNC, ...args], { encoding: "utf8", cwd: process.cwd() });

const stamp = () => {
  const s = statSync(README);
  return `${s.size}:${s.mtimeMs}`;
};

export function runSyncCloudContextArgsTests() {
  // ── 1 + 2. --check is refused, and the mirror is untouched ───────────────────────────────────
  {
    const before = stamp();
    const r = run("--check");
    assert.equal(r.status, 2, `${SYNC} --check must exit 2 (refused), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /REFUSED/, "the refusal must say so in the first line");
    assert.match(
      r.stderr,
      /no dry run/i,
      "it must say there is no dry run — that is the belief that caused the write",
    );
    assert.match(
      r.stderr,
      /module-memory\/build\.mjs --check/,
      "it must name the command that DOES ask about drift",
    );
    assert.match(
      r.stderr,
      /module-memory\/fold\.mjs --apply/,
      "it must name the command that fixes drift without touching the calling checkout",
    );
    assert.equal(r.stdout.trim(), "", "a refused run must print nothing to stdout");
    assert.equal(before, stamp(), `${SYNC} --check must write nothing — ${README} changed`);
  }

  // ── 3. Every other flag, including the ones that sound like a read ───────────────────────────
  for (const flag of ["--dry-run", "--dry", "-n", "--status", "--verify", "--validate", "--wat", "check"]) {
    const before = stamp();
    const r = run(flag);
    assert.equal(r.status, 2, `${SYNC} ${flag} must be refused with exit 2, got ${r.status}`);
    assert.match(r.stderr, /REFUSED/, `${SYNC} ${flag} must say REFUSED`);
    assert.match(r.stderr, new RegExp(`you passed: ${flag.replace(/[-]/g, "[-]")}`), "it must quote back what it was given");
    assert.equal(before, stamp(), `${SYNC} ${flag} must write nothing — ${README} changed`);
  }

  // A flag mixed with anything else is still refused, and the refusal still routes the reader.
  {
    const before = stamp();
    const r = run("--check", "--verbose");
    assert.equal(r.status, 2, "a refused flag beside another argument is still refused");
    assert.match(r.stderr, /module-memory\/fold\.mjs --apply/, "and it still says what to run instead");
    assert.equal(before, stamp(), "and it still writes nothing");
  }

  // ── 4. --help is the one argument that is allowed, and it writes nothing either ──────────────
  for (const flag of ["--help", "-h"]) {
    const before = stamp();
    const r = run(flag);
    assert.equal(r.status, 0, `${SYNC} ${flag} must exit 0, got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /no other arguments/, "the usage must say it takes no other arguments");
    assert.match(r.stdout, /module-memory\/build\.mjs --check/, "the usage must carry the ASK route");
    assert.match(r.stdout, /module-memory\/fold\.mjs --apply/, "the usage must carry the FIX route");
    assert.equal(before, stamp(), `${SYNC} ${flag} must write nothing — ${README} changed`);
  }

  // ── 5. The ordering that makes all of the above true on a runner with no ~/.claude ───────────
  {
    const source = stripComments(readFileSync(SYNC, "utf8"));
    const gate = source.indexOf("refuseArguments(");
    const memoryCheck = source.indexOf("existsSync(MEMORY_DIR)");
    assert.ok(gate > 0, `${SYNC}: the shared argument gate must be called`);
    assert.ok(memoryCheck > 0, `${SYNC}: the memory-source check must still exist`);
    assert.ok(
      gate < memoryCheck,
      `${SYNC}: the argument gate must run BEFORE the memory-source check, or a cloud runner refuses a flag with the wrong exit code`,
    );
  }
}
