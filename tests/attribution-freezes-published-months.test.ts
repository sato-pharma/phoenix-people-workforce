import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A published month's attribution is frozen (owner, 2026-09-27 — "fix it forward only and leave
 * august as published").
 *
 * THE INCIDENT. au.f_monthly_attribution feeds Sales vs Target, the Business Review, the achievement
 * surfaces and incentives, and applies the wholesaler / El Qema city split through the stored table
 * au.monthly_store_split_net. That net is recomputed on every sales import that touches a period
 * (writeStoreSplitNetForBatch → phx_write_monthly_store_split_net → f_refresh_monthly_attribution).
 * The recompute reads the CLOSING's CURRENT split logic, so an import landing AFTER a month is
 * published rebuilds that month's split against since-changed logic and moves the achievement
 * surfaces off the announced closing. Measured on production: August Pedia was published
 * 2026-09-10 17:35 and its store split was rebuilt 2026-09-13 20:47, which spread El Qema out of
 * Qalubeya (D11 net −6,340 units) while the published closing concentrates it there (Qalubeya EGP
 * 1.84M vs 88K on the engine); the Pedia line then read 75.3% against a published 71.5%.
 *
 * THE FIX. 20260927213000 adds one guard to each of the two refresh functions: when the period is
 * currently published (a monthly_closing_publications row with unpublished_at is null), both return
 * without writing. A published month is therefore frozen at its state when it was published, and no
 * later import can move it; unpublishing lifts the guard. It changes no existing row, so it is
 * forward only.
 *
 * WHAT THIS TEST IS FOR. It reads the migrations as the database does — in timestamp order — and
 * checks the guard in whichever migration LAST defines each function, so a future migration that
 * redefines either function without the guard becomes the last definition and turns this red. A
 * fixed-byte slice of one file would not catch that; the point is the guard on the LIVE definition,
 * not on this one migration.
 */
const MIGRATIONS_DIR = resolve("supabase/migrations");

/** The `create or replace function <schema.>name(` header, case-insensitive, across whitespace. */
function definitionHeader(fn: string): RegExp {
  const escaped = fn.replace(/[.]/g, "\\.");
  return new RegExp(`create\\s+or\\s+replace\\s+function\\s+${escaped}\\s*\\(`, "i");
}

/** The body of the last `create or replace function <fn>` across all migrations, in timestamp order. */
function lastDefinition(fn: string): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const header = definitionHeader(fn);
  let found: { file: string; body: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const match = header.exec(sql);
    if (!match) continue;
    // From the header to the end of that function body ($function$; or $$;), whichever closes first.
    const from = match.index;
    const rest = sql.slice(from);
    const close = /\$function\$\s*;|\$\$\s*;/i.exec(rest);
    const body = close ? rest.slice(0, close.index + close[0].length) : rest;
    found = { file, body };
  }
  if (!found) throw new Error(`no "create or replace function ${fn}(" in any migration`);
  return found;
}

function assertPublishedGuard(fn: string): void {
  const { file, body } = lastDefinition(fn);
  const lower = body.toLowerCase();
  assert.ok(
    lower.includes("monthly_closing_publications"),
    `${fn}: its last definition (${file}) must consult monthly_closing_publications to know a month is published`,
  );
  assert.ok(
    lower.includes("unpublished_at is null"),
    `${fn}: its last definition (${file}) must gate on "unpublished_at is null" — the currently-published predicate`,
  );
  // A published branch that returns early: a `return` inside a block that also names the published test.
  const guardBlock = /if\s+exists\s*\([^;]*unpublished_at\s+is\s+null[\s\S]*?\breturn\b/i;
  assert.ok(
    guardBlock.test(body),
    `${fn}: its last definition (${file}) must RETURN early when the period is published, not fall through and rewrite it`,
  );
}

export function runAttributionFreezesPublishedMonthsTests(): void {
  // Both refresh functions freeze a published month.
  assertPublishedGuard("public.phx_write_monthly_store_split_net");
  assertPublishedGuard("au.f_refresh_monthly_attribution");
}
