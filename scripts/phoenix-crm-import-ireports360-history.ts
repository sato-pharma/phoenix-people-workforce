/**
 * ONE-OFF OPS SCRIPT — copy every current Medical Rep's 2026 iReports360 visit history into Phoenix CRM.
 *
 * Owner, 2026-10-29: "I want to grab every rep now current in the company working. I want to grab his visit
 * history and put it in Phoenix CRM and make it as if it is a complete data." Regular visits are planned,
 * campaign visits unplanned; a doctor Phoenix does not have goes to the rep's Archive; a visit made on
 * another seat is not copied. The rules, the readers that skip the copy and the rollback are in
 * docs/phoenix-crm-ireports360-history-import.md. The write itself is ONE database function,
 * public.phoenix_crm_import_ireports360_history(p_seat, p_apply, p_after_start)
 * (supabase/migrations/20261029212200_phoenix_crm_imports_ireports360_history.sql; the after-start mode is
 * 20261107001714), so this script only asks it and keeps the record.
 *
 * --after-start (owner, 6 Nov 2026: "Keep + show in Phoenix") copies, instead of the history before each
 * team's start, the iReports360 visits a current rep made from his team's start to the day before iReports360
 * was retired, on days he made no Phoenix entry. Those days already count, read from the stored iReports360
 * rows; the copy only lets Phoenix CRM's own screens show them and moves no count. Its records go in a folder
 * of their own (phoenix-crm-ireports360-after-start-<date>).
 *
 * DRY RUN IS THE DEFAULT. It asks the function for every seat at once (it writes nothing) and saves
 * dry-run-<Cairo time>.json OUTSIDE the repository, into F:\PHX backup\phoenix-crm-ireports360-history-<date>\.
 * Every run writes files of its own and never overwrites an earlier run's.
 *
 * --apply is a BULK PRODUCTION CHANGE (~69,000 visit rows and ~2,500 Archive doctors). Before it runs,
 * announce it in plain words (AGENTS.md §8): production has NO PITR, and the rollback is the delete by
 * the marks in the migration's header. It runs the dry run again for the seat list, then ONE seat per
 * transaction: inside that transaction it plans the seat, writes it, and throws if the written count is
 * not the planned count, so a mismatching seat is rolled back and the run stops there.
 * applied-<Cairo time>.json keeps every seat's answer. A second --apply never writes an old visit twice: every
 * one already copied is in phoenix_crm_imported_visit_sources. It CAN still write: an old visit a changed rule
 * brings in, a seat or team new since the last run, a doctor with a new link. Read the dry run first: what
 * it will write is rows_to_write less conflicts_skipped. --apply takes no value: --apply=false is refused.
 *
 * --leavers (owner, 7 Nov 2026) copies the visits of a person on NO current territory today — resigned, or moved
 * off the REP seats — each filed under the territory he held that day, on a day with no Phoenix entry. Since that
 * day EVERY mode copies only a regular visit with a check-in location (phoenix_crm_ireports360_checkin_matches,
 * filled by scripts/phoenix-crm-convert-ireports360-visits.ts --apply, which must run FIRST): a campaign visit,
 * or one with no location, is never added. Its records go in phoenix-crm-ireports360-leavers-<date>.
 *
 * Usage:
 *   node --env-file-if-exists=.env.production.rls.local --experimental-strip-types \
 *     scripts/phoenix-crm-import-ireports360-history.ts [--after-start | --leavers] [--seat=<seat id>] [--apply] [--out=<folder>]
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
  totals: Omit<SeatAnswer, "seat_id"> & { seats: number; partners_dropped: number; conflicts_without_a_line: number };
};

const DATE = "20261029";
const AFTER_START_DATE = "20261107";
const LEAVERS_DATE = "20261107";

// The text after `=`, "" for a bare flag, null when the flag is absent.
const arg = (name: string): string | null => {
  const hit = process.argv.slice(2).find((entry) => entry === `--${name}` || entry.startsWith(`--${name}=`));
  if (hit === undefined) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
};
const value = (name: string): string | null => {
  const given = arg(name);
  if (given === "") throw new Error(`--${name} needs a value: --${name}=<…> — refused rather than guessed.`);
  return given;
};
const known = new Set(["apply", "seat", "out", "after-start", "leavers"]);
for (const entry of process.argv.slice(2)) {
  const name = entry.replace(/^--/, "").split("=")[0];
  if (!entry.startsWith("--") || !known.has(name)) throw new Error(`Unknown flag ${entry} — refused rather than ignored.`);
}
// Decided before anything connects: --apply=false must never read as --apply.
if (arg("apply") !== null && arg("apply") !== "") throw new Error(`--apply takes no value (got ${arg("apply")}); leave it out for a dry run.`);
if (arg("after-start") !== null && arg("after-start") !== "") throw new Error(`--after-start takes no value (got ${arg("after-start")}).`);
if (arg("leavers") !== null && arg("leavers") !== "") throw new Error(`--leavers takes no value (got ${arg("leavers")}).`);
const APPLY = arg("apply") === "";
const AFTER_START = arg("after-start") === "";
const LEAVERS = arg("leavers") === "";
if (AFTER_START && LEAVERS) throw new Error("--after-start and --leavers are two runs: give one.");
const ONLY = value("seat");
const FOLDER =
  value("out") ??
  path.join(
    "F:",
    "PHX backup",
    LEAVERS
      ? `phoenix-crm-ireports360-leavers-${LEAVERS_DATE}`
      : AFTER_START
        ? `phoenix-crm-ireports360-after-start-${AFTER_START_DATE}`
        : `phoenix-crm-ireports360-history-${DATE}`,
  );
// Cairo wall time, file-name safe: 2026-10-31-05-36-25.
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

// `wx`: a file of the same name is refused, never overwritten — each run's record stays as it was.
const save = (name: string, data: unknown): string => {
  const file = path.join(FOLDER, `${name}-${STAMP}.json`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
  return file;
};

function connect(): postgres.Sql {
  const raw = process.env.PHOENIX_PRODUCTION_DATABASE_URL;
  if (!raw) throw new Error("PHOENIX_PRODUCTION_DATABASE_URL is needed — run with --env-file-if-exists=.env.production.rls.local");
  // The direct `db.<ref>.supabase.co` host does not resolve from this laptop, and PRODUCTION's session
  // pooler is aws-1, not the aws-0 that staging and scripts/apply-sql-file.mjs default to (trap
  // `apply-sql-file-default-pooler-host-is-wrong-for-production`). A URL already in pooler form passes.
  // The password group is greedy, so a password holding `@` still parses, and the parts go to postgres
  // as fields: its own URL parser cuts the host at the FIRST `@`.
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

// The import reads every old visit in scope, so the pooler's default timeout is lifted for it. The
// function takes a transaction-level advisory lock and drops its scratch tables first, so two calls in
// one transaction are safe.
const TIMEOUT = "set local statement_timeout = '15min'";

async function call(tx: postgres.TransactionSql, seat: string | null, apply: boolean): Promise<Answer> {
  const [row] = await tx.unsafe("select public.phoenix_crm_import_ireports360_history($1, $2, $3, $4) as answer", [
    seat,
    apply,
    AFTER_START,
    LEAVERS,
  ]);
  const answer = row.answer as Answer;
  return { ...answer, seats: answer.seats ?? [] };
}

async function dryRun(sql: postgres.Sql, seat: string | null): Promise<Answer> {
  return sql.begin(async (tx) => {
    await tx.unsafe(TIMEOUT);
    return call(tx, seat, false);
  }) as Promise<Answer>;
}

// What a seat must write: every row the dry run plans, less its conflicts: a visit already in Phoenix on that
// customer and day, and the later of two reps' visits to one customer on one day. The function skips both
// and says so.
const plannedOf = (seat: SeatAnswer): number => seat.rows_to_write - seat.conflicts_skipped;

// Thrown INSIDE the seat's transaction, so the seat is rolled back rather than left written.
class SeatMismatch extends Error {
  planned: number;
  answer: SeatAnswer | null;
  constructor(planned: number, answer: SeatAnswer | null) {
    super(`planned ${planned}, written ${answer?.written ?? "none"} — the seat was rolled back`);
    this.planned = planned;
    this.answer = answer;
  }
}

// One seat, one transaction, one snapshot: the plan and the write see the same rows, so a visit a rep
// logs on another seat meanwhile cannot make a correct seat look wrong. A row committed into THIS seat
// after the snapshot fails the insert with a serialization error, which rolls the seat back too.
async function applySeat(sql: postgres.Sql, seatId: string): Promise<{ planned: number; answer: SeatAnswer }> {
  return sql.begin("isolation level repeatable read", async (tx) => {
    await tx.unsafe(TIMEOUT);
    const plan = (await call(tx, seatId, false)).seats.find((entry) => entry.seat_id === seatId);
    const planned = plan ? plannedOf(plan) : 0;
    const answer = (await call(tx, seatId, true)).seats.find((entry) => entry.seat_id === seatId) ?? null;
    if (!answer || answer.written !== planned) throw new SeatMismatch(planned, answer);
    return { planned, answer };
  }) as Promise<{ planned: number; answer: SeatAnswer }>;
}

async function main(): Promise<void> {
  fs.mkdirSync(FOLDER, { recursive: true });
  const sql = connect();
  try {
    const dry = await dryRun(sql, ONLY);
    const dryFile = save("dry-run", dry);
    console.log(JSON.stringify({ dryRun: dry.totals }));

    if (!APPLY) {
      console.log(`DRY RUN — nothing was written to the database. ${dry.seats.length} seat(s); file ${dryFile}`);
      return;
    }

    const outcomes: Array<{ seat: string; planned: number; answer: SeatAnswer | null; error: string | null }> = [];
    let stopped: string | null = null;
    for (const seat of dry.seats) {
      if (plannedOf(seat) === 0 && seat.archive_doctors === 0 && seat.holders === 0) {
        outcomes.push({ seat: seat.seat_id, planned: 0, answer: null, error: null });
        continue;
      }
      try {
        const { planned, answer } = await applySeat(sql, seat.seat_id);
        outcomes.push({ seat: seat.seat_id, planned, answer, error: null });
        console.log(`${seat.seat_id}: ${answer.written} visit(s), ${answer.archive_doctors} Archive doctor(s), ${answer.holders} holder(s)`);
      } catch (error) {
        // One transaction per seat: a refused seat wrote nothing, and every seat before it stays written.
        const message = error instanceof Error ? error.message : String(error);
        const mismatch = error instanceof SeatMismatch ? error : null;
        outcomes.push({ seat: seat.seat_id, planned: mismatch?.planned ?? plannedOf(seat), answer: mismatch?.answer ?? null, error: message });
        stopped = `${seat.seat_id}: ${message}`;
        break;
      }
    }
    save("applied", { stopped, outcomes });
    // A rolled-back seat's answer is what it WOULD have written; it is not counted.
    const written = outcomes.reduce((sum, entry) => sum + (entry.error ? 0 : (entry.answer?.written ?? 0)), 0);
    console.log(JSON.stringify({ seats: outcomes.length, written, planned: dry.seats.reduce((sum, seat) => sum + plannedOf(seat), 0), stopped }));
    if (stopped) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
