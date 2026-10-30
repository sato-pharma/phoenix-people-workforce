/**
 * ONE-OFF OPS SCRIPT — copy every current Medical Rep's 2026 iReports360 visit history into Phoenix CRM.
 *
 * Owner, 2026-10-29: "I want to grab every rep now current in the company working. I want to grab his visit
 * history and put it in Phoenix CRM and make it as if it is a complete data." Regular visits are planned,
 * campaign visits unplanned; a doctor Phoenix does not have goes to the rep's Archive; a visit made on
 * another seat is not copied. The rules, the readers that skip the copy and the rollback are in
 * docs/phoenix-crm-ireports360-history-import.md. The write itself is ONE database function,
 * public.phoenix_crm_import_ireports360_history(p_seat, p_apply)
 * (supabase/migrations/20261029212200_phoenix_crm_imports_ireports360_history.sql), so this script only
 * asks it and keeps the record.
 *
 * DRY RUN IS THE DEFAULT. It asks the function for every seat at once (it writes nothing) and saves
 * dry-run.json OUTSIDE the repository, into F:\PHX backup\phoenix-crm-ireports360-history-<date>\.
 *
 * --apply is a BULK PRODUCTION CHANGE (~69,000 visit rows and ~2,500 Archive doctors). Before it runs,
 * announce it in plain words (AGENTS.md §8): production has NO PITR, and the rollback is the delete by
 * the marks in the migration's header. It runs the dry run again, then ONE seat per transaction, and
 * stops at the first seat whose written count is not its planned count. applied.json keeps every seat's
 * answer. A second --apply writes nothing: every old visit already copied is in
 * phoenix_crm_imported_visit_sources.
 *
 * Usage:
 *   node --env-file-if-exists=.env.production.rls.local --experimental-strip-types \
 *     scripts/phoenix-crm-import-ireports360-history.ts [--seat=<seat id>] [--apply] [--out=<folder>]
 */
import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";

type SeatAnswer = {
  seat_id: string;
  in_scope: number;
  already_imported: number;
  rows_to_write: number;
  merged_same_day: number;
  archive_doctors: number;
  holders: number;
  conflicts_skipped: number;
  written: number;
  mapped: number;
};
type Answer = {
  applied: boolean;
  seat: string | null;
  seats: SeatAnswer[];
  totals: Omit<SeatAnswer, "seat_id"> & { seats: number };
};

const DATE = "20261029";

const arg = (name: string): string | null => {
  const hit = process.argv.find((entry) => entry === `--${name}` || entry.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
};
const known = new Set(["apply", "seat", "out"]);
for (const entry of process.argv.slice(2)) {
  const name = entry.replace(/^--/, "").split("=")[0];
  if (!known.has(name)) throw new Error(`Unknown flag ${entry} — refused rather than ignored.`);
}

function connect(): postgres.Sql {
  const raw = process.env.PHOENIX_PRODUCTION_DATABASE_URL;
  if (!raw) throw new Error("PHOENIX_PRODUCTION_DATABASE_URL is needed — run with --env-file-if-exists=.env.production.rls.local");
  // The direct `db.<ref>.supabase.co` host does not resolve from this laptop, and PRODUCTION's session
  // pooler is aws-1, not the aws-0 that staging and scripts/apply-sql-file.mjs default to (trap
  // `apply-sql-file-default-pooler-host-is-wrong-for-production`). A URL already in pooler form passes.
  const direct = /^(\w+):\/\/([^:]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co:(\d+)\/(.+)$/.exec(raw);
  const host = process.env.PHOENIX_POOLER_HOST?.trim() || "aws-1-eu-central-1.pooler.supabase.com";
  const url = direct ? `${direct[1]}://${direct[2]}.${direct[4]}:${direct[3]}@${host}:5432/${direct[6]}` : raw;
  return postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
}

// One call, one transaction: the function takes its own advisory lock and its scratch tables drop on
// commit. The import reads every old visit in scope, so the pooler's default timeout is lifted for it.
async function ask(sql: postgres.Sql, seat: string | null, apply: boolean): Promise<Answer> {
  return sql.begin(async (tx) => {
    await tx.unsafe("set local statement_timeout = '15min'");
    const [row] = await tx.unsafe("select public.phoenix_crm_import_ireports360_history($1, $2) as answer", [seat, apply]);
    const answer = row.answer as Answer;
    return { ...answer, seats: answer.seats ?? [] };
  }) as Promise<Answer>;
}

// What a seat must write: every row the dry run plans, less the ones that would collide with a visit
// already in Phoenix (the function skips those and says so).
const planned = (seat: SeatAnswer): number => seat.rows_to_write - seat.conflicts_skipped;

async function main(): Promise<void> {
  const folder = arg("out") ?? path.join("F:", "PHX backup", `phoenix-crm-ireports360-history-${DATE}`);
  fs.mkdirSync(folder, { recursive: true });
  const only = arg("seat");
  const sql = connect();
  try {
    const dry = await ask(sql, only, false);
    fs.writeFileSync(path.join(folder, "dry-run.json"), `${JSON.stringify(dry, null, 2)}\n`);
    console.log(JSON.stringify({ dryRun: dry.totals }));

    if (arg("apply") === null) {
      console.log(`DRY RUN — nothing was written to the database. ${dry.seats.length} seat(s); file in ${folder}`);
      return;
    }

    const outcomes: Array<{ seat: string; planned: number; answer: SeatAnswer | null; error: string | null }> = [];
    let stopped: string | null = null;
    for (const seat of dry.seats) {
      if (planned(seat) === 0 && seat.archive_doctors === 0 && seat.holders === 0) {
        outcomes.push({ seat: seat.seat_id, planned: 0, answer: null, error: null });
        continue;
      }
      try {
        const done = await ask(sql, seat.seat_id, true);
        const answer = done.seats.find((entry) => entry.seat_id === seat.seat_id) ?? null;
        outcomes.push({ seat: seat.seat_id, planned: planned(seat), answer, error: null });
        if (!answer || answer.written !== planned(seat)) {
          stopped = `${seat.seat_id}: planned ${planned(seat)}, written ${answer?.written ?? "none"}`;
          break;
        }
        console.log(`${seat.seat_id}: ${answer.written} visit(s), ${answer.archive_doctors} Archive doctor(s), ${answer.holders} holder(s)`);
      } catch (error) {
        // One transaction per seat: a refused seat wrote nothing, and every seat before it stays written.
        outcomes.push({ seat: seat.seat_id, planned: planned(seat), answer: null, error: error instanceof Error ? error.message : String(error) });
        stopped = `${seat.seat_id}: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
    }
    fs.writeFileSync(path.join(folder, "applied.json"), `${JSON.stringify({ stopped, outcomes }, null, 2)}\n`);
    const written = outcomes.reduce((sum, entry) => sum + (entry.answer?.written ?? 0), 0);
    console.log(JSON.stringify({ seats: outcomes.length, written, planned: dry.seats.reduce((sum, seat) => sum + planned(seat), 0), stopped }));
    if (stopped) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
