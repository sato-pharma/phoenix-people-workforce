import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { roiMonthsWarning, ROI_MONTHS_PLAUSIBLE_MAX } from "../src/lib/marketing-requests/roi-duration.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * What "sales loaded through …" is allowed to mean, and the ROI duration warning beside it.
 *
 * Both come from the owner's 2026-10-02 audit of the ROI tracker: he was sure it was not reading
 * sales at all. It was — 35 of 45 campaigns match real invoice rows — but the completeness flag
 * was lying about September, which turned three campaigns into verdicts of failure.
 */
export function runMarketingRoiSalesDataAsOfTests() {
  // ── The ROI duration warns and never caps ────────────────────────────────────────────────────
  assert.equal(roiMonthsWarning(3), null, "three months is ordinary");
  assert.equal(roiMonthsWarning(ROI_MONTHS_PLAUSIBLE_MAX), null, "the threshold itself is still plausible");
  assert.equal(roiMonthsWarning(""), null, "an empty field is not a mistake, it is unfinished");
  assert.equal(roiMonthsWarning("abc"), null, "a non-number is the input's problem, not this one's");
  assert.equal(roiMonthsWarning(0), null, "zero is refused elsewhere; warning about it here would be noise");
  // The real row that prompted this: 312 months on a live 10,000 EGP campaign.
  assert.match(String(roiMonthsWarning(312)), /312 months is 26 years/, "an implausible value is named in years");
  assert.match(String(roiMonthsWarning(312)), /Nothing stops you saving it/, "and says plainly that it is not a refusal");

  // 🔴 NO CAP, ANYWHERE. The owner asked for this at the entry and explicitly not as a cap, so a
  //    maximum appearing in the normalizer or in the attribution window is the thing to catch.
  const service = stripComments(readFileSync("src/lib/marketing-requests/service.ts", "utf8"));
  const normalizer = service.slice(service.indexOf("export function normalizeMarketingRequestDraftInput"));
  const normalizerBody = normalizer.slice(0, normalizer.indexOf("\n}\n") + 1);
  assert.ok(normalizerBody.length > 0, "the normalizer slice must find its markers");
  assert.doesNotMatch(
    normalizerBody,
    /Math\.min|ROI_MONTHS_PLAUSIBLE_MAX|roiDurationMonths\s*>\s*\d+/,
    "the ROI duration must not be capped or clamped when the draft is saved",
  );

  // ── "Sales loaded through" means LOADED ──────────────────────────────────────────────────────
  const roi = stripComments(readFileSync("src/lib/marketing-requests/roi-report-service.ts", "utf8"));
  const fetcher = roi.slice(roi.indexOf("export async function loadLatestValidatedPeriod"));
  const fetcherBody = fetcher.slice(0, fetcher.indexOf("\n}\n") + 1);
  const picker = stripComments(readFileSync("src/lib/marketing-requests/roi-frontier.ts", "utf8"));
  // The reader is the fetch plus the pure picker it hands the rows to — together they are the rule.
  const readerBody = fetcherBody + picker;
  assert.ok(readerBody.length > 0 && fetcherBody.length > 0 && fetcherBody.length < roi.length / 4, "the reader slice must find its markers");

  // 🔴 THE BUG THIS REPLACES: `max(period)` over validated batches. On 2026-10-02 that answered
  //    2026-09 from ONE batch of eighteen — 41 rows against August's ~44,500 — and three campaigns
  //    whose window is exactly 2026-09 were reported as having sold nothing.
  // Asserted on the SELECT LIST, not merely on the word appearing somewhere in the body: dropping
  // `distributor_code` from the query while leaving it in the destructuring below is exactly the
  // shape this regresses to, and a looser check passes straight through it. Found by breaking it.
  assert.match(
    readerBody,
    /\.select\("period, distributor_code, template_key"\)/,
    "the fallback asks the database WHICH distributors filed, not just which periods exist",
  );
  assert.doesNotMatch(
    readerBody,
    /order\("invoice_period", \{ ascending: false \}\)/,
    "the newest period any row mentions is not the question any more",
  );

  // 🔴 THE BAR IS THE EVERY-MONTH SET, NEVER A HEADCOUNT — "not every distributor uploads every
  //    month" is a standing owner rule, and a count would mark a month incomplete for ever the
  //    moment one feed stops.
  assert.match(readerBody, /everyMonth/, "completeness is judged against the distributors who file every month");
  assert.doesNotMatch(readerBody, /\.size\s*>=|\.length\s*>=\s*\d+/, "never against a threshold number of distributors");
  // Measured over the SETTLED months only: letting the newest month vote would mean one early
  // file defines the bar it then passes.
  assert.match(readerBody, /months\.slice\(0, -1\)/, "the every-month set excludes the month being judged");
  assert.match(readerBody, /months\.length === 1/, "one month of history falls back rather than reporting nothing");

  // ── The migration says the same thing ────────────────────────────────────────────────────────
  const migration = readFileSync("supabase/migrations/20261002133311_roi_sales_data_asof_every_month_set.sql", "utf8");
  assert.match(migration, /create or replace function public\.phx_marketing_roi_latest_validated_period/, "it replaces the helper");
  assert.match(migration, /every_month/, "with the same every-month-set rule the TypeScript mirror uses");
  assert.match(migration, /notify pgrst/, "and reloads the schema cache");
  assert.doesNotMatch(migration, /drop function/i, "replacing in place, so nothing calling it breaks mid-deploy");
}
