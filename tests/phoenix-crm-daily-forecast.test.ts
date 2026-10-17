import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import {
  FORECAST_ACCURACY_BAND,
  FORECAST_LINE_CODE,
  FORECAST_MAX_UNITS,
  accuracyReading,
  compareBoardRows,
  dailyShare,
  forecastIsOffered,
  forecastShareOfDay,
  isForecastLine,
  monthAccuracy,
  parseForecastDraft,
  periodOfDay,
  unitsRatio,
} from "../src/lib/phoenix-crm/daily-forecast.ts";
import { PHOENIX_CRM_MODULE_KEYS } from "../src/lib/phoenix-crm/modules.ts";

/**
 * Phoenix CRM — the CNS daily forecast (owner, 2026-10-01: "build the daily forecast module in Phoenix
 * ONLY FOR CNS LINE").
 *
 * It replaces the "Daily forecast" the CNS reps typed into the line's WhatsApp group. Each product
 * arrives PRE-FILLED with the rep's daily share of the month's target; he changes what he disagrees
 * with and sends; his managers read who sent, and — for a PUBLISHED month — how delivery compared.
 *
 * Every rule pinned here is silent when broken:
 *   - a forecast saved for Pedia compiles and saves (so the line is refused in the SQL itself);
 *   - boxes of two products added together make a plausible number (so the accuracy is valued per
 *     product and the form shows no total);
 *   - a verdict word on the rep's own form renders perfectly (Golden Rule #1 forbids it);
 *   - a pre-fill trusted from the screen, or a day taken from the body, saves without complaint.
 */

const MIGRATION = "supabase/migrations/20261001015949_phoenix_crm_daily_forecasts.sql";

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

function sql(): string {
  return stripSqlComments(readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

/** The text of one `export type Name = { … };` block. */
function typeBlock(text: string, name: string): string {
  const start = text.indexOf(`export type ${name} = {`);
  assert.notEqual(start, -1, `${name} is still declared`);
  const end = text.indexOf("\n};", start);
  assert.notEqual(end, -1, `${name} closes`);
  return text.slice(start, end);
}

export function runPhoenixCrmDailyForecastTests(): void {
  // ── 1. CNS only ─────────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(FORECAST_LINE_CODE, "cns", "the daily forecast is the CNS line's, and only the owner widens it");
    assert.ok(isForecastLine("cns"));
    assert.ok(isForecastLine(" CNS "), "the stored code is compared without case or spaces");
    for (const other of ["pedia", "anti_infective", "", null, undefined]) {
      assert.equal(isForecastLine(other), false, `${String(other)} is not the forecast's line`);
    }

    // Offered to a viewer with a CNS territory in scope, and to the Super Admin — nobody else.
    const cns = { lineCode: "cns" };
    const pedia = { lineCode: "pedia" };
    assert.equal(forecastIsOffered({ isSuperAdmin: false, scopeTerritories: [pedia, cns] }), true, "a CNS territory in scope opens it");
    assert.equal(forecastIsOffered({ isSuperAdmin: false, scopeTerritories: [pedia] }), false, "a scope with no CNS territory never sees it");
    assert.equal(forecastIsOffered({ isSuperAdmin: false, scopeTerritories: [] }), false, "no scope, no forecast");
    assert.equal(forecastIsOffered({ isSuperAdmin: true, scopeTerritories: [] }), true, "the Super Admin tries it in test mode");

    // 🔴 The Phoenix CRM tab AND the portal sidebar row ask that ONE function, so the sidebar can
    // never offer a door the tab then refuses (owner, 2026-10-01: "put it under forecast in sidebar").
    const overview = source("src/lib/phoenix-crm/server/overview.ts");
    assert.match(overview, /forecast: forecastIsOffered\(viewer\),/, "the tab is offered by the shared gate");
    const entryGate = source("src/lib/phoenix-crm/server/sidebar-entries.ts");
    assert.match(
      entryGate,
      /forecast: crm && forecastIsOffered\(viewer\)/,
      "the sidebar row is offered by the same gate, and only to someone the module lets in at all",
    );

    const service = source("src/lib/phoenix-crm/server/daily-forecast.ts");
    assert.equal((service.match(/assertForecastSeat\(seat\);/g) ?? []).length, 2, "both the form and the send refuse a territory outside CNS");
    assert.match(service, /\.filter\(\(seat\) => isForecastLine\(seat\.lineCode\)\)/, "the board lists CNS territories only");

    // 🔴 And the database refuses it too, so a route that forgot the rule still cannot write one.
    const migration = sql();
    assert.match(migration, /constraint phoenix_crm_daily_forecasts_cns_only check \(line_code = 'cns'\)/);
    assert.match(migration, /if v_line is distinct from 'cns' then\s+raise exception 'phoenix_crm:not_forecast_line';/);
    const db = source("src/lib/phoenix-crm/server/db.ts");
    assert.match(db, /not_forecast_line: \{ status: 403, message: "The daily forecast is for the CNS line only\." \}/, "and the refusal has words");
  }

  // ── 2. The pre-fill: the month's target ÷ its working days, per product ────────────────────────
  {
    assert.equal(dailyShare(1421, 22), 65, "1,421 boxes over 22 working days is 65 a day (64.6, rounded)");
    assert.equal(dailyShare(1870, 22), 85);
    assert.equal(dailyShare(0, 22), 0, "a zero target is a zero share");
    assert.equal(dailyShare(null, 22), null, "🔴 no target is NO pre-fill, never a made-up zero");
    assert.equal(dailyShare(1421, 0), null, "a month with no working day shares nothing");
    assert.equal(dailyShare(Number.NaN, 22), null);

    // The server recomputes the offered figure at send time; the screen's copy is never trusted.
    const service = source("src/lib/phoenix-crm/server/daily-forecast.ts");
    // Bounded by CODE, not by a comment: `source` strips comments, so a comment marker is never found.
    const saveStart = service.indexOf("export async function saveForecast(");
    const saveEnd = service.indexOf("function assertBoardReader(");
    assert.ok(saveStart >= 0 && saveEnd > saveStart, "the send's body was found");
    const save = service.slice(saveStart, saveEnd);
    assert.match(save, /suggested_units: dailyShare\(areaTargets\.get\(line\.productCode\)\?\.targetUnits \?\? null, days\.workingDays\)/);
    assert.match(save, /forecast_date: viewer\.visitDay/, "the day is the server's visit day");
    assert.doesNotMatch(save, /raw\.(day|date|suggested)/, "and never the body's");
    // The working days are the call rate's own calendar — Saturday to Wednesday, less national holidays.
    assert.match(service, /countCallRateWorkingDays\(start, end, holidays\.dates\)/);
  }

  // ── 3. What a send may carry ──────────────────────────────────────────────────────────────────
  {
    const allowed = new Set(["TE003", "TE002", "CO002"]);
    const ok = parseForecastDraft({ lines: [{ productCode: "te003", units: 60 }, { productCode: "CO002", units: 0 }] }, allowed);
    assert.ok(ok.ok, "a valid forecast parses");
    if (ok.ok) {
      assert.deepEqual(ok.value, [
        { productCode: "TE003", units: 60 },
        { productCode: "CO002", units: 0 },
      ], "codes are read upper-case, and zero is a real answer");
    }
    const refused: Array<[unknown, RegExp]> = [
      [{ lines: [] }, /at least one product/],
      [{}, /at least one product/],
      [{ lines: [{ productCode: "DO003", units: 5 }] }, /not one of your targets/],
      [{ lines: [{ productCode: "TE003", units: 5 }, { productCode: "te003", units: 6 }] }, /appears twice/],
      [{ lines: [{ productCode: "TE003", units: 2.5 }] }, /whole number/],
      [{ lines: [{ productCode: "TE003", units: -1 }] }, /whole number/],
      [{ lines: [{ productCode: "TE003", units: FORECAST_MAX_UNITS + 1 }] }, /whole number/],
    ];
    for (const [raw, error] of refused) {
      const result = parseForecastDraft(raw, allowed);
      assert.equal(result.ok, false, `${JSON.stringify(raw)} is refused`);
      if (!result.ok) assert.match(result.error, error);
    }
    const migration = sql();
    assert.match(migration, /constraint phoenix_crm_daily_forecasts_units check \(units between 0 and 5000\)/, "the database holds the same bound");
    assert.equal(FORECAST_MAX_UNITS, 5000);
  }

  // ── 4. 🔴 Units are never added across products ─────────────────────────────────────────────────
  {
    assert.equal(unitsRatio(650, 1000), 0.65, "last month is units against units of the SAME product");
    assert.equal(unitsRatio(null, 1000), 0, "no sales against a target is 0%");
    assert.equal(unitsRatio(650, null), null, "🔴 no target is no percentage, never 0%");
    assert.equal(unitsRatio(650, 0), null);

    // The day's share is by VALUE: 60 × 81 + 10 × 35.4375 against a day's target value.
    assert.equal(forecastShareOfDay([{ units: 60, price: 81 }, { units: 10, price: 35.4375 }], 5214.375), 1);
    assert.equal(forecastShareOfDay([{ units: 60, price: 81 }], null), null, "no day target, no share");
    assert.equal(forecastShareOfDay([{ units: 60, price: null }], 100), 0, "a product with no price is left out, not guessed");

    // The month: each product's average day, carried across the working days, valued, then summed.
    const accuracy = monthAccuracy({
      daysSent: 7,
      workingDays: 22,
      forecastUnits: new Map([
        ["TE003", 700],
        ["CO002", 70],
      ]),
      prices: new Map([
        ["TE003", 81],
        ["CO002", 35.4375],
      ]),
      actualValue: 185996.25,
    });
    assert.equal(accuracy.projectedValue, 100 * 22 * 81 + 10 * 22 * 35.4375, "per product, then valued — never 770 boxes of nothing in particular");
    assert.equal(accuracy.delivered, 1);
    const noPrice = monthAccuracy({ daysSent: 1, workingDays: 22, forecastUnits: new Map([["XX", 10]]), prices: new Map(), actualValue: 500 });
    assert.equal(noPrice.delivered, null, "a forecast that cannot be valued is not scored");
    assert.equal(monthAccuracy({ daysSent: 0, workingDays: 22, forecastUnits: new Map(), prices: new Map(), actualValue: 500 }).delivered, null, "nothing sent, nothing scored");

    // The form never shows a total of boxes.
    const tab = source("src/components/phoenix-crm/forecast-tab.tsx");
    const form = tab.slice(tab.indexOf("function ForecastForm("), tab.indexOf("function DayBoard("));
    assert.doesNotMatch(form, /\.reduce\(/, "the form sums nothing across products");
  }

  // ── 5. The verdict ────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(FORECAST_ACCURACY_BAND, 0.15);
    assert.equal(accuracyReading(0.84), "over-promised", "less came in than he forecast");
    assert.equal(accuracyReading(0.85), "on the mark");
    assert.equal(accuracyReading(1.15), "on the mark");
    assert.equal(accuracyReading(1.16), "under-promised", "more came in than he forecast");
    assert.equal(accuracyReading(null), null);

    // Scored only for a PUBLISHED closing: the Monthly Closing is the one sales truth, and a month is
    // read once the owner publishes it — never on the strength of an upload.
    const service = source("src/lib/phoenix-crm/server/daily-forecast.ts");
    assert.match(service, /const published = publishedPeriods\.includes\(period\);/);
    assert.match(service, /if \(!published\) \{\s+return \{ period, publishedPeriods, published, workingDays: 0, rows: \[\], isTest \};/);
    assert.match(service, /loadMonthlyAchievement\(period\)/, "the actual is the closing engine's, not a second query");
    assert.match(service, /listPublishedPeriodsForLine\(FORECAST_LINE_CODE\)/);
  }

  // ── 6. 🔴 Golden Rule #1: the rep never sees a verdict on his own forecasting ───────────────────
  {
    const service = source("src/lib/phoenix-crm/server/daily-forecast.ts");
    for (const name of ["ForecastFormView", "ForecastProductLine"]) {
      assert.doesNotMatch(typeBlock(service, name), /delivered|reading|accuracy|projected/i, `${name} — the rep's form — carries no accuracy at all`);
    }
    const tab = source("src/components/phoenix-crm/forecast-tab.tsx");
    const form = tab.slice(tab.indexOf("function ProductRow("), tab.indexOf("function DayBoard("));
    assert.doesNotMatch(form, /over-promised|under-promised|on the mark|Delivered|READING_TONE/, "and no verdict word reaches his screen");

    // The board is refused in the SERVICE to anyone who does not read team reports.
    assert.equal((service.match(/assertBoardReader\(viewer\);/g) ?? []).length, 2, "both board views are gated");
    assert.match(service, /if \(!readsTeamReports\(viewer\)\) throw forbiddenError/);
    // And the form is the territory's own rep's — a manager reads the board, not a rep's form.
    assert.match(service, /if \(!own && !\(viewer\.isSuperAdmin && isTest\)\) throw forbiddenError/);
  }

  // ── 7. A re-send replaces the boxes and keeps the FIRST send's time ─────────────────────────────
  {
    const migration = sql();
    assert.match(migration, /select min\(created_at\) into v_first/, "the first send's time is read before the old lines go");
    assert.match(migration, /coalesce\(v_first, now\(\)\), now\(\)/, "and written back onto the new ones");
    assert.match(migration, /pg_advisory_xact_lock\(hashtext\('phoenix_crm:daily_forecast:' \|\| v_seat \|\| ':' \|\| v_date::text\)\)/, "one send per territory and day at a time");
    assert.doesNotMatch(migration, /\bcurrent_date\b/i, "the day is the caller's Cairo day, never the database's UTC one");
    assert.match(migration, /revoke execute on function public\.phoenix_crm_save_daily_forecast\(jsonb\) from public, anon, authenticated;/);
    assert.match(migration, /grant execute on function public\.phoenix_crm_save_daily_forecast\(jsonb\) to service_role;/);

    // The district manager's in-app alert (owner, 2026-10-01) goes out only AFTER the boxes are saved —
    // a send the database refused must never tell a manager the forecast is in — and carries the
    // entry's own test flag, so a Super Admin try-out never reaches a real manager.
    const service = source("src/lib/phoenix-crm/server/daily-forecast.ts");
    const save = service.slice(service.indexOf("export async function saveForecast("), service.indexOf("function assertBoardReader("));
    const rpcAt = save.indexOf('callPhoenixCrm("phoenix_crm_save_daily_forecast"');
    const alertAt = save.indexOf('kind: "forecast_sent"');
    assert.ok(rpcAt > 0 && alertAt > rpcAt, "the alert is sent after the save, never before it");
    assert.match(save, /kind: "forecast_sent", org: viewer\.org, seat, day: viewer\.visitDay,[^\n]*\n\s*isTest,\n\s*\);/, "with the forecast's own day and the entry's test flag");
  }

  // ── 8. The board reads the not-sent first ───────────────────────────────────────────────────────
  {
    const rows = [
      { sent: true, regionName: "Cairo", name: "Heliopolis" },
      { sent: false, regionName: "Upper Egypt", name: "Qena 1" },
      { sent: false, regionName: "Alex-BHR", name: "Alex East" },
    ].sort(compareBoardRows);
    assert.deepEqual(
      rows.map((row) => row.name),
      ["Alex East", "Qena 1", "Heliopolis"],
      "who has NOT sent is what a manager opens the board to find",
    );
    assert.equal(periodOfDay("2026-10-01"), "2026-10");

    // 🔴 A VACANT territory is nobody's to send. Nine of the 35 CNS territories were vacant the day the
    // board shipped, and counting them as "not sent" buried the reps who really had not sent: they go
    // LAST, behind every held territory, and never into a region's "X of Y sent".
    const withVacant = [
      { sent: false, regionName: "Alex-BHR", name: "Alex West", vacant: true },
      { sent: true, regionName: "Cairo", name: "Heliopolis", vacant: false },
      { sent: false, regionName: "Upper Egypt", name: "Qena 1", vacant: false },
    ].sort(compareBoardRows);
    assert.deepEqual(
      withVacant.map((row) => row.name),
      ["Qena 1", "Heliopolis", "Alex West"],
      "a vacant territory sorts after every held one, sent or not",
    );
    const service = source("src/lib/phoenix-crm/server/daily-forecast.ts");
    assert.match(service, /vacant: !seat\.occupantHrId,/, "each board row says whether anyone holds the territory");
    assert.match(service, /if \(seat\.occupantHrId\) entry\.territories \+= 1;/, "a region counts only the territories someone can send for");
    const tab = source("src/components/phoenix-crm/forecast-tab.tsx");
    assert.match(tab, /const held = view\.rows\.filter\(\(row\) => !row\.vacant\)\.length;/, "the board's Not sent figure is over held territories only");
    assert.match(tab, /if \(row\.vacant\) return <CrmPill tone="neutral">Vacant<\/CrmPill>;/, "and a vacant row reads Vacant, never Not sent");
  }

  // ── 9. It is a module of its own, beside the Plan ───────────────────────────────────────────────
  {
    assert.equal(PHOENIX_CRM_MODULE_KEYS[PHOENIX_CRM_MODULE_KEYS.indexOf("plan") + 1], "forecast", "the forecast sits after the Plan, in the rep's day");
  }

  // ── 10. The reads behind the three views (Phoenix CRM performance audit, 2026-10-16) ────────────
  {
    const service = source("src/lib/phoenix-crm/server/daily-forecast.ts");
    // A month of a whole line's forecasts is keyset-paged on the primary key — an offset walk re-scans
    // every page it skips and drops a row when a forecast lands mid-read — and the seat chunks read
    // side by side, four at a time.
    const sentStart = service.indexOf("async function sentLinesOn(");
    const sentEnd = service.indexOf("function firstSentAt(");
    assert.ok(sentStart >= 0 && sentEnd > sentStart, "the forecasts read was found");
    const sentRead = service.slice(sentStart, sentEnd);
    assert.match(sentRead, /mapWithConcurrency\(chunk\(\[\.\.\.seatIds\], 100\), 4,/, "the seat chunks read four at a time");
    assert.match(sentRead, /fetchAllRowsKeyset<Row>\(/, "every chunk is keyset-paged");
    assert.match(sentRead, /\{ cursorColumn: "id", cursorOf: \(row\) => String\(row\.id\) \}/, "on the forecast's own id");
    assert.match(sentRead, /\.select\("id, seat_id, forecast_date, product_code, units, created_at"\)/, "which the read selects");
    assert.doesNotMatch(sentRead, /\.range\(/, "and no offset page is left");

    // The form a send hands back reuses the month the send itself just read.
    const save = service.slice(service.indexOf("export async function saveForecast("), service.indexOf("function assertBoardReader("));
    assert.match(save, /return buildForm\(viewer, seat, isTest, \{ targets, days \}\);/, "the send's own targets and working days ride into the form");

    // 🔴 The accuracy view may START its other reads early, but the CLOSING is read only for a month
    // confirmed published: the early return comes first, and the closing is read after it.
    const accuracy = service.slice(service.indexOf("export async function loadForecastAccuracy("));
    const refusedAt = accuracy.indexOf("if (!published) {");
    const closingAt = accuracy.indexOf("loadCnsClosing(period)");
    assert.ok(refusedAt > 0 && closingAt > refusedAt, "an unpublished month returns before its closing is ever read");
    const earlyReads = service.slice(service.indexOf("function accuracyMonthReads("), service.indexOf("export async function loadForecastAccuracy("));
    assert.doesNotMatch(earlyReads, /loadCnsClosing|loadMonthlyAchievement/, "and the reads that may start early carry no closing");
  }
}
