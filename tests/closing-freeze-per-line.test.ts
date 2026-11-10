import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { publicationLineKey } from "../src/lib/sales/closing-store-split-net.ts";
import { normalizeClosingLine } from "../src/lib/sales/monthly-closing-publication.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * 🔒 A PUBLISHED CLOSING FREEZES ITS OWN LINE, NEVER THE WHOLE MONTH (owner, 2026-11-10:
 * "Unfreeze Pedia + CNS only").
 *
 * THE INCIDENT. Anti Infective October 2026 was published 2026-11-04 19:36 Cairo. The freeze was per
 * PERIOD, so Pedia's and CNS's October store split froze with it at its 18:47 state. El Qema's
 * October book landed 2026-11-08 21:37 — 4,114 Lacto packs at Al-Forsan Benha, Qalubeya — and was
 * never spread: the unpublished Pedia closing put every pack on Qalubeya and read its rep at 648%
 * (EGP 1,154,962 against 178,241). Rebuilt per line on 2026-11-10, Qalubeya read EGP 73,405 and
 * Anti Infective's published rows kept their fingerprints exactly.
 *
 * WHAT THIS PINS, on the LAST definition of each function across the migrations (the live one):
 *   · both writers take the published LINES of the period and rewrite only the others;
 *   · both still refuse the WHOLE period when a published line maps to no line_code (fail closed);
 *   · the sweep keeps a partially published period, or its unpublished lines never refresh;
 *   · the closing screen's isFrozenStoreSplitPeriod asks about THIS line, under the same key the
 *     publish workflow stores.
 */
const MIGRATIONS_DIR = resolve("supabase/migrations");

function lastDefinition(fn: string): { file: string; body: string } {
  const escaped = fn.replace(/[.]/g, "\\.");
  const header = new RegExp(`create\\s+or\\s+replace\\s+function\\s+${escaped}\\s*\\(`, "i");
  let found: { file: string; body: string } | null = null;
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8").replace(/\r\n/g, "\n"));
    const match = header.exec(sql);
    if (!match) continue;
    const rest = sql.slice(match.index);
    const close = /\$function\$\s*;|\$\$\s*;/i.exec(rest);
    found = { file, body: (close ? rest.slice(0, close.index + close[0].length) : rest).replace(/\s+/g, " ") };
  }
  if (!found) throw new Error(`no "create or replace function ${fn}(" in any migration`);
  return found;
}

function assertWritesOnlyUnpublishedLines(fn: string, table: string): void {
  const { file, body } = lastDefinition(fn);
  const lower = body.toLowerCase();

  const unmappedGuard = lower.indexOf("and lm.line_code is null");
  assert.ok(
    unmappedGuard !== -1 && /and lm\.line_code is null \) then [^;]*;\s*return\b/.test(lower),
    `${fn} (${file}): a published line with no line_code must still freeze the WHOLE period — fail closed`,
  );

  assert.match(
    lower,
    /v_frozen := array\( select distinct lm\.line_code from public\.monthly_closing_publications pub join au\.sos_official_line_map lm on [^;]*where pub\.period = p_period and pub\.unpublished_at is null \)/,
    `${fn} (${file}): the frozen set must be the line_codes PUBLISHED for this period — array(), never array_agg, which is NULL on no rows`,
  );

  const deleteAt = lower.indexOf(`delete from ${table}`);
  assert.ok(deleteAt > unmappedGuard, `${fn} (${file}): the published check must come before the delete`);
  const deleteStatement = lower.slice(deleteAt, lower.indexOf(";", deleteAt));
  assert.ok(
    deleteStatement.includes("<> all (v_frozen)"),
    `${fn} (${file}): the delete must spare the published lines — a period-wide delete is the 2026-11-04 freeze over again`,
  );
  const insertAt = lower.indexOf(`insert into ${table}`, deleteAt);
  const insertStatement = lower.slice(insertAt, lower.indexOf(";", insertAt));
  assert.ok(
    insertStatement.includes("<> all (v_frozen)"),
    `${fn} (${file}): the insert must skip the published lines, or a published line gets a second copy of its rows`,
  );
}

export function runClosingFreezePerLineTests(): void {
  assertWritesOnlyUnpublishedLines("public.phx_write_monthly_store_split_net", "au.monthly_store_split_net");
  assertWritesOnlyUnpublishedLines("au.f_refresh_monthly_attribution", "au.monthly_attribution_rollup");

  // The net writer's balance check reads only the lines it will write — a published line's rows in the
  // payload are ignored, never allowed to refuse the write for everyone else.
  {
    const { file, body } = lastDefinition("public.phx_write_monthly_store_split_net");
    const lower = body.toLowerCase();
    const balance = lower.slice(lower.indexOf("into v_bad"), lower.indexOf("if v_bad is not null"));
    assert.ok(balance.includes("<> all (v_frozen)"), `phx_write_monthly_store_split_net (${file}): the balance check must skip published lines`);
  }

  // Rows with no line_code belong to no closing — they stay frozen while ANY line of the period is published.
  {
    const { file, body } = lastDefinition("au.f_refresh_monthly_attribution");
    assert.ok(
      body.toLowerCase().includes("(not v_any or (r.line_code is not null and r.line_code <> all (v_frozen)))"),
      `f_refresh_monthly_attribution (${file}): a rollup row with no line_code must stay frozen once any line is published`,
    );
  }

  // The sweep keeps a partially published period: it declines only a period whose every mapped line is
  // published (or one with an unmappable publication). A period-wide `not exists` publication filter
  // would leave Pedia and CNS October stale behind a published Anti Infective, exactly as before.
  {
    const { file, body } = lastDefinition("au.f_refresh_stale_attribution_periods");
    const lower = body.toLowerCase();
    assert.match(
      lower,
      /and exists \( select 1 from au\.sos_official_line_map lm where lm\.line_code not in \( select lm2\.line_code from public\.monthly_closing_publications pub join au\.sos_official_line_map lm2 on [^;]*? where pub\.period = p\.period and pub\.unpublished_at is null \) \)/,
      `f_refresh_stale_attribution_periods (${file}): the sweep must keep a period while any mapped line is unpublished`,
    );
    assert.ok(
      !/and not exists \( select 1 from public\.monthly_closing_publications pub where pub\.period = p\.period and pub\.unpublished_at is null \)/.test(lower),
      `f_refresh_stale_attribution_periods (${file}): the period-wide publication filter must be gone`,
    );
  }

  // The closing screen asks the same question as the database: is THIS line published.
  {
    const source = stripComments(readFileSync(resolve("src/lib/sales/closing-store-split-net.ts"), "utf8"));
    const start = source.indexOf("export async function isFrozenStoreSplitPeriod(");
    assert.notEqual(start, -1, "isFrozenStoreSplitPeriod is exported from closing-store-split-net.ts");
    const fnBody = source.slice(start, source.indexOf("\n}", start));
    assert.match(
      fnBody,
      /\.from\("monthly_closing_publications"\)[\s\S]*\.eq\("period", trimmedPeriod\)[\s\S]*\.eq\("normalized_line", publicationLineKey\(trimmedLine\)\)[\s\S]*\.is\("unpublished_at", null\)/,
      "isFrozenStoreSplitPeriod must filter on the line's normalized_line — without it one line's publication freezes the whole month on screen",
    );
  }

  // …under the key the publish workflow writes.
  for (const line of ["Pedia", "  Anti   Infective ", "CNS", "anti infective", "Head Office", "", "PEDIA\t"]) {
    assert.equal(publicationLineKey(line), normalizeClosingLine(line), `publicationLineKey(${JSON.stringify(line)}) must equal normalizeClosingLine`);
  }
}
