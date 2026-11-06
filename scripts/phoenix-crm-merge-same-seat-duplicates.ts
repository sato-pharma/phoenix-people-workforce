/**
 * ONE-OFF OPS SCRIPT — merge one rep's same-person duplicate rows in Phoenix CRM.
 *
 * Owner's ruling, 2026-10-08: "auto-merge the proven duplicates, with a pre-image and a report".
 * The set is EXACTLY the duplicates board's (`groupSameRepDuplicates`, server/duplicate-customers.ts):
 * real rows only, status active/pending/outside, one seat, one list type, one folded name, no
 * speciality conflict. The keep rule is `planMerge` (src/lib/phoenix-crm/duplicate-merge-rules.ts);
 * the write is `public.phoenix_crm_merge_duplicate_customer`, one transaction per group.
 *
 * DRY RUN IS THE DEFAULT. It reads production and writes three files OUTSIDE the repository, into
 * F:\PHX backup\phoenix-crm-duplicate-merge-<date>\ (never `xlsx/`, where no file may ever be deleted):
 *   report.xlsx      — Merged · Refused · Totals, names only: no customer id, seat code or HR id.
 *   merge-plan.json  — the keeper and losers of every group, by id, for --apply.
 *   pre-image.sql    — creates phoenix_crm_merge_backup_<date> (anon and authenticated revoked) holding
 *                      every customer row and every child row the merge would touch.
 *
 * --apply is a BULK PRODUCTION CHANGE. Before it runs: announce it in plain words (AGENTS.md §8), take
 * the pre-image (`node scripts/apply-sql-file.mjs <folder>/pre-image.sql production`), and pass:
 *   --apply --plan=<folder>/merge-plan.json --pre-image=phoenix_crm_merge_backup_<date> --actor=<HR id>
 * It refuses unless the pre-image schema exists and holds every customer row the plan names.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs scripts/phoenix-crm-merge-same-seat-duplicates.ts [--out=<folder>]
 */
import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import postgres from "postgres";

import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { mergeRefusalText, planMerge, type MergeCandidate, type MergePlan } from "@/lib/phoenix-crm/duplicate-merge-rules";
import { territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { groupSameRepDuplicates } from "@/lib/phoenix-crm/server/duplicate-customers";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const DATE = "20261008";
const PRE_IMAGE_SCHEMA = `phoenix_crm_merge_backup_${DATE}`;
const MERGE_NOTE = "The same customer was on this list twice; merged into the one row kept (owner's ruling, 8 October 2026)";
const CHILD_TABLES = [
  "phoenix_crm_places",
  "phoenix_crm_visits",
  "phoenix_crm_validation_reviews",
  "phoenix_crm_plan_items",
  "phoenix_crm_unplanned_visits",
  "phoenix_crm_visit_asks",
  "phoenix_crm_list_requests",
] as const;

const arg = (name: string): string | null => {
  const hit = process.argv.find((entry) => entry === `--${name}` || entry.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
};
const known = new Set(["apply", "plan", "pre-image", "actor", "out"]);
for (const entry of process.argv.slice(2)) {
  const name = entry.replace(/^--/, "").split("=")[0];
  if (!known.has(name)) throw new Error(`Unknown flag ${entry} — refused rather than ignored.`);
}

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
  return trimmed.length > 0 ? trimmed : null;
};

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostgREST builder, chained by each caller
async function readAll(table: string, columns: string, apply: (query: any) => any): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(getSupabaseAdmin().from(table).select(columns))
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) return rows;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostgREST builder, chained by each caller
async function countBy(table: string, ids: string[], extra?: (query: any) => any): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const part of chunk(ids, 150)) {
    const rows = await readAll(table, "id, customer_id", (query) => {
      const base = query.in("customer_id", part);
      return extra ? extra(base) : base;
    });
    for (const row of rows) counts.set(String(row.customer_id), (counts.get(String(row.customer_id)) ?? 0) + 1);
  }
  return counts;
}

async function loadSeats(): Promise<Map<string, OrgSeat>> {
  const data = await fetchAllRows<Row>(
    () =>
      getSupabaseAdmin()
        .from("au_v_org_tree")
        .select("seat_id, parent_seat_id, seat_tier, path, occupant_hr_id, line_code, line_name, area_code, area_name, region_name, seat_label"),
    "seat_id",
  );
  const seats = new Map<string, OrgSeat>();
  for (const row of data) {
    const seatId = text(row.seat_id);
    if (!seatId) continue;
    seats.set(seatId, {
      seatId,
      parentSeatId: text(row.parent_seat_id),
      tier: text(row.seat_tier) ?? "",
      path: [seatId],
      occupantHrId: text(row.occupant_hr_id),
      lineCode: text(row.line_code),
      lineName: text(row.line_name),
      areaCode: text(row.area_code),
      areaName: text(row.area_name),
      regionName: text(row.region_name),
      seatLabel: text(row.seat_label),
    });
  }
  return seats;
}

type GroupPlan = { seatId: string; plan: MergePlan };

async function buildPlans(): Promise<GroupPlan[]> {
  const customers = await readAll(
    "phoenix_crm_customers",
    "id, name, speciality, grade, potential_grade, phone, primary_pharmacy_name, list_type, seat_id, validated_at, created_at",
    (query) => query.eq("is_test", false).in("status", ["active", "pending", "outside"]),
  );
  const bySeat = new Map<string, Array<{ kind: "AM" | "PM" | "pharmacy"; name: string; source: "phoenix_crm"; sourceId: string; speciality: string | null }>>();
  const byId = new Map<string, Row>();
  for (const row of customers) {
    const seatId = text(row.seat_id);
    const name = text(row.name);
    if (!seatId || !name) continue;
    byId.set(String(row.id), row);
    const listType = text(row.list_type);
    const held = bySeat.get(seatId) ?? [];
    held.push({
      kind: listType === "Pharmacy" ? "pharmacy" : listType === "AM" ? "AM" : "PM",
      name,
      source: "phoenix_crm",
      sourceId: String(row.id),
      speciality: text(row.speciality),
    });
    bySeat.set(seatId, held);
  }

  const groups: Array<{ seatId: string; ids: string[] }> = [];
  for (const [seatId, candidates] of bySeat) {
    for (const group of groupSameRepDuplicates(candidates).values()) groups.push({ seatId, ids: group.map((entry) => entry.sourceId) });
  }
  const ids = groups.flatMap((group) => group.ids);
  const [activePlaces, visits, moves] = await Promise.all([
    countBy("phoenix_crm_places", ids, (query) => query.eq("status", "active")),
    countBy("phoenix_crm_visits", ids),
    countBy("phoenix_crm_customer_moves", ids),
  ]);

  return groups
    .map(({ seatId, ids: groupIds }) => {
      const rows: MergeCandidate[] = groupIds.map((id) => {
        const row = byId.get(id) as Row;
        return {
          customerId: id,
          name: String(row.name ?? ""),
          listType: String(row.list_type ?? ""),
          activePlaces: activePlaces.get(id) ?? 0,
          validatedAt: text(row.validated_at),
          visits: visits.get(id) ?? 0,
          createdAt: String(row.created_at),
          hasMoves: (moves.get(id) ?? 0) > 0,
          grade: text(row.grade),
          potentialGrade: text(row.potential_grade),
          phone: text(row.phone),
          primaryPharmacyName: text(row.primary_pharmacy_name),
        };
      });
      return { seatId, plan: planMerge(rows) };
    })
    .sort((left, right) => left.seatId.localeCompare(right.seatId));
}

function preImageSql(ids: string[]): string {
  const list = ids.map((id) => `'${id.replace(/[^0-9a-f-]/gi, "")}'`).join(",\n  ");
  const lines = [
    `-- Pre-image for the Phoenix CRM same-seat duplicate merge. Production has NO PITR; this schema is the`,
    `-- whole way back. A dated schema of its own, never public (scripts/check-sql-backup-placement.ts).`,
    `create schema if not exists ${PRE_IMAGE_SCHEMA};`,
    `revoke all on schema ${PRE_IMAGE_SCHEMA} from anon, authenticated;`,
    `create table ${PRE_IMAGE_SCHEMA}.phoenix_crm_customers as select * from public.phoenix_crm_customers where id in (\n  ${list}\n);`,
    ...CHILD_TABLES.map(
      (table) => `create table ${PRE_IMAGE_SCHEMA}.${table} as select * from public.${table} where customer_id in (\n  ${list}\n);`,
    ),
    `revoke all on all tables in schema ${PRE_IMAGE_SCHEMA} from anon, authenticated;`,
  ];
  return `${lines.join("\n")}\n`;
}

async function writeReport(folder: string, plans: GroupPlan[]): Promise<void> {
  const seats = await loadSeats();
  const people = await loadPeopleNames([...seats.values()].map((seat) => seat.occupantHrId));
  const repOf = (seatId: string) => nameOf(people, seats.get(seatId)?.occupantHrId ?? null, "No rep in this territory");
  const territoryOf = (seatId: string) => {
    const seat = seats.get(seatId);
    return seat ? territoryName(seat) : "Territory not in the organogram";
  };

  const book = new ExcelJS.Workbook();
  const merged = book.addWorksheet("Merged");
  merged.columns = [
    { header: "Rep", width: 28 },
    { header: "Territory", width: 32 },
    { header: "List", width: 10 },
    { header: "Row kept", width: 32 },
    { header: "Rows archived as duplicate", width: 40 },
    { header: "Why this row is kept", width: 34 },
    { header: "Places moved onto it", width: 12 },
    { header: "Visits moved onto it", width: 12 },
    { header: "Validated", width: 22 },
    { header: "Values on an archived row that are NOT copied", width: 50 },
  ];
  const refused = book.addWorksheet("Refused");
  refused.columns = [
    { header: "Rep", width: 28 },
    { header: "Territory", width: 32 },
    { header: "Names", width: 50 },
    { header: "Why it is not merged", width: 60 },
  ];
  let rowsLeaving = 0;
  let placesMoving = 0;
  let visitsMoving = 0;
  for (const { seatId, plan } of plans) {
    if (!plan.ok) {
      refused.addRow([repOf(seatId), territoryOf(seatId), plan.rows.map((row) => row.name).join(" / "), mergeRefusalText(plan.refused)]);
      continue;
    }
    const places = plan.losers.reduce((sum, row) => sum + row.activePlaces, 0);
    const visits = plan.losers.reduce((sum, row) => sum + row.visits, 0);
    rowsLeaving += plan.losers.length;
    placesMoving += places;
    visitsMoving += visits;
    merged.addRow([
      repOf(seatId),
      territoryOf(seatId),
      plan.keeper.listType,
      plan.keeper.name,
      plan.losers.map((row) => row.name).join(" / "),
      plan.why,
      places,
      visits,
      plan.keeper.validatedAt ? formatPhoenixDateTime(plan.keeper.validatedAt) : "Not validated yet",
      plan.notCopied.map((entry) => `${entry.field} ${entry.value} (on ${entry.fromName})`).join("; ") || "Nothing",
    ]);
  }
  const totals = book.addWorksheet("Totals");
  totals.columns = [{ header: "What", width: 48 }, { header: "How many", width: 14 }];
  const ok = plans.filter((entry) => entry.plan.ok);
  totals.addRows([
    ["Groups found on the duplicates board's own rule", plans.length],
    ["Groups that would merge", ok.length],
    ["Groups refused (see the Refused sheet)", plans.length - ok.length],
    ["Rows that would come off the lists into the Archive", rowsLeaving],
    ["Territories involved", new Set(plans.map((entry) => entry.seatId)).size],
    ["Active places moved onto a kept row", placesMoving],
    ["Visits moved onto a kept row", visitsMoving],
  ]);
  for (const sheet of [merged, refused, totals]) {
    sheet.getRow(1).font = { bold: true };
    sheet.eachRow((row) => row.eachCell((cell) => (cell.alignment = { wrapText: true, vertical: "top" })));
  }
  await book.xlsx.writeFile(path.join(folder, "report.xlsx"));
  console.log(JSON.stringify({ groups: plans.length, merging: ok.length, refused: plans.length - ok.length, rowsLeaving, placesMoving, visitsMoving }));
}

async function verifyPreImage(schema: string, customerIds: string[]): Promise<void> {
  if (!/^phoenix_crm_merge_backup_\d{8}$/.test(schema)) throw new Error(`--pre-image must name a dated backup schema, not ${schema}`);
  const raw = process.env.PHOENIX_PRODUCTION_DATABASE_URL;
  if (!raw) throw new Error("PHOENIX_PRODUCTION_DATABASE_URL is needed to read the pre-image back");
  // The direct `db.<ref>.supabase.co` host does not resolve from this laptop (ENOTFOUND, 2026-10-08,
  // on the first --apply — refused before any write). Rewrite it to the session pooler exactly as
  // scripts/apply-sql-file.mjs does; a URL already in pooler form passes through untouched.
  const direct = /^(\w+):\/\/([^:]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co:(\d+)\/(.+)$/.exec(raw);
  const host = process.env.PHOENIX_POOLER_HOST?.trim() || "aws-0-eu-central-1.pooler.supabase.com";
  const url = direct ? `${direct[1]}://${direct[2]}.${direct[4]}:${direct[3]}@${host}:5432/${direct[6]}` : raw;
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const [{ held }] = await sql.unsafe(
      `select count(*)::int as held from ${schema}.phoenix_crm_customers where id = any($1::uuid[])`,
      [customerIds],
    );
    if (held !== customerIds.length) {
      throw new Error(`The pre-image holds ${held} of the ${customerIds.length} customer rows the plan names — refused`);
    }
    for (const table of CHILD_TABLES) await sql.unsafe(`select 1 from ${schema}.${table} limit 1`);
    console.log(JSON.stringify({ preImage: schema, customers: held, children: CHILD_TABLES.length }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const folder = arg("out") ?? path.join("F:", "PHX backup", `phoenix-crm-duplicate-merge-${DATE}`);
  fs.mkdirSync(folder, { recursive: true });

  if (arg("apply") === null) {
    const plans = await buildPlans();
    const merging = plans.filter((entry) => entry.plan.ok);
    const planFile = merging.map((entry) =>
      entry.plan.ok ? { keeperId: entry.plan.keeper.customerId, loserIds: entry.plan.losers.map((row) => row.customerId) } : null,
    );
    const ids = merging.flatMap((entry) => (entry.plan.ok ? [entry.plan.keeper, ...entry.plan.losers].map((row) => row.customerId) : []));
    fs.writeFileSync(path.join(folder, "merge-plan.json"), `${JSON.stringify(planFile, null, 2)}\n`);
    fs.writeFileSync(path.join(folder, "pre-image.sql"), preImageSql(ids));
    await writeReport(folder, plans);
    console.log(`DRY RUN — nothing was written to the database. Files in ${folder}`);
    return;
  }

  const planPath = arg("plan");
  const schema = arg("pre-image");
  const actor = (arg("actor") ?? "").toUpperCase();
  if (!planPath || !schema || !/^[A-Z]+-\d+$/.test(actor)) {
    throw new Error("--apply needs --plan=<merge-plan.json>, --pre-image=<schema> and --actor=<HR id>");
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Array<{ keeperId: string; loserIds: string[] }>;
  await verifyPreImage(schema, plan.flatMap((group) => [group.keeperId, ...group.loserIds]));

  const outcomes: Array<{ keeperId: string; ok: boolean; result: unknown }> = [];
  for (const group of plan) {
    const { data, error } = await getSupabaseAdmin().rpc("phoenix_crm_merge_duplicate_customer", {
      p: { actor_hr_id: actor, keeper_id: group.keeperId, loser_ids: group.loserIds, note: MERGE_NOTE },
    });
    outcomes.push({ keeperId: group.keeperId, ok: !error, result: error ? error.message : data });
  }
  fs.writeFileSync(path.join(folder, "applied.json"), `${JSON.stringify(outcomes, null, 2)}\n`);
  console.log(JSON.stringify({ applied: outcomes.filter((entry) => entry.ok).length, refused: outcomes.filter((entry) => !entry.ok).length }));
}

await main();
