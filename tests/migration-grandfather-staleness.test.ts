import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Staleness guard for GRANDFATHERED_DUPLICATE_TIMESTAMPS in scripts/check-migrations.mjs.
//
// That Set exempts timestamps that two migration files legitimately share — parallel-authored
// collisions that were already applied to production, where each PR was green alone and the
// duplicate only exists once BOTH are on main. The exemption is fine. What is not fine is the
// exemption OUTLIVING the collision: once a timestamp stops naming two files, the entry is dead
// weight that quietly re-opens the door for a future genuine duplicate on the same prefix, and it
// tells every reader a collision exists that does not.
//
// That is not hypothetical. Measured 2026-09-03, THREE of the list's four entries were already
// dead and nothing had noticed: 20260616120000 and 20260617130000 matched no migration file at
// all, and #1419 ("resolve 20260728100000 timestamp collision") re-stamped one half of the third
// pair to 20260728100500, leaving 20260728100000 carrying a single file. The one-file case is the
// subtle one — the prefix still exists, so only a count catches it.
//
// The repo already had this doctrine for a different list: tests/hr-function-governance.test.ts
// asserts its grandfathered role/title collisions "must not rot into cover for a name that no
// longer collides". This is the same rule for the migration list.
//
// The guard is deliberately in TWO places. Section 2b of check-migrations.mjs fails on a stale
// entry so `pnpm run check:migrations` catches it in under a second, and this test proves that
// guard is present AND that it actually fails — the script's own SECURITY DEFINER rule is
// duplicated the same way, for the reason recorded beside it (three migrations once looked clean
// against the fast check alone and failed later in CI).
export function runMigrationGrandfatherStalenessTests() {
  const SCRIPT = "scripts/check-migrations.mjs";
  const source = readFileSync(SCRIPT, "utf8");
  const migrations = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));

  const block = source.match(/GRANDFATHERED_DUPLICATE_TIMESTAMPS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(
    block,
    "could not find GRANDFATHERED_DUPLICATE_TIMESTAMPS in scripts/check-migrations.mjs — if it was " +
      "renamed or restructured, update this guard rather than deleting it",
  );
  const entries = [...block[1].matchAll(/'(\d{14})'/g)].map((m) => m[1]);
  assert.ok(
    entries.length > 0,
    "the grandfather list parsed as empty — that is almost certainly this regex breaking, not the " +
      "list emptying, and a silently-empty list would make every assertion below vacuous",
  );

  // 1. Every exemption must still describe a real duplicate: two or more files on that prefix.
  for (const ts of entries) {
    const carrying = migrations.filter((f) => f.slice(0, 14) === ts);
    assert.ok(
      carrying.length >= 2,
      `"${ts}" is grandfathered as a duplicate timestamp but ${carrying.length} migration file(s) ` +
        `carry it${carrying.length === 1 ? ` (${carrying[0]})` : ""}. Remove it from ` +
        "GRANDFATHERED_DUPLICATE_TIMESTAMPS rather than leaving a stale exemption behind.",
    );
  }

  // 2. The fast check must carry the same rule, so it surfaces without the full suite.
  assert.match(
    source,
    /no longer names a duplicate/,
    "scripts/check-migrations.mjs must fail on a stale grandfathered entry itself — this test only " +
      "runs inside the full suite, and the list rotted unnoticed precisely because nothing fast checked it",
  );

  // 3. And that guard must actually FIRE. Run the real script against a scaffold, because a source
  //    pin alone would still pass if the loop were reduced to a no-op.
  const scaffold = mkdtempSync(path.join(tmpdir(), "grandfather-guard-"));
  try {
    const scriptDir = path.join(scaffold, "scripts");
    const migrationsDir = path.join(scaffold, "supabase", "migrations");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(migrationsDir, { recursive: true });
    // MIGRATIONS_DIR is resolved as <script>/../supabase/migrations, so the copy reads the fixture.
    copyFileSync(SCRIPT, path.join(scriptDir, "check-migrations.mjs"));

    const run = () =>
      spawnSync(process.execPath, [path.join(scriptDir, "check-migrations.mjs")], { encoding: "utf8" });

    // Every entry honestly duplicated -> the guard is silent and the script passes.
    for (const ts of entries) {
      writeFileSync(path.join(migrationsDir, `${ts}_alpha.sql`), "select 1;\n");
      writeFileSync(path.join(migrationsDir, `${ts}_beta.sql`), "select 1;\n");
    }
    const green = run();
    assert.equal(
      green.status,
      0,
      `the scaffold with every grandfathered timestamp genuinely duplicated must pass, else this ` +
        `test proves nothing about the failing case. stdout: ${green.stdout}${green.stderr}`,
    );

    // Drop one half of the first pair -> that entry no longer names a duplicate.
    rmSync(path.join(migrationsDir, `${entries[0]}_beta.sql`));
    const red = run();
    assert.notEqual(
      red.status,
      0,
      "a grandfathered timestamp carrying only ONE file must FAIL check-migrations — this is the " +
        "exact shape 20260728100000 sat in undetected after #1419 re-stamped its partner",
    );
    assert.match(
      `${red.stdout}${red.stderr}`,
      /no longer names a duplicate/,
      "the failure must name the stale-exemption rule, not merely exit non-zero for some other reason",
    );
  } finally {
    rmSync(scaffold, { recursive: true, force: true });
  }
}
