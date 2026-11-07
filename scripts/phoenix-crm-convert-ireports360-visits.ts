/**
 * ONE-OFF OPS SCRIPT — turn the iReports360 visits copied into Phoenix CRM into real Phoenix visits, and fill
 * the visits archive.
 *
 * Owner, 7 Nov 2026: every old regular visit with a check-in location becomes a Phoenix visit "as if submitted
 * on Phoenix" — the check-in's position is the visit's, measured against the customer's validated place today
 * (every active place, nearest first, the line `visit_far_meters`). A visit to a customer with a validated
 * place counts in visits and KPIs when its check-in lay within visit_far_meters of it; one that lay FARTHER is
 * archived as far, with its distance (the trigger phoenix_crm_visits_old_system_kpi does it on the write, and
 * again on any later restamp). One to a customer with no place is shown and not counted. Campaign visits
 * are retired, and a visit with no check-in location is not a visit: both go to the visits archive
 * (phoenix_crm_visit_archive), and a copied row of either kind is marked archived — NEVER deleted.
 * The rules and the rollback: docs/phoenix-crm-ireports360-history-import.md, "The conversion".
 *
 * Two database steps (supabase/migrations/20261107044059_phoenix_crm_old_visits_convert_and_archive.sql):
 *   1. public.phoenix_crm_prepare_ireports360_conversion(p_apply) — matches every regular old visit to its
 *      check-in, fills the archive, and marks the copied rows that are not visits.
 *   2. for every copied, not archived row, page by page: public.phoenix_crm_ireports360_conversion_page gives
 *      the row, its matched check-in and its customer's active places; this script measures them with
 *      src/lib/phoenix-crm/old-visit-conversion.ts (geo.ts's checkVisitLocation, the one distance rule), and
 *      public.phoenix_crm_apply_ireports360_conversion writes the place, distance and flag. The POSITION is
 *      the database's own: it takes it from the match table, never from this script. The counted flag is the
 *      trigger's (phoenix_crm_visits_old_system_kpi).
 *
 * DRY RUN IS THE DEFAULT: step 1 with p_apply false, and step 2 measured without a write. It saves
 * dry-run-<Cairo time>.json OUTSIDE the repository, in F:\PHX backup\phoenix-crm-ireports360-conversion-20261107\.
 * Before the first --apply the match table is empty, so the dry run's step 2 reads "no match yet" for every
 * row: step 1's counts are the forecast.
 *
 * --apply is a BULK PRODUCTION CHANGE (~57,000 visit rows measured, ~14,700 marked archived, ~4,650 more
 * archived as far, ~106,000 match rows, ~41,200 archive rows). Rolling a far row back to its earlier values
 * lifts the far mark and its archive rows by the same trigger. Announce it in plain words before it runs (AGENTS.md §8): production has NO
 * PITR. Step 1 runs in ONE transaction; step 2 one page per transaction, each refused and rolled back unless
 * the database wrote exactly the rows sent. Every row it changes is recorded first, with its earlier values,
 * in before-<Cairo time>.jsonl — the rollback. A second --apply sends only rows whose answer changed, so it
 * is safe to repeat; run it again after `--leavers --apply` of scripts/phoenix-crm-import-ireports360-history.ts.
 * Step 1's marks are recorded the same way first, in before-step1-<Cairo time>.jsonl.
 * --apply takes no value: --apply=, --apply=false and --apply=true are refused, and so is any flag it does not know.
 *
 * Usage:
 *   node --env-file-if-exists=.env.production.rls.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/phoenix-crm-convert-ireports360-visits.ts [--apply] [--out=<folder>]
 */
import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { convertOldVisitLocation, type OldVisitPlace } from "@/lib/phoenix-crm/old-visit-conversion";

type PageRow = {
  visit_id: string;
  customer_id: string;
  lat: number | null;
  lon: number | null;
  place_id: string | null;
  distance_meters: number | null;
  location_flag: string | null;
  checkin_id: number | null;
  kpi_counted: boolean;
  match: { checkin_id: number; lat: number; lon: number } | null;
  places: OldVisitPlace[];
};
type Item = { visit_id: string; checkin_id: number; place_id: string | null; distance_meters: number | null; location_flag: string };

const DATE = "20261107";
const PAGE = 1000;

const arg = (name: string): string | null => {
  const hit = process.argv.slice(2).find((entry) => entry === `--${name}` || entry.startsWith(`--${name}=`));
  if (hit === undefined) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
};
const known = new Set(["apply", "out"]);
for (const entry of process.argv.slice(2)) {
  const name = entry.replace(/^--/, "").split("=")[0];
  if (!entry.startsWith("--") || !known.has(name)) throw new Error(`Unknown flag ${entry} — refused rather than ignored.`);
}
// --apply is the bare word and nothing else: `--apply=`, `--apply=true` and `--apply=false` are all refused, so
// a value can never be read as a yes (risk review, 7 Nov 2026 — `--apply=` read as "" and applied).
const applyFlags = process.argv.slice(2).filter((entry) => entry === "--apply" || entry.startsWith("--apply="));
if (applyFlags.some((entry) => entry !== "--apply")) throw new Error(`--apply takes no value (got ${applyFlags.join(" ")}); leave it out for a dry run.`);
if (arg("out") === "") throw new Error("--out needs a value: --out=<folder> — refused rather than guessed.");
const APPLY = applyFlags.length > 0;
const FOLDER = arg("out") ?? path.join("F:", "PHX backup", `phoenix-crm-ireports360-conversion-${DATE}`);
const STAMP = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Africa/Cairo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})
  .format(new Date())
  .replace(/[ :]/g, "-");

const save = (name: string, data: unknown): string => {
  const file = path.join(FOLDER, `${name}-${STAMP}.json`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
  return file;
};

// The same connection rule as scripts/phoenix-crm-import-ireports360-history.ts (production's session pooler
// is aws-1; a password holding `@` still parses).
function connect(): postgres.Sql {
  const raw = process.env.PHOENIX_PRODUCTION_DATABASE_URL;
  if (!raw) throw new Error("PHOENIX_PRODUCTION_DATABASE_URL is needed — run with --env-file-if-exists=.env.production.rls.local");
  const direct = /^\w+:\/\/([^:]+):(.+)@db\.([a-z0-9]+)\.supabase\.co:(\d+)\/([^?]+)/.exec(raw);
  const options = { max: 1, prepare: false, onnotice: () => undefined };
  if (!direct) return postgres(raw, options);
  let password = direct[2];
  try {
    password = decodeURIComponent(password);
  } catch {
    // Not percent-encoded: it is the password as written.
  }
  return postgres({
    ...options,
    host: process.env.PHOENIX_POOLER_HOST?.trim() || "aws-1-eu-central-1.pooler.supabase.com",
    port: 5432,
    database: direct[5],
    username: `${direct[1]}.${direct[3]}`,
    password,
  });
}

const TIMEOUT = "set local statement_timeout = '15min'";

class PageMismatch extends Error {}

async function main(): Promise<void> {
  fs.mkdirSync(FOLDER, { recursive: true });
  const sql = connect();
  try {
    const [settings] = await sql.unsafe("select visit_far_meters from public.phoenix_crm_settings where id = 1");
    const farMeters = Number(settings?.visit_far_meters);
    if (!Number.isFinite(farMeters) || farMeters <= 0) throw new Error("phoenix_crm_settings.visit_far_meters is missing — refused rather than guessed.");

    // Step 1: one transaction — the matches, the archive and the archived marks land together or not at all.
    // Its rollback first, as step 2's: every copied row's archive fields BEFORE the marks, read inside the same
    // transaction, so the file holds exactly what the marks replace (risk review, 7 Nov 2026). Undo the marks
    // with it: set archived_at and archive_reason back to these values for these ids. The match and archive
    // rows step 1 adds carry its own matched_at / archived_at, one moment, so they are found by it.
    const stepOneBeforeFile = path.join(FOLDER, `before-step1-${STAMP}.jsonl`);
    const prepared = (await sql.begin(async (tx) => {
      await tx.unsafe(TIMEOUT);
      if (APPLY) {
        const marks = await tx.unsafe(
          "select id, archived_at, archive_reason from public.phoenix_crm_visits where imported_from_ireports360_at is not null order by id",
        );
        fs.writeFileSync(
          stepOneBeforeFile,
          marks.map((row) => JSON.stringify({ visit_id: row.id, archived_at: row.archived_at, archive_reason: row.archive_reason })).join("\n") + "\n",
          { flag: "wx" },
        );
      }
      const [row] = await tx.unsafe("select public.phoenix_crm_prepare_ireports360_conversion($1) as answer", [APPLY]);
      return row.answer;
    })) as Record<string, unknown>;
    console.log(JSON.stringify({ prepared }));

    // Step 2: every copied, not archived row, in id order.
    // far = archived as far by the trigger on the write (owner, 7 Nov 2026): never counted, never a visit row again.
    const tally = { rows: 0, noMatch: 0, unusableFix: 0, unchanged: 0, toWrite: 0, written: 0, ok: 0, far: 0, archivedFar: 0, noPlace: 0, counts: 0 };
    const beforeFile = path.join(FOLDER, `before-${STAMP}.jsonl`);
    if (APPLY) fs.writeFileSync(beforeFile, "", { flag: "wx" });
    let after: string | null = null;
    let stopped: string | null = null;
    for (;;) {
      const [pageRow] = await sql.unsafe("select public.phoenix_crm_ireports360_conversion_page($1::uuid, $2) as page", [after, PAGE]);
      const page = (pageRow.page ?? []) as PageRow[];
      if (page.length === 0) break;
      after = page[page.length - 1].visit_id;

      const items: Item[] = [];
      const before: PageRow[] = [];
      for (const row of page) {
        tally.rows += 1;
        if (!row.match) {
          tally.noMatch += 1;
          continue;
        }
        const answer = convertOldVisitLocation({
          checkin: { checkinId: Number(row.match.checkin_id), lat: Number(row.match.lat), lon: Number(row.match.lon) },
          places: (row.places ?? []).map((place) => ({ id: place.id, lat: Number(place.lat), lon: Number(place.lon) })),
          farMeters,
        });
        if (!answer) {
          tally.unusableFix += 1;
          continue;
        }
        if (answer.locationFlag === "ok") tally.ok += 1;
        else if (answer.locationFlag === "far") {
          tally.far += 1;
          if (answer.archiveReason === "far") tally.archivedFar += 1;
        }
        else tally.noPlace += 1;
        if (answer.kpiCounted) tally.counts += 1;
        const same =
          row.checkin_id !== null &&
          Number(row.checkin_id) === answer.checkinId &&
          row.lat !== null &&
          Number(row.lat) === Number(row.match.lat) &&
          row.lon !== null &&
          Number(row.lon) === Number(row.match.lon) &&
          (row.place_id ?? null) === answer.placeId &&
          (row.distance_meters === null ? null : Number(row.distance_meters)) === answer.distanceMeters &&
          row.location_flag === answer.locationFlag;
        if (same) {
          tally.unchanged += 1;
          continue;
        }
        items.push({
          visit_id: row.visit_id,
          checkin_id: answer.checkinId,
          place_id: answer.placeId,
          distance_meters: answer.distanceMeters,
          location_flag: answer.locationFlag,
        });
        before.push(row);
      }
      tally.toWrite += items.length;
      if (!APPLY || items.length === 0) continue;

      // The rollback first: every row's earlier values, before the write that changes them.
      fs.appendFileSync(
        beforeFile,
        before
          .map((row) =>
            JSON.stringify({
              visit_id: row.visit_id,
              lat: row.lat,
              lon: row.lon,
              place_id: row.place_id,
              distance_meters: row.distance_meters,
              location_flag: row.location_flag,
              checkin_id: row.checkin_id,
            }),
          )
          .join("\n") + "\n",
      );
      try {
        const written = (await sql.begin(async (tx) => {
          await tx.unsafe(TIMEOUT);
          const [row] = await tx.unsafe("select public.phoenix_crm_apply_ireports360_conversion($1::jsonb) as written", [JSON.stringify(items)]);
          const count = Number(row.written);
          // Thrown inside the transaction: a page that wrote a different number of rows is rolled back.
          if (count !== items.length) throw new PageMismatch(`sent ${items.length}, written ${count} — the page was rolled back`);
          return count;
        })) as number;
        tally.written += written;
      } catch (error) {
        stopped = `page after ${page[0].visit_id}: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
      console.log(`${tally.rows} row(s) read, ${tally.written} written`);
    }

    const record = { applied: APPLY, farMeters, prepared, conversion: tally, stopped, before: APPLY ? beforeFile : null, beforeStepOne: APPLY ? stepOneBeforeFile : null };
    const file = save(APPLY ? "applied" : "dry-run", record);
    console.log(JSON.stringify({ conversion: tally, stopped }));
    if (!APPLY) console.log(`DRY RUN — nothing was written to the database. File ${file}`);
    if (stopped) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
