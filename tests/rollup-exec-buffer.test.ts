import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROLLUP_MAX_BUFFER, git } from "../scripts/lib/rollup-exec.mjs";
import { SHARED_REGISTRY_PATH } from "../scripts/rollup-carried.mjs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The roll-up's `git()` must read a file larger than Node's default 1 MiB output limit.
 *
 * On 29 Oct 2026 the suite registry `tests/run-tests.ts` reached 1,053,835 bytes. `execFileSync`'s
 * default `maxBuffer` is 1,048,576, so `registryLandedOnMain()`'s `git show origin/main:tests/run-tests.ts`
 * died with ENOBUFS, `allowFail` turned that into `null`, and `--settle` read the null as "not landed":
 * PR 6643 was left open twice although every one of its files was already on `main`, and was closed by
 * hand. Nothing printed.
 *
 * Spelling a `maxBuffer` is not the proof — a read is. So this drives the very `git()` the roll-up
 * calls against a real 2 MiB blob, and first shows that the same read with Node's defaults fails, so
 * the fixture is known to cross the line it is meant to cross.
 */
export function runRollupExecBufferTests(): void {
  // (a) The ceiling has room for the registry to keep growing, not just to clear today's size.
  const registryBytes = statSync(SHARED_REGISTRY_PATH).size;
  assert.ok(
    ROLLUP_MAX_BUFFER >= registryBytes * 8,
    `the roll-up's output ceiling (${ROLLUP_MAX_BUFFER} bytes) must be at least 8 times the suite registry (${registryBytes} bytes)`,
  );

  const dir = mkdtempSync(join(tmpdir(), "rollup-exec-buffer-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
    const size = 2 * 1024 * 1024;
    writeFileSync(join(dir, "big.txt"), "x".repeat(size));
    const blob = execFileSync("git", ["hash-object", "-w", "big.txt"], { cwd: dir, encoding: "utf8" }).trim();

    // (c) The fixture really crosses Node's default limit: the read the roll-up made before the fix fails.
    assert.throws(
      () => execFileSync("git", ["show", blob], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      /ENOBUFS/,
      "a 2 MiB read with Node's default maxBuffer must fail, or this fixture proves nothing",
    );

    // (b) The roll-up's own door reads it whole.
    const read = git(["show", blob], { cwd: dir, allowFail: true, raw: true });
    assert.notEqual(
      read,
      null,
      "the roll-up's git() returned null for a 2 MiB blob — the ENOBUFS that left PR 6643 open is back",
    );
    assert.equal(read?.length, size, "the roll-up's git() must return the whole blob, not a truncated one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // (d) And the real registry, through the same door, from this checkout's own commit.
  const registry = git(["show", `HEAD:${SHARED_REGISTRY_PATH}`], { allowFail: true, raw: true });
  assert.notEqual(registry, null, `the roll-up's git() could not read ${SHARED_REGISTRY_PATH} from HEAD`);
  assert.ok((registry?.length ?? 0) > 1024 * 1024, "the registry this pins against is expected to be over 1 MiB");

  // (e) One child-process door, and the roll-up does not open a second one around it.
  const moduleCode = stripComments(readFileSync("scripts/lib/rollup-exec.mjs", "utf8"));
  assert.equal(
    moduleCode.split("execFileSync(").length - 1,
    1,
    "scripts/lib/rollup-exec.mjs must call execFileSync in exactly one place, the capture() that sets the ceiling",
  );
  const rollupCode = stripComments(readFileSync("scripts/rollup-prs.mjs", "utf8"));
  assert.ok(
    !/\bexecFileSync\b|\bexecSync\b|\bspawnSync\b/.test(rollupCode),
    "scripts/rollup-prs.mjs must reach git and gh only through scripts/lib/rollup-exec.mjs",
  );
}
