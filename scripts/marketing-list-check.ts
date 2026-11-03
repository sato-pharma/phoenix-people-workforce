/**
 * OPS SCRIPT: the first run of the marketing list check, and his 27 October answers (owner, 2026-11-03).
 *
 * DRY RUN IS THE DEFAULT: it reads production, writes nothing there, and writes outside the repository
 * into F:\PHX backup\marketing-list-check-<date>\:
 *   comparison.xlsx  every customer's verdict beside his 27 Oct answer, disagreements first.
 *   plan.json        the verdicts and the seeded decisions.
 *   pre-image.sql    creates marketing_list_check_backup_<date>.customers with the list columns of every
 *                    customer the plan would change.
 *
 * --apply is a BULK PRODUCTION CHANGE. Announce it in plain words first (AGENTS.md §8), then:
 *   node scripts/apply-sql-file.mjs "<folder>/pre-image.sql" production
 *   ... scripts/marketing-list-check.ts --apply
 * It refuses unless the pre-image exists and holds every customer it would change.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs scripts/marketing-list-check.ts [--apply]
 */
import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import postgres from "postgres";

import { normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { applyMarketingListCheck, computeMarketingListCheck, type ListCheckPlanRow } from "@/lib/marketing-requests/crm-list-check";
import { compareNames } from "@/lib/marketing-requests/crm-list-check-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

refuseUnknownFlags({
  name: "marketing-list-check",
  entry: import.meta.url,
  known: ["--apply"],
});

const DATE = "20261103";
const OUT = path.join("F:\\PHX backup", `marketing-list-check-${DATE}`);
const PRE_IMAGE = `marketing_list_check_backup_${DATE}`;
const SHEET = "F:\\Claude Scratchpad Archive\\xlsx\\2026-10-27\\marketing-doctors-on-rep-lists (phoenix 718c6e08).xlsx";
const SEED_SOURCE = "owner_sheet_2026_10_27";

type SheetRow = { answer: string; decided: "on_list" | "not_on_list" | null; marketingArea: string; marketingName: string; open: boolean; repArea: string; repListName: string; repName: string; sheet: string; why: string };

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "richText" in (value as object)) {
    return (value as { richText: Array<{ text: string }> }).richText.map((part) => part.text).join("").trim();
  }
  return String(value).trim();
}

async function readSheet(): Promise<SheetRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(SHEET);
  const rows: SheetRow[] = [];
  for (const sheet of workbook.worksheets) {
    for (let at = 4; at <= sheet.rowCount; at += 1) {
      const row = sheet.getRow(at);
      const marketingName = cellText(row.getCell(1).value);
      if (!marketingName) continue;
      const answer = cellText(row.getCell(6).value);
      const why = cellText(row.getCell(7).value);
      const confirmed = /^You confirmed/.test(why);
      const refused = /^You decided: not the same/.test(why) || /^You marked this NO/.test(why);
      rows.push({
        answer,
        decided: confirmed ? "on_list" : refused ? "not_on_list" : null,
        marketingArea: cellText(row.getCell(3).value),
        marketingName,
        open: /You left this open/.test(why),
        repArea: cellText(row.getCell(4).value),
        repListName: cellText(row.getCell(2).value),
        repName: cellText(row.getCell(5).value),
        sheet: sheet.name,
        why,
      });
    }
  }
  return rows;
}

const SHEET_STATE: Record<string, string[]> = { CHECK: ["check"], NO: ["not_on_list", "no_holder", "left_list"], YES: ["on_list"] };

/** The rows of a customer in the plan, by his exact name, then his folded name. A name twice is told apart by area. */
function findPlanRows(plan: readonly ListCheckPlanRow[], row: SheetRow, storedAreaByCustomer: ReadonlyMap<string, string | null>): ListCheckPlanRow[] {
  const exact = plan.filter((entry) => entry.displayName.trim() === row.marketingName);
  const named = exact.length > 0 ? exact : plan.filter((entry) => normalizeContactName(entry.displayName) === normalizeContactName(row.marketingName));
  if (named.length <= 1) return named;
  const inArea = named.filter((entry) => storedAreaByCustomer.get(entry.customerId) === row.marketingArea || entry.areaName === row.repArea);
  return inArea.length > 0 ? inArea : named;
}

/** The customers the pre-image holds. Through Postgres: the API exposes no dated backup schema. */
async function preImageCustomerIds(): Promise<Set<string>> {
  const databaseUrl = process.env.SUPABASE_DB_URL;
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is missing, so the pre-image cannot be read.");
  const sql = postgres(databaseUrl, { connect_timeout: 20, max: 1, ssl: "require" });
  try {
    const rows = await sql.unsafe<Array<{ id: string }>>(`select id::text as id from ${PRE_IMAGE}.customers`);
    return new Set(rows.map((row) => row.id));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const sheet = await readSheet();
  const firstPass = await computeMarketingListCheck({ now });

  const customerIds = [...new Set(firstPass.map((row) => row.customerId))];
  const storedAreaRead = await supabase.from("marketing_customers").select("id, areas:area_id(name)").in("id", customerIds);
  if (storedAreaRead.error) throw storedAreaRead.error;
  const storedArea = new Map(
    ((storedAreaRead.data ?? []) as unknown as Array<{ id: string; areas: { name: string | null } | null }>).map((row) => [row.id, row.areas?.name ?? null]),
  );

  // His decisions, tied to the row of the rep's list he answered about. One that cannot be tied is reported, never guessed.
  const seeds: Array<{ customerId: string; decided: "on_list" | "not_on_list"; lineId: number | null; matchedId: string | null; matchedName: string | null }> = [];
  const unresolved: string[] = [];
  const candidateRead = async (planRow: ListCheckPlanRow, name: string) => {
    if (planRow.holderSeatIds.length === 0) return [];
    const read = await supabase
      .from("phoenix_crm_customers")
      .select("id, name, seat_id, list_type, status, reference_contact_crm_id, own_contact_crm_id")
      .in("seat_id", planRow.holderSeatIds)
      .eq("is_test", false)
      .eq("campaign_visit_holder", false)
      .in("status", ["active", "pending"])
      .in("list_type", ["AM", "PM"]);
    if (read.error) throw read.error;
    const rows = (read.data ?? []) as Array<{ id: string; name: string; own_contact_crm_id: number | null; reference_contact_crm_id: number | null }>;
    const exact = rows.filter((row) => normalizeContactName(row.name) === normalizeContactName(name));
    const close = exact.length > 0 ? exact : rows.filter((row) => ["same", "one_letter"].includes(compareNames(row.name, name)));
    return [...close].sort((left, right) => left.id.localeCompare(right.id));
  };
  for (const row of sheet) {
    if (!row.decided) continue;
    const planRows = findPlanRows(firstPass, row, storedArea);
    if (planRows.length !== 1) {
      unresolved.push(`${row.marketingName} (${row.marketingArea}): ${planRows.length} customers carry this name`);
      continue;
    }
    const planRow = planRows[0];
    if (row.decided === "not_on_list") {
      seeds.push({ customerId: planRow.customerId, decided: "not_on_list", lineId: planRow.lineId, matchedId: null, matchedName: row.repListName || null });
      continue;
    }
    const candidates = await candidateRead(planRow, row.repListName);
    const matched = candidates[0];
    if (!matched) {
      unresolved.push(`${row.marketingName} (${row.marketingArea}): "${row.repListName}" is not on a Phoenix CRM list of this area and line`);
      continue;
    }
    // One doctor on two reps' rows is still one answer; two doctors are never chosen between.
    if (new Set(candidates.map((candidate) => candidate.own_contact_crm_id ?? candidate.reference_contact_crm_id ?? candidate.id)).size > 1) {
      unresolved.push(`${row.marketingName} (${row.marketingArea}): "${row.repListName}" reads as more than one doctor on this list`);
      continue;
    }
    seeds.push({ customerId: planRow.customerId, decided: "on_list", lineId: planRow.lineId, matchedId: matched.id, matchedName: matched.name });
  }

  // The comparison.
  fs.mkdirSync(OUT, { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const compare = workbook.addWorksheet("Against 27 Oct");
  compare.columns = [
    { header: "Agree", key: "agree", width: 10 },
    { header: "Customer", key: "customer", width: 32 },
    { header: "Rep's list, 27 Oct", key: "sheetName", width: 32 },
    { header: "Rep's list, now", key: "planName", width: 32 },
    { header: "27 Oct answer", key: "answer", width: 10 },
    { header: "Now", key: "state", width: 14 },
    { header: "Line", key: "line", width: 14 },
    { header: "Area, 27 Oct", key: "sheetArea", width: 22 },
    { header: "Area, now", key: "planArea", width: 22 },
    { header: "Metres", key: "metres", width: 8 },
    { header: "Why, 27 Oct", key: "sheetWhy", width: 60 },
    { header: "Why, now", key: "planWhy", width: 60 },
  ];
  const seen = new Set<string>();
  const lines: Array<Record<string, unknown>> = [];
  let agreed = 0;
  let disagreed = 0;
  for (const row of sheet) {
    const planRows = findPlanRows(firstPass, row, storedArea);
    if (planRows.length === 0) {
      lines.push({ agree: "GONE", customer: row.marketingName, sheetName: row.repListName, answer: row.answer, sheetArea: row.marketingArea, sheetWhy: row.why });
      disagreed += 1;
      continue;
    }
    for (const planRow of planRows) {
      seen.add(`${planRow.customerId}|${planRow.lineId}`);
      const tied = seeds.some((seed) => seed.customerId === planRow.customerId && seed.lineId === planRow.lineId);
      const agree = tied || (SHEET_STATE[row.answer] ?? []).includes(planRow.verdict.state) || (row.open && planRow.verdict.state === "check");
      if (agree) agreed += 1;
      else disagreed += 1;
      lines.push({
        agree: agree ? "yes" : "NO",
        answer: row.answer,
        customer: row.marketingName,
        line: planRow.lineName,
        metres: planRow.verdict.metresApart,
        planArea: planRow.areaName,
        planName: planRow.verdict.matched?.name ?? null,
        planWhy: planRow.verdict.reason,
        sheetArea: row.marketingArea,
        sheetName: row.repListName,
        sheetWhy: row.why,
        state: tied ? `his answer: ${row.decided}` : planRow.verdict.state,
      });
    }
  }
  const fresh = firstPass.filter((row) => !seen.has(`${row.customerId}|${row.lineId}`));
  lines.sort((left, right) => String(left.agree === "yes").localeCompare(String(right.agree === "yes")));
  compare.addRows(lines);
  const newSheet = workbook.addWorksheet("Not on the 27 Oct sheet");
  newSheet.columns = [
    { header: "Customer", key: "customer", width: 32 },
    { header: "Now", key: "state", width: 14 },
    { header: "Rep's list", key: "planName", width: 32 },
    { header: "Line", key: "line", width: 14 },
    { header: "Area", key: "area", width: 22 },
    { header: "Why", key: "why", width: 60 },
  ];
  newSheet.addRows(fresh.map((row) => ({ area: row.areaName, customer: row.displayName, line: row.lineName, planName: row.verdict.matched?.name ?? null, state: row.verdict.state, why: row.verdict.reason })));
  const unresolvedSheet = workbook.addWorksheet("Answers not tied");
  unresolvedSheet.columns = [{ header: "Answer that could not be tied to a row", key: "text", width: 110 }];
  unresolvedSheet.addRows(unresolved.map((text) => ({ text })));
  await workbook.xlsx.writeFile(path.join(OUT, "comparison.xlsx"));
  fs.writeFileSync(path.join(OUT, "plan.json"), JSON.stringify({ firstPass, seeds, unresolved }, null, 1));
  const changing = firstPass.filter((row) => row.write).map((row) => row.customerId);
  fs.writeFileSync(
    path.join(OUT, "pre-image.sql"),
    [
      `create schema if not exists ${PRE_IMAGE};`,
      `revoke all on schema ${PRE_IMAGE} from public, anon, authenticated;`,
      `create table if not exists ${PRE_IMAGE}.customers as`,
      `  select id, crm_list_status, crm_list_source, phoenix_crm_customer_id from public.marketing_customers`,
      `  where active is not false and merged_into_customer_id is null and validation_status in ('system_validated', 'sfe_validated', 'admin_approved');`,
      `revoke all on all tables in schema ${PRE_IMAGE} from public, anon, authenticated;`,
      "",
    ].join("\n"),
  );

  const tally = new Map<string, number>();
  for (const row of firstPass) tally.set(row.verdict.state, (tally.get(row.verdict.state) ?? 0) + 1);
  console.log(`Customers x lines ${firstPass.length}; would change customer columns on ${changing.length}`);
  console.log(`States ${JSON.stringify(Object.fromEntries(tally))}`);
  console.log(`Against the 27 Oct sheet: ${agreed} agree, ${disagreed} disagree; ${fresh.length} not on that sheet`);
  console.log(`His decisions: ${seeds.length} tied, ${unresolved.length} not tied`);
  for (const text of unresolved) console.log(`  not tied: ${text}`);
  console.log(`Written to ${OUT}`);

  if (!apply) {
    console.log("DRY RUN: production was not changed.");
    return;
  }

  // Every customer this run could touch must be in the pre-image, so a stale one cannot pass on its size.
  const preImage = await preImageCustomerIds().catch((error: unknown) => {
    throw new Error(`Refused: the pre-image ${PRE_IMAGE}.customers could not be read (${error instanceof Error ? error.message : String(error)}).`);
  });
  const notInPreImage = customerIds.filter((id) => !preImage.has(id));
  if (notInPreImage.length > 0) {
    throw new Error(`Refused: ${notInPreImage.length} customers are not in the pre-image ${PRE_IMAGE}.customers. Re-run the dry run, then apply its pre-image.`);
  }

  // Store the verdicts, then his decisions, then re-run so his answers reach the customers' own columns.
  await applyMarketingListCheck(firstPass, now);
  for (const seed of seeds) {
    let query = supabase
      .from("marketing_customer_list_checks")
      .update({
        decided_at: now,
        decided_by_hr_id: "B-10",
        decided_source: SEED_SOURCE,
        decided_state: seed.decided,
        matched_crm_customer_id: seed.matchedId,
        matched_name: seed.matchedName,
        updated_at: now,
      })
      .eq("customer_id", seed.customerId)
      .is("decided_state", null); // A re-run never overwrites an answer given since.
    query = seed.lineId === null ? query.is("line_id", null) : query.eq("line_id", seed.lineId);
    const { error } = await query;
    if (error) throw error;
  }
  const secondPass = await computeMarketingListCheck();
  const written = await applyMarketingListCheck(secondPass);
  console.log(`APPLIED: ${written.checks} checks, ${written.customers} customers on the second pass, ${seeds.length} of his decisions.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
