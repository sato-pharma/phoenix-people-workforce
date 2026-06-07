/**
 * Local iReports360 → Field Workforce Compliance pull.
 *
 * Vercel's servers cannot reach the iReports360 CRM (it blocks datacenter IPs), so the
 * "Import from iReports360" button fails with "fetch failed". This script runs the SAME
 * build on a machine that CAN reach the CRM (the office network) and saves the month to
 * the database, so the website + Deductions Governance read it.
 *
 * Usage (from the repo root, with a populated .env.local):
 *   node --env-file=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/fwc-pull.ts <month 1-12> <year> [--commit]
 *
 * Without --commit it is a DRY RUN (builds, saves nothing). With --commit it writes the
 * monthly archive to Supabase (the same thing the import button would do).
 */
import {
  archiveFieldWorkforceCompliancePreview,
  FieldWorkforceArchiveDuplicateError,
} from "@/lib/field-workforce-compliance/archive";
import { buildFieldWorkforceCompliancePreviewFromIReports360 } from "@/lib/field-workforce-compliance/ireports360-source";

const month = Number(process.argv[2]);
const year = Number(process.argv[3]);
const commit = process.argv.includes("--commit");

if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000 || year > 2100) {
  console.error("Usage: fwc-pull <month 1-12> <year> [--commit]");
  process.exit(1);
}

const label = `${year}-${String(month).padStart(2, "0")}`;
const todayIso = new Date().toISOString().slice(0, 10);

console.log(`[fwc-pull] Building Field Workforce Compliance for ${label} from iReports360 ...`);
const preview = await buildFieldWorkforceCompliancePreviewFromIReports360({ month, todayIso, year });
console.log(
  `[fwc-pull] Built: employees=${preview.metadata.employeeCount}, ` +
    `reviewCandidates=${preview.reviewCandidates.length}, warnings=${preview.warnings.length}`,
);

if (!commit) {
  console.log("[fwc-pull] DRY RUN — nothing was saved. Re-run with --commit to write it to the database.");
  process.exit(0);
}

try {
  const archive = await archiveFieldWorkforceCompliancePreview({
    actorLoginId: "local-pull",
    preview,
    uploadedBy: "local-pull",
  });
  const id = (archive as { id?: string; monthKey?: string }).id ?? "(ok)";
  const monthKey = (archive as { monthKey?: string }).monthKey ?? label;
  console.log(`[fwc-pull] SAVED archive for ${monthKey} (id=${id}). The website + Deductions now have this month.`);
} catch (error) {
  if (error instanceof FieldWorkforceArchiveDuplicateError) {
    console.log(`[fwc-pull] ${label} is already archived. Remove/replace it in the app to re-pull.`);
  } else {
    throw error;
  }
}
process.exit(0);
