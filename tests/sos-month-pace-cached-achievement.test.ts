import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dropRowsWithNoSalesLine } from "../src/lib/sales/vs-target.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * PERF-010 (2026-10-04) — the portal Source of Sales month-pace strip reads its targets through the
 * achievement engine's token-keyed per-month cache (`loadAchievementRange(period, period)`), not a raw
 * `phx_monthly_achievement` call on every render.
 *
 * Same rows: both RPCs are `au.f_monthly_achievement(period)` underneath, mapped field for field the
 * same way. The ONE thing the cached loader does differently is drop rows that carry no sales line
 * (dropRowsWithNoSalesLine) — and buildPortalMonthPace already refuses any row whose line is not the
 * viewer's, which a null line never is. Both halves are pinned here.
 */

const LOADER = "src/lib/sales/sos-month-pace-loader.ts";

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in ${LOADER}`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

export function runSosMonthPaceCachedAchievementTests() {
  // ── 1. The loader reads one month through the cached range loader ──────────────────
  {
    const source = stripComments(readFileSync(LOADER, "utf8"));
    const body = functionBody(source, "loadPortalMonthPace");
    assert.match(
      body,
      /loadAchievementRange\(period, period\)/,
      "the month-pace strip must read its month through loadAchievementRange(period, period) — the cached engine read",
    );
    assert.ok(
      !/loadMonthlyAchievement\(/.test(source),
      "the month-pace loader must not call the uncached loadMonthlyAchievement any more",
    );
    assert.match(
      source,
      /import \{ loadAchievementRange \} from "@\/lib\/sales\/vs-target";/,
      "loadAchievementRange comes from vs-target, the one cached achievement reader",
    );
  }

  // ── 2. The only rows the cached loader drops could never reach the strip ───────────
  {
    const source = stripComments(readFileSync(LOADER, "utf8"));
    assert.match(
      source,
      /if \(row\.lineCode !== lineCode \|\| !row\.hasTarget\) return false;/,
      "buildPortalMonthPace keeps only rows on the viewer's own line, so a row with no line never counted",
    );
    assert.match(
      functionBody(source, "loadPortalMonthPace"),
      /const lineCode = salesLineCodeForOfficialLine\(input\.line\);\s*if \(!lineCode\) return null;/,
      "and the line it compares against is never empty — the strip is not built without one",
    );
    const dropped = dropRowsWithNoSalesLine([{ lineCode: null }, { lineCode: "  " }, { lineCode: "pedia" }]);
    assert.deepEqual(
      dropped,
      [{ lineCode: "pedia" }],
      "dropRowsWithNoSalesLine removes ONLY rows with no sales line — the difference between the two loaders",
    );
  }
}
