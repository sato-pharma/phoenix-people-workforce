import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { resolveRoiResultStatus } from "../src/lib/marketing-requests/roi-report-service.ts";
import { ROI_DATA_PENDING_LABEL, ROI_RESULT_STATUS_LABEL } from "../src/lib/marketing-requests/roi-labels.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * `phx_marketing_roi_fast` — the RPC behind the Sales & Marketing Intelligence dashboard — must
 * answer `awaiting_data` while a request's ROI window is still open.
 *
 * Found in the ROI Tracker / Coverage Report audit, 2026-10-09: that function recomputes the
 * verdict itself from the stored facts and had no `awaiting_data` arm at all, so with the latest
 * validated Source-of-Sales month at 2026-08 every one of the 23 requests the dashboard showed read
 * `behind` (10) or `no_data` (13) while every window was still running — a campaign two weeks into
 * a twelve-month window labelled a failure, and 122,107 EGP counted as spend at risk.
 *
 * The rule is `resolveRoiResultStatus` in src/lib/marketing-requests/roi-report-service.ts, and the
 * SQL must MIRROR it rather than carry a second opinion: on track once the required value is
 * reached (at any time), else awaiting data while the window ends after the validated month, else
 * behind when sales exist, else no data. Both sides are pinned here, so a change to either that
 * leaves the other behind fails.
 */

/** `--` to end of line. No string literal in these bodies contains a double dash. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const MIGRATION_DIRS = [
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/", import.meta.url),
  new URL("../supabase/migrations/", import.meta.url),
];

/**
 * The body Postgres would actually hold today: every migration in chronological order, keeping the
 * LAST `create [or replace] function public.<name>(` block — how CREATE OR REPLACE behaves. Keyed
 * on content, never on a filename, so renaming or superseding this migration still resolves.
 */
function latestFunctionBody(funcName: string): { file: string; body: string } {
  const startRe = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${funcName}\\s*\\(`, "i");
  let latest: { file: string; body: string } | null = null;
  for (const dir of MIGRATION_DIRS) {
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(name, dir), "utf8");
      const match = startRe.exec(sql);
      if (!match) continue;
      const rest = sql.slice(match.index);
      const tagMatch = /\bas\s+(\$[a-zA-Z_]*\$)/i.exec(rest);
      assert.ok(tagMatch, `${funcName}: ${name} defines it but has no dollar-quoted body`);
      const tag = tagMatch[1]!;
      const afterOpen = rest.slice(tagMatch.index! + tagMatch[0].length);
      const closeIdx = afterOpen.indexOf(tag);
      assert.ok(closeIdx >= 0, `${funcName}: ${name} opens ${tag} and never closes it`);
      const bodyEnd = tagMatch.index! + tagMatch[0].length + closeIdx + tag.length;
      latest = { body: rest.slice(0, bodyEnd), file: name };
    }
  }
  assert.ok(latest, `${funcName}: no migration defines it`);
  return latest!;
}

export function runMarketingRoiFastAwaitingDataTests() {
  // ── The app-side rule the SQL mirrors ────────────────────────────────────────────────────────
  // Reaching the required value is on track even mid-window; below it with the window still open
  // is awaiting data, NOT behind and NOT no-data.
  assert.equal(
    resolveRoiResultStatus({ salesRows: 4, actualValue: 9000, requiredRoiValue: 9000, salesDataComplete: false }),
    "on_track",
    "meeting the required value is on track at any point in the window",
  );
  assert.equal(
    resolveRoiResultStatus({ salesRows: 4, actualValue: 10, requiredRoiValue: 9000, salesDataComplete: false }),
    "awaiting_data",
    "below target with months still unuploaded is awaiting data, never behind",
  );
  assert.equal(
    resolveRoiResultStatus({ salesRows: 0, actualValue: 0, requiredRoiValue: 9000, salesDataComplete: false }),
    "awaiting_data",
    "no attributed sales YET, while the window runs, is awaiting data and never no_data",
  );
  assert.equal(
    resolveRoiResultStatus({ salesRows: 4, actualValue: 10, requiredRoiValue: 9000, salesDataComplete: true }),
    "behind",
    "a closed window with sales below target is behind",
  );
  assert.equal(
    resolveRoiResultStatus({ salesRows: 0, actualValue: 0, requiredRoiValue: 9000, salesDataComplete: true }),
    "no_data",
    "a closed window with nothing attributed is no_data",
  );

  // ── The SQL carries the same four arms, in the same order ────────────────────────────────────
  const { body: raw, file } = latestFunctionBody("phx_marketing_roi_fast");
  const body = stripSqlComments(raw);
  assert.ok(body.length > 20000, `the fast RPC body must resolve whole (got ${body.length} chars from ${file})`);

  assert.match(
    body,
    /public\.phx_marketing_roi_latest_validated_period\s*\(\s*\)/i,
    `${file}: the window's cut-off must come from phx_marketing_roi_latest_validated_period(), not a literal month`,
  );

  // The window end: pay month + (roi_duration_months - 1) months, compared as YYYY-MM text. A
  // request whose window ends AFTER the validated month is still being measured.
  assert.match(
    body,
    /make_interval\(months\s*=>\s*greatest\(coalesce\([a-z_]*\.?roi_duration_months,\s*1\),\s*1\)\s*-\s*1\)/i,
    `${file}: the window end must be pay month + roi_duration_months - 1`,
  );
  // roi_duration_months is NOT on the stored fact row — reading it from marketing_requests is what
  // makes the arm computable at all, and dropping that join is the silent way to lose it.
  assert.match(
    body,
    /join\s+marketing_requests\s+\w+\s+on\s+\w+\.id\s*=\s*rf\.request_id/i,
    `${file}: roi_duration_months must be joined from marketing_requests (the fact row has no such column)`,
  );

  const onTrack = body.indexOf("'on_track'");
  const awaiting = body.indexOf("'awaiting_data'");
  const behind = body.indexOf("'behind'");
  const noData = body.indexOf("'no_data'");
  assert.ok(awaiting > 0, `${file}: the fast RPC must have an 'awaiting_data' arm — THE defect of 2026-10-09`);
  assert.ok(
    onTrack > 0 && onTrack < awaiting && awaiting < behind && awaiting < noData,
    `${file}: the arms must read on_track → awaiting_data → behind → no_data; awaiting_data placed ` +
      `after 'behind' or 'no_data' never fires, which is indistinguishable from not having it ` +
      `(on_track ${onTrack}, awaiting_data ${awaiting}, behind ${behind}, no_data ${noData})`,
  );
  // on_track needs sales: a request with no rows at all and a zero required value must not be
  // declared a success by arithmetic.
  assert.match(
    body,
    /sales_rows\s*>\s*0\s*\n?\s*and\s+\w+\.actual_sales_value\s*>=\s*\w+\.required_roi_value\s*then\s*'on_track'/i,
    `${file}: on_track requires attributed sales AND the required value, as resolveRoiResultStatus does`,
  );

  // ── The verdict the caller SEES is the one it can filter on ──────────────────────────────────
  // p_roi_statuses used to filter the STORED column while the payload carried the recomputed one,
  // so once the two can disagree a filtered view would contradict the unfiltered one.
  assert.doesNotMatch(
    body,
    /rf\.actual_roi_status\s*=\s*any\(p_roi_statuses\)/i,
    `${file}: the status filter must not read the STORED fact column — this function recomputes the verdict`,
  );
  assert.match(
    body,
    /fr_status\.actual_roi_status\s*=\s*any\(p_roi_statuses\)/i,
    `${file}: the status filter must select on the status this function computes`,
  );
  // And the status is offered on the dashboard's own filter panel, with the shared label.
  assert.match(
    body,
    /jsonb_build_object\('value','awaiting_data','label','Data pending'\)/,
    `${file}: 'Data pending' must be a selectable ROI status, spelled as ROI_RESULT_STATUS_LABEL spells it`,
  );

  // An open window is not money at risk: spendAtRisk and noDataSpend stay on behind/no_data only.
  assert.match(
    body,
    /filter\s*\(where\s+actual_roi_status\s+in\s*\('behind','no_data'\)\)/i,
    `${file}: spend at risk must count behind and no_data only, never an awaiting request's cost`,
  );

  // ── What the migration must not lose while carrying the change ───────────────────────────────
  const migration = readFileSync(new URL(file, MIGRATION_DIRS[1]!), "utf8");
  assert.match(
    migration,
    /SET statement_timeout TO '45s'/i,
    `${file}: CREATE OR REPLACE drops a timeout set by ALTER FUNCTION — it must be re-declared here`,
  );
  assert.match(
    migration,
    /revoke\s+execute\s+on\s+function\s+public\.phx_marketing_roi_fast\(([\s\S]*?)\)\s*from\s+public,\s*anon,\s*authenticated/i,
    `${file}: a public SECURITY DEFINER function must revoke execute from public, anon, authenticated`,
  );
  assert.match(
    migration,
    /grant\s+execute\s+on\s+function\s+public\.phx_marketing_roi_fast\(([\s\S]*?)\)\s*to\s+service_role/i,
    `${file}: revoking PUBLIC strips service_role too — it must be re-granted`,
  );
  // It is a reader. Nothing in it may write a fact row or touch the sales tables.
  assert.doesNotMatch(migration, /\b(insert\s+into|update\s+|delete\s+from|truncate)\b/i, `${file}: the fast RPC writes nothing`);

  // ── The dashboard renders it, through the shared label ───────────────────────────────────────
  assert.equal(
    ROI_RESULT_STATUS_LABEL.awaiting_data,
    ROI_DATA_PENDING_LABEL,
    "awaiting_data reads 'Data pending' everywhere, from one shared label",
  );
  const service = stripComments(readFileSync("src/lib/sales-marketing-intelligence/service.ts", "utf8"));
  assert.match(
    service,
    /value === "awaiting_data"/,
    "the dashboard's status normalizer must accept awaiting_data, or the RPC's new verdict degrades to no_data",
  );
  const dashboard = stripComments(
    readFileSync("src/components/sales-marketing-intelligence/sales-marketing-intelligence-dashboard-impl.tsx", "utf8"),
  );
  assert.match(dashboard, /ROI_RESULT_STATUS_LABEL\[status\]/, "the badge takes its wording from the shared label map");
  assert.match(dashboard, /awaiting_data:\s*"[^"]+"/, "the badge must have an awaiting_data style, or it renders unstyled");
}
