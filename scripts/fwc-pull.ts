/**
 * OBSOLETE — kept only as a read-only dry-run tool pending an owner decision to delete it.
 *
 * This script existed because Vercel's servers could not reach the iReports360 CRM, so the
 * old "Import from iReports360" button failed with "fetch failed"; running the pull from
 * the office network and archiving the result was the workaround. Field Workforce
 * Compliance no longer calls the CRM directly at all — it reads the ireports360_visits
 * mirror table that visits-report already syncs automatically (cron + backfill), so this
 * workaround's entire reason to exist is gone.
 *
 * The --commit path has been removed on purpose: it used to archive CRM-sourced data into
 * field_workforce_compliance_imports/_days/_monthly_summary, which is now Excel-upload-only
 * by design (see src/lib/field-workforce-compliance/archive.ts) — re-enabling it here would
 * silently resurrect the exact problem this change fixed. This file is scoped to be
 * deleted; it is left in place only because deleting it wasn't part of the reviewed change
 * and needs an explicit owner call.
 *
 * Usage (from the repo root, with a populated .env.local; dry run only):
 *   node --env-file=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/fwc-pull.ts <month 1-12> <year>
 */
import { cairoTodayIso } from "@/lib/crm/dates";
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "fwc-pull",
  entry: import.meta.url,
  known: [],
});

const month = Number(process.argv[2]);
const year = Number(process.argv[3]);

if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000 || year > 2100) {
  console.error("Usage: fwc-pull <month 1-12> <year>");
  process.exit(1);
}

const label = `${year}-${String(month).padStart(2, "0")}`;
// Africa/Cairo, not UTC. This is compared against CRM visit dates (ireports360-source.ts
// `dateIso > todayIso`), and vendor timestamps are stored as Cairo wall-clock — see
// crm/vendor-row-types.ts. A UTC "today" runs a day behind for the ~3 hours after Cairo midnight, which
// makes the current day read as "not happened yet" (blank) instead of "no visits" ("N").
const todayIso = cairoTodayIso();

console.log(`[fwc-pull] Building Field Workforce Compliance for ${label} from the visits mirror ...`);
const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({ month, todayIso, year });
console.log(
  `[fwc-pull] Built: employees=${preview.metadata.employeeCount}, ` +
    `reviewCandidates=${preview.reviewCandidates.length}, warnings=${preview.warnings.length}`,
);
console.log("[fwc-pull] DRY RUN ONLY — this script no longer writes anything. Delete it once confirmed unneeded.");
process.exit(0);
