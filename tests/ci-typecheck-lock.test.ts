// ONE TYPECHECK AT A TIME ON THE SELF-HOSTED CI BOX (owner, 2026-09-30: "fix the CI box so two PR
// typechecks never run at once").
//
// Both runners live on one 7.7 GB Hetzner box as the same user, and `tsc` over this repo climbs past
// 4 GB. Measured that morning: two PRs' typechecks at 4.1 GB and 2 GB side by side with the preview
// server, 3.1 GB into swap. ci.yml's Typecheck step now takes a kernel lock on a shared file and
// holds it for the run, so a second typecheck WAITS for the first; scripts/remote-check.mjs takes the
// same lock, so a hand-run check queues behind CI instead of racing it.
//
// Three ways that dies quietly, and this file closes each:
//   1. The lock is dropped, or taken in a DIFFERENT step from the typecheck — a lock released before
//      `tsc` starts serializes nothing and still looks installed.
//   2. The two callers drift to different lock files — each then only ever waits for itself.
//   3. The wait is unbounded — a stuck holder would hang every PR until the job timeout. Both
//      callers must use `flock -w`, and ci.yml must fall through to running anyway.
//
// Where `flock` exists (the CI runners are Linux), the ci.yml snippet is also RUN: with the lock
// held by another process it must wait and then run; with the lock free it must run at once.

import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LOCK = "/tmp/phx-typecheck.lock";

/** The `run: |` block of ci.yml's Typecheck step, dedented. */
function typecheckRunBlock(): string {
  const yml = readFileSync(resolve(".github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");
  const lines = yml.split("\n");
  const at = lines.findIndex((line) => /^\s+- name: Typecheck\s*$/.test(line));
  assert.ok(at >= 0, "ci.yml must still have a step named exactly `Typecheck`");
  const stepIndent = lines[at]!.indexOf("-");
  const runAt = lines.findIndex((line, i) => i > at && /^\s+run: \|\s*$/.test(line));
  assert.ok(runAt > at, "the Typecheck step must use a `run: |` block (the lock and tsc share one shell)");
  const nextStep = lines.findIndex((line, i) => i > at && /^\s+- name:/.test(line) && line.indexOf("-") === stepIndent);
  assert.ok(nextStep < 0 || runAt < nextStep, "the `run: |` block found must belong to the Typecheck step itself");
  const body: string[] = [];
  const blockIndent = lines[runAt]!.indexOf("run:") + 2;
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() && line.search(/\S/) < blockIndent) break;
    body.push(line.slice(blockIndent));
  }
  return body.join("\n").trim();
}

function hasFlock(): boolean {
  return spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" }).status === 0;
}

export async function runCiTypecheckLockTests() {
  // 1. ci.yml: the lock and the typecheck are ONE shell, lock first, bounded wait.
  const block = typecheckRunBlock();
  const lockAt = block.indexOf(`exec 9>${LOCK}`);
  const tscAt = block.indexOf("pnpm run typecheck");
  assert.ok(lockAt >= 0, `the Typecheck step must open ${LOCK} on fd 9 — without it two typechecks run at once again`);
  assert.ok(tscAt > lockAt, "the typecheck must run AFTER the lock is taken, in the same step, so the lock is held while tsc runs");
  assert.match(block, /flock -w \d+ 9/, "the wait for the lock must be bounded (`flock -w`), or a stuck holder hangs every PR");
  assert.match(block, /flock -w \d+ 9 \|\|/, "a timed-out wait must fall through and run the typecheck, never fail the PR by itself");

  // 2. remote-check: the SAME lock, bounded, in front of tsc.
  const remote = readFileSync(resolve("scripts/remote-check.mjs"), "utf8");
  assert.match(
    remote,
    new RegExp(`typecheck:\\s*\\n?\\s*"flock -w \\d+ ${LOCK.replace(/\//g, "\\/").replace(/\./g, "\\.")} [^"]*tsc --noEmit`),
    `scripts/remote-check.mjs must take the same lock (${LOCK}) with a bounded wait before tsc — a different file waits only for itself`,
  );

  // 3. Behaviour, where flock exists (the Linux CI runners; not Git Bash on the laptop).
  if (!hasFlock()) return;
  const dir = mkdtempSync(join(tmpdir(), "phx-tclock-"));
  const lockFile = join(dir, "lock");
  const snippet = block.split(LOCK).join(lockFile).replace("pnpm run typecheck", "echo TYPECHECK-RAN");
  try {
    // Free lock: runs at once, no waiting message.
    const free = spawnSync("bash", ["-e", "-c", snippet], { encoding: "utf8", timeout: 20000 });
    assert.equal(free.status, 0, `the lock snippet failed with the lock free:\n${free.stderr}`);
    assert.match(free.stdout, /TYPECHECK-RAN/, "with the lock free the typecheck must run");
    assert.doesNotMatch(free.stdout, /waiting for it/, "with the lock free it must not wait");

    // Held lock: another process holds it for 3s, so the snippet must wait, then run.
    const holder = spawn("flock", [lockFile, "sleep", "3"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 500));
    const started = Date.now();
    const held = spawnSync("bash", ["-e", "-c", snippet], { encoding: "utf8", timeout: 30000 });
    const waitedMs = Date.now() - started;
    holder.kill();
    assert.equal(held.status, 0, `the lock snippet failed while waiting:\n${held.stderr}`);
    assert.match(held.stdout, /waiting for it/, "with the lock held the step must say it is waiting");
    assert.match(held.stdout, /TYPECHECK-RAN/, "after the holder lets go the typecheck must run");
    assert.ok(waitedMs >= 1500, `with the lock held the typecheck must WAIT for it — it ran after ${waitedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
