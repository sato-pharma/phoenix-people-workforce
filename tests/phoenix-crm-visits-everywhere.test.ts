import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";
import { lastDefinerSql, liveViewSql } from "./support/sql-definer.ts";

import {
  callRateExclusionOf,
  classifyCallProof,
  computeCallRate,
  hasNoGpsFeed,
  type VisitForCallRate,
} from "../src/lib/crm/call-rate.ts";
import { indexCheckinsByAgentContactDay, type CheckinForMatch } from "../src/lib/crm/checkin-match.ts";
import { attachEffectiveType, REGULAR_NO_GPS_CHECKIN_LABEL, type CrmMasterRow } from "../src/lib/crm/master.ts";
import {
  buildPhoenixTeamRows,
  cairoMonthFloor,
  comingSaturday,
  countedFromLabel,
  defaultStartSaturday,
  IREPORTS360_VISIT_SOURCE,
  isPhoenixNativeVisitRow,
  isSaturday,
  parsePhoenixTeamStart,
  PHOENIX_CRM_PLANS_EVERYWHERE_MIGRATION,
  PHOENIX_CRM_SET_TEAM_START_RPC,
  PHOENIX_CRM_TEAM_START_NOTICES_TABLE,
  PHOENIX_CRM_TEAM_STARTS_TABLE,
  PHOENIX_CRM_VISITS_EVERYWHERE_MIGRATION,
  PHOENIX_TEAM_NOT_STARTED_EVENT,
  PHOENIX_TEAM_STARTS_PANEL_PATH,
  PHOENIX_VISIT_SOURCE,
  saturdayLabel,
  saturdayOnOrAfter,
  startConfirmText,
  startSaturdayOptions,
  stopCancelsStart,
  stopConfirmText,
  stopSaturdayOptions,
  TEAM_START_REFUSALS,
  teamNotStartedNotice,
  teamStartRefusal,
  type PhoenixTeamRow,
  type PhoenixTeamStart,
} from "../src/lib/crm/phoenix-team-starts.ts";
import { isCrmDoubleVisitRow } from "../src/lib/crm/reads.ts";
import { buildRepVisits, unscoredLabel, type VisitForRepDrilldown } from "../src/lib/crm/rep-visits.ts";
import { buildStartTimeRows, phoenixFirstVisitStarts } from "../src/lib/crm/sfe-field-analytics.ts";
import { addVisitToSplit, emptyVisitCountSplit, pharmacyRecordingOf, visitCountBucket } from "../src/lib/crm/visit-count-buckets.ts";
import { crmVisitTypeMeaningStrict } from "../src/lib/crm/visit-type-meaning.ts";
import { classifyVisit, isFieldWorkVisit } from "../src/lib/crm/visit-types.ts";
import { buildEarlyBirdsDailyWinners } from "../src/lib/early-birds/daily-board.ts";
import { earlyBirdsPeriodFromKey } from "../src/lib/early-birds/period.ts";
import { startedWindowCovers, type StartedRepWindow } from "../src/lib/early-birds/phoenix-start.ts";
import { buildEarlyBirdsRanking } from "../src/lib/early-birds/scoring.ts";
import type { EarlyBirdsRepContext, EarlyBirdsVisitFact } from "../src/lib/early-birds/types.ts";
import type { NsmCrmVisitRow } from "../src/lib/employee-portal/nsm-crm-compliance.ts";
import { phoenixCrmChannels } from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import { isPlanSentForReview, planDayStatus } from "../src/lib/phoenix-crm/plan-rules.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * Phoenix CRM, counted everywhere — from each team's start (owner's rulings, 2026-10-02).
 *
 * The design note is src/lib/crm/phoenix-team-starts.ts. CI never sees the database, so the SQL is pinned
 * from the two migrations' text and its rules are re-run here in JavaScript, on cases measured against
 * staging and production (read-only) with the migrations' exact expressions on 2026-10-02:
 *
 *   1. WHO STARTS A TEAM — "Only when I start it": Delta (1) from Saturday 3 October by his ruling, every
 *      other team only by the Super Admin's Start, from a Saturday, never before the first day of this
 *      Cairo month; Stop sticks; one audited writer; nothing else (no trigger, no backfill) writes.
 *   2. NOTHING COUNTED TWICE — the WHOLE team (its reps and its district manager, "Yes, the whole team")
 *      leaves the iReports360 branches for exactly the days they sat on it within a start.
 *   3. THE VISIT ROW — AM · PM · Pharmacies apart; countable and real only; day activities as worked days.
 *   4. THE PLAN DOOR — a day is planned when its week was SENT as of that day, by the visit save's rule.
 *   5. THE CHECK-IN DOOR — a positioned Phoenix visit is that day's check-in on manager screens only, and
 *      carries no integrity column; every reader a rep can reach stays on iReports360.
 *   6. EARLY BIRDS and the SFE start times start at the first Phoenix visit, named never as GPS.
 *   7. The call rate reads a Phoenix row as its own proof and leaves a not-yet-validated customer out.
 *   8. The Super Admin's panel, route and notice.
 */

const VISITS = PHOENIX_CRM_VISITS_EVERYWHERE_MIGRATION;
const PLANS = PHOENIX_CRM_PLANS_EVERYWHERE_MIGRATION;
const PREVIOUS_VIEWS = "supabase/migrations/20260925150000_drop_crm_native_pilot_tables.sql";
const PREVIOUS_FLAGS_VIEW = "supabase/migrations/20260914000000_crm_unify_vendor_reads.sql";
const SAVE_VISIT_RULE = "supabase/migrations/20261002125244_phoenix_crm_still_planned_after_one_day_return.sql";

const DAY_MS = 86_400_000;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Whitespace collapsed, so a pin reads the SQL and not its indentation. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * One `create or replace function public.<name>(` statement, through the terminator that closes its body.
 *
 * EITHER DOLLAR TAG. This directory uses `$$` and `$function$` about equally — 229 files and 163 on
 * 23 October 2026 — and reading only `$$;` made this helper report "<name> is closed" as a FAILURE on a
 * perfectly valid function. That is how it broke on the entry-days cache: not on anything about the rule
 * it pins, but on the quoting of the file that happened to define it last.
 */
function functionSql(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const [end] = ["\n$$;", "\n$function$;"]
    .map((tag) => ({ tag, at: sql.indexOf(tag, start) }))
    .filter((candidate) => candidate.at > start)
    .sort((a, b) => a.at - b.at);
  assert.ok(end, `${name} is closed`);
  return sql.slice(start, end.at + end.tag.length);
}

/** One `create or replace view public.<name>` statement, through the `;` that ends it. */
function viewSql(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace view public.${name}`);
  assert.ok(start >= 0, `${name} is created`);
  const end = sql.indexOf(";", start);
  assert.ok(end > start, `${name} is closed`);
  return sql.slice(start, end + 1);
}

/** The non-blank lines of a select list, each without its trailing comma — one per column here. */
function selectItems(list: string): string[] {
  return list
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => line.length > 0);
}

/** The select list of a branch, between its `select` line and the `from` that follows it. */
function itemsOf(branch: string, from: string): string[] {
  const start = branch.indexOf("select\n");
  const end = branch.indexOf(from);
  assert.ok(start >= 0 && end > start, `the branch selects before "${from}"`);
  return selectItems(branch.slice(start + "select\n".length, end));
}

/**
 * The output name of a vendor select item: `v.id` → `id`, `'x'::text as source` → `source`.
 *
 * Digits belong in both patterns: `double2_crm_id` is a real column name, and a name class of
 * `[a-z_]` alone matched neither arm and read it as malformed SQL.
 */
function outputName(item: string): string {
  const alias = /\sas\s+([a-z0-9_]+)$/.exec(item);
  if (alias) return alias[1];
  const column = /^[a-z]+\.([a-z0-9_]+)$/.exec(item);
  assert.ok(column, `the vendor column "${item}" is a plain column or names itself`);
  return column[1];
}

/**
 * The four doors as they stand — each read from whichever migration defined it LAST, by sort order,
 * rather than from a path written here.
 *
 * A pin naming a migration file is how a check quietly starts reading DEAD SQL: the text is still in
 * that file and the database stopped running it the day a later migration replaced it. These doors have
 * been replaced four times already (20260914000000, 20260925150000, 20261002123958, 20261007193000), so
 * asking the directory is the only form of this pin that cannot go green and wrong.
 */
const VISITS_DOOR = liveViewSql("crm_visits_unified");
const FLAGS_VIEW = liveViewSql("crm_visits_checkin_flags");
const PLANS_DOOR = liveViewSql("crm_plan_entries_unified");
const CHECKINS_DOOR = liveViewSql("crm_checkins_unified");

/** The items of a previous migration's view, flattened, as one list. */
function previousItems(name: string, from: string): string[] {
  const previous = flat(stripSqlComments(viewSql(stripSqlComments(read(PREVIOUS_VIEWS)), name)));
  return previous.slice(previous.indexOf(" as select ") + " as select ".length, previous.indexOf(` ${from}`)).split(", ");
}

/**
 * The previous items with Phoenix's values in place — owner, 2026-10-22: "phoenix is the source of trust
 * and its data override old crm data" (20261022163000). Only these items change; every other column of
 * every vendor branch is still the previous door word for word, so a column a door drops or reorders
 * still fails here.
 */
function withPhoenixOverrides(items: string[], overrides: Record<string, string>): string[] {
  const replaced = new Set<string>();
  const result = items.map((item) => {
    const name = outputName(item);
    if (!(name in overrides)) return item;
    replaced.add(name);
    return overrides[name];
  });
  assert.deepEqual([...replaced].sort(), Object.keys(overrides).sort(), "every Phoenix override names a column the previous door had");
  return result;
}

/** The person's own name plus the vendor's trailing "( territory )", when the row's hr id is a person. */
// `full_name_nz` since 20261023153000: the person lookup is a cached table now, and it carries the
// blank-as-NULL name as its own column so this expression reads exactly what the inline
// `nullif(btrim(e.full_name), '')` used to hand it. The raw column is on the same row — reading it
// here would make an employee whose name is an empty string look like a name on record, and the
// vendor's own spelling would be thrown away for a blank.
const PERSON_NAME = (column: "agent_name" | "double_name", person: string) =>
  String.raw`case when ${person}.full_name_nz is not null then concat_ws(' ', ${person}.full_name_nz, substring(v.${column} from '(\([^()]*\))\s*$')) else v.${column} end as ${column}`;

function isoDow(day: string): number {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The view's 52-bit id for a Phoenix row (a visit, a plan item, a check-in). */
function phoenixId(uuid: string): number {
  return -1 - Number.parseInt(createHash("md5").update(uuid).digest("hex").slice(0, 13), 16);
}

/** The plan view's 30-bit `crm_plan_id` — the column is an integer. */
function phoenixPlanId(uuid: string): number {
  return -1 - Math.floor(Number.parseInt(createHash("md5").update(uuid).digest("hex").slice(0, 8), 16) / 4);
}

/** Computed on STAGING, 2026-10-02, with the views' exact expressions. */
const STAGING_IDS: ReadonlyArray<{ uuid: string; row: number; plan: number }> = [
  { uuid: "00000000-0000-0000-0000-000000000001", row: -3543007088324739, plan: -844718716 },
  { uuid: "ffffffff-ffff-ffff-ffff-ffffffffffff", row: -3188000793994997, plan: -760078620 },
  { uuid: "7d1c2a54-1b3e-4c55-9a6f-0c2e8d9b4a11", row: -4243111500339505, plan: -1011636615 },
];

/** Every .ts/.tsx file under a folder. */
function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path.replace(/\\/g, "/"));
  }
  return out;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────

function phoenixRow(overrides: Partial<VisitForCallRate> = {}): VisitForCallRate {
  return {
    agent_crm_id: 4401,
    agent_hr_id: "B-7",
    agent_name: "Phoenix Rep",
    ampm: "PM",
    comment: "Discussed the new pack",
    contact_crm_id: 555,
    crm_save_date: "2026-10-04T10:00:00",
    crm_visit_id: phoenixId("7d1c2a54-1b3e-4c55-9a6f-0c2e8d9b4a11"),
    phoenix_customer_validated: true,
    source: PHOENIX_VISIT_SOURCE,
    speciality: "Pediatrics",
    visit_date: "2026-10-04",
    visit_type: 0,
    visit_type_description: "Regular Visit",
    ...overrides,
  };
}

function vendorRow(overrides: Partial<VisitForCallRate> = {}): VisitForCallRate {
  return {
    agent_crm_id: 4401,
    agent_hr_id: "B-7",
    agent_name: "Phoenix Rep",
    ampm: "PM",
    comment: null,
    contact_crm_id: 555,
    crm_save_date: "2026-09-29T10:00:00",
    crm_visit_id: 9_120_001,
    phoenix_customer_validated: null,
    source: IREPORTS360_VISIT_SOURCE,
    speciality: "Pediatrics",
    visit_date: "2026-09-29",
    visit_type: 0,
    visit_type_description: "Regular Visit",
    ...overrides,
  };
}

function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId">): OrgSeat {
  return {
    areaName: null,
    lineCode: "AI",
    lineName: "Anti Infective",
    occupantHrId: null,
    parentSeatId: null,
    path: [],
    regionName: "Delta (1)",
    seatLabel: null,
    tier: "REP",
    ...overrides,
  };
}

// ── 1. Who starts a team ──────────────────────────────────────────────────────────────────────────

type StartRow = { team: string; startsOn: string; stopsOn: string | null };
type WriterAnswer = { done: "started" | "stopped" | "cancelled"; rows: StartRow[] } | { refused: string };

/**
 * public.phoenix_crm_set_team_start, rule for rule — the function's clauses are pinned below, so this
 * transcription and the SQL cannot drift apart without this file going red.
 */
function setTeamStart(
  rows: readonly StartRow[],
  input: { action: string; team: string; day: string | null; today: string; hasTerritories: boolean },
): WriterAnswer {
  const floor = `${input.today.slice(0, 7)}-01`;
  if ((input.action !== "start" && input.action !== "stop") || !input.team) return { refused: "bad_input" };
  if (input.action === "start" && !input.hasTerritories) return { refused: "no_team" };
  if (input.day !== null && isoDow(input.day) !== 6) return { refused: "not_saturday" };
  if (input.day !== null && input.day < floor) return { refused: "before_month" };
  const mine = rows.filter((row) => row.team === input.team);
  const others = rows.filter((row) => row.team !== input.team);
  if (input.action === "start") {
    if (input.day === null) return { refused: "bad_input" };
    if (mine.some((row) => row.stopsOn === null)) return { refused: "already_started" };
    if (mine.some((row) => row.stopsOn !== null && row.stopsOn > input.day!)) return { refused: "overlaps" };
    return { done: "started", rows: [...rows, { team: input.team, startsOn: input.day, stopsOn: null }] };
  }
  const running = mine.find((row) => row.stopsOn === null);
  if (!running) return { refused: "not_started" };
  if (running.startsOn > input.today || (input.day !== null && input.day <= running.startsOn)) {
    if (running.startsOn < floor) return { refused: "before_month" };
    return { done: "cancelled", rows: [...others, ...mine.filter((row) => row !== running)] };
  }
  if (input.day === null) return { refused: "bad_input" };
  return { done: "stopped", rows: [...others, ...mine.map((row) => (row === running ? { ...row, stopsOn: input.day } : row))] };
}

function runWhoStartsATeamTests(code: string): void {
  // Nothing but the writer writes a start: no trigger, no backfill, no date rule of the system's own.
  assert.doesNotMatch(code, /create trigger|returns trigger|\bdo \$\$/, "no trigger and no backfill starts a team");
  assert.doesNotMatch(code, /phoenix_crm_team_start_for|phoenix_crm_note_team_start|_team_start\(\)\s+returns trigger/, "and no date rule of its own");

  // The table: a row per START, Saturdays, at most one running per team, a stop recorded with its time.
  const table = flat(code.slice(code.indexOf("create table if not exists public.phoenix_crm_team_starts"), code.indexOf("create unique index")));
  for (const clause of [
    "id uuid primary key default gen_random_uuid()",
    "team_seat_id text not null",
    "starts_on date not null",
    "stops_on date",
    "constraint phoenix_crm_team_starts_saturday check (extract(isodow from starts_on) = 6)",
    "constraint phoenix_crm_team_starts_stop_saturday check (stops_on is null or extract(isodow from stops_on) = 6)",
    "constraint phoenix_crm_team_starts_stop_after_start check (stops_on is null or stops_on > starts_on)",
    "constraint phoenix_crm_team_starts_started_by check (started_by in ('owner_ruling', 'super_admin'))",
    "constraint phoenix_crm_team_starts_stop_recorded check ((stops_on is null) = (stopped_at is null))",
  ]) {
    assert.ok(table.includes(clause), `the starts table holds: ${clause}`);
  }
  assert.ok(
    flat(code).includes("create unique index if not exists phoenix_crm_team_starts_one_running on public.phoenix_crm_team_starts (team_seat_id) where stops_on is null;"),
    "at most one running start per team",
  );

  // Delta (1): the owner's ruling, seeded — 3 October, never 26 September — and only seats that exist.
  const seed = flat(code.slice(code.indexOf("insert into public.phoenix_crm_team_starts (team_seat_id, starts_on, started_by, note)"), code.indexOf("create or replace function public.phoenix_crm_set_team_start")));
  assert.match(seed, /select s\.seat_id, date '2026-10-03', 'owner_ruling', /, "Delta (1) is seeded with Saturday 3 October 2026, from the owner's ruling");
  assert.match(seed, /from au\.seats s where s\.seat_id in \('SEAT-AIF-DM-D1', 'SEAT-CNS-DM-D1', 'SEAT-PED-DM-D1'\) and not exists \(select 1 from public\.phoenix_crm_team_starts t where t\.team_seat_id = s\.seat_id\);/);
  assert.doesNotMatch(code, /2026-09-2[0-9]/, "no date in September is ever written: never the week of 26 September");
  assert.equal(isoDow("2026-10-03"), 6, "3 October 2026 is a Saturday");

  // THE WRITER, clause by clause.
  const writer = flat(functionSql(code, "phoenix_crm_set_team_start"));
  for (const clause of [
    "returns jsonb language plpgsql security definer set search_path to 'public'",
    "v_today date := (now() at time zone 'Africa/Cairo')::date;",
    "v_floor date := date_trunc('month', (now() at time zone 'Africa/Cairo'))::date;",
    "if v_action not in ('start', 'stop') or v_team is null or v_actor is null then raise exception 'phoenix_crm_team_start:bad_input';",
    "if v_action = 'start' and not exists (select 1 from au.seats s where s.parent_seat_id = v_team and s.seat_tier = 'REP') then raise exception 'phoenix_crm_team_start:no_team';",
    "if v_day is not null and extract(isodow from v_day) <> 6 then raise exception 'phoenix_crm_team_start:not_saturday';",
    "if v_day is not null and v_day < v_floor then raise exception 'phoenix_crm_team_start:before_month';",
    "perform pg_advisory_xact_lock(hashtext('phoenix_crm:team_start:' || v_team));",
    "if exists (select 1 from public.phoenix_crm_team_starts t where t.team_seat_id = v_team and t.stops_on is null) then raise exception 'phoenix_crm_team_start:already_started';",
    "if exists (select 1 from public.phoenix_crm_team_starts t where t.team_seat_id = v_team and t.stops_on > v_day) then raise exception 'phoenix_crm_team_start:overlaps';",
    "insert into public.phoenix_crm_team_starts (team_seat_id, starts_on, started_by, started_by_hr_id) values (v_team, v_day, 'super_admin', v_actor) returning * into v_row;",
    "where t.team_seat_id = v_team and t.stops_on is null for update; if not found then raise exception 'phoenix_crm_team_start:not_started';",
    "if v_row.starts_on > v_today or (v_day is not null and v_day <= v_row.starts_on) then if v_row.starts_on < v_floor then raise exception 'phoenix_crm_team_start:before_month'; end if; delete from public.phoenix_crm_team_starts t where t.id = v_row.id;",
    "update public.phoenix_crm_team_starts t set stops_on = v_day, stopped_by_hr_id = v_actor, stopped_at = now() where t.id = v_row.id returning * into v_row;",
  ]) {
    assert.ok(writer.includes(clause), `the writer holds: ${clause}`);
  }
  // Every change writes its audit row in the SAME transaction: a start (new), a take-back (old), a stop (both).
  const audits = [...writer.matchAll(/insert into public\.audit_logs \(actor_login_id, entity_type, entity_id, summary, (new_values|old_values|old_values, new_values)\) values \(coalesce\(v_login, v_actor\), 'crm_phoenix_team_start', v_team,/g)].map((match) => match[1]);
  assert.deepEqual(audits, ["new_values", "old_values", "old_values, new_values"], "a start, a take-back and a stop each write their audit row inside the writer");
  for (const code_ of new Set([...writer.matchAll(/phoenix_crm_team_start:([a-z_]+)/g)].map((match) => match[1]))) {
    assert.ok(TEAM_START_REFUSALS[code_], `the writer's refusal "${code_}" has words for the Super Admin`);
  }
  assert.match(code, /revoke execute on function public\.phoenix_crm_set_team_start\(jsonb\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.phoenix_crm_set_team_start\(jsonb\) to service_role;/, "the service role alone runs the writer");
  assert.equal(PHOENIX_CRM_SET_TEAM_START_RPC, "phoenix_crm_set_team_start");

  // The writer's rules, run.
  const today = "2026-10-14";
  const delta: StartRow = { team: "D1", startsOn: "2026-10-03", stopsOn: null };
  const startOf = (rows: StartRow[], day: string | null, team = "GZ", hasTerritories = true) =>
    setTeamStart(rows, { action: "start", team, day, today, hasTerritories });
  const stopOf = (rows: StartRow[], day: string | null, team = "D1", on = today) =>
    setTeamStart(rows, { action: "stop", team, day, today: on, hasTerritories: true });
  assert.deepEqual(startOf([delta], "2026-10-15"), { refused: "not_saturday" }, "a team starts on a Saturday");
  assert.deepEqual(startOf([delta], "2026-09-26"), { refused: "before_month" }, "never before the first day of this Cairo month");
  assert.deepEqual(startOf([delta], null), { refused: "bad_input" });
  assert.deepEqual(startOf([delta], "2026-10-17", "EMPTY", false), { refused: "no_team" }, "a seat with no territories is no team");
  assert.equal((startOf([delta], "2026-10-17") as { done?: string }).done, "started");
  assert.deepEqual(startOf([delta], "2026-10-17", "D1"), { refused: "already_started" }, "one running start per team");
  assert.equal((stopOf([{ team: "D1", startsOn: "2026-10-17", stopsOn: null }], null) as { done?: string }).done, "cancelled", "a start not reached yet is taken back whole");
  assert.equal((stopOf([delta], "2026-10-03") as { done?: string }).done, "cancelled", "a stop on its own first Saturday takes it back whole");
  assert.equal((stopOf([delta], "2026-10-10") as { done?: string }).done, "stopped", "a stop may fall on a past Saturday of this month");
  assert.equal((stopOf([delta], "2026-10-24") as { done?: string }).done, "stopped", "or on a coming one");
  assert.deepEqual(stopOf([delta], null), { refused: "bad_input" }, "a running start needs the Saturday it stops on");
  assert.deepEqual(stopOf([delta], "2026-10-03", "D1", "2026-11-05"), { refused: "before_month" }, "an October start can never be taken back in November");
  assert.deepEqual(stopOf([delta], "2026-11-07", "D1", "2026-11-05").hasOwnProperty("done"), true, "but it can be stopped from November on");
  const stopped = stopOf([delta], "2026-10-24") as { rows: StartRow[] };
  assert.deepEqual(startOf(stopped.rows, "2026-10-17", "D1"), { refused: "overlaps" }, "a stop sticks: no day is in two starts");
  assert.equal((startOf(stopped.rows, "2026-10-24", "D1") as { done?: string }).done, "started", "and the team starts again from its stop");
  assert.deepEqual(stopOf([], "2026-10-24"), { refused: "not_started" });

  // The panel's rules — the only choices it offers — are the writer's.
  assert.equal(isSaturday("2026-10-03"), true);
  assert.equal(isSaturday("2026-10-02"), false);
  assert.equal(cairoMonthFloor("2026-10-14"), "2026-10-01");
  assert.equal(saturdayOnOrAfter("2026-10-01"), "2026-10-03");
  assert.equal(saturdayOnOrAfter("2026-10-03"), "2026-10-03");
  assert.equal(saturdayOnOrAfter("2026-11-01"), "2026-11-07");
  assert.equal(comingSaturday("2026-10-02"), "2026-10-03", "the coming Saturday");
  assert.equal(comingSaturday("2026-10-03"), "2026-10-10", "on a Saturday, the next one");
  const october = startSaturdayOptions(today, null);
  assert.equal(october[0], "2026-10-03", "the first Saturday of this month is the earliest a start is offered");
  assert.ok(october.every((day) => isSaturday(day) && day >= "2026-10-01"), "only Saturdays, never before this month");
  assert.equal(defaultStartSaturday(today, october), "2026-10-17", "the coming Saturday is selected first");
  assert.equal(startSaturdayOptions("2026-11-05", null)[0], "2026-11-07", "in November, never 31 October");
  assert.equal(startSaturdayOptions(today, "2026-10-24")[0], "2026-10-24", "after a stop, from that stop");
  assert.equal(stopSaturdayOptions(today, "2026-10-03")[0], "2026-10-03", "a stop offers the start's own Saturday while it is this month's");
  assert.equal(stopSaturdayOptions("2026-11-05", "2026-10-03")[0], "2026-11-07", "and never a Saturday before this month");
  assert.equal(stopCancelsStart("2026-10-17", null, today), true);
  assert.equal(stopCancelsStart("2026-10-03", "2026-10-03", today), true);
  assert.equal(stopCancelsStart("2026-10-03", "2026-10-17", today), false);
  for (const day of startSaturdayOptions(today, null)) {
    assert.equal((startOf([delta], day) as { done?: string }).done, "started", `the writer accepts the offered start ${day}`);
  }
  for (const day of stopSaturdayOptions(today, "2026-10-03")) {
    const answer = stopOf([delta], day) as { done?: string };
    assert.equal(answer.done, stopCancelsStart("2026-10-03", day, today) ? "cancelled" : "stopped", `the offered stop ${day} does what its words say`);
  }

  // The words he reads before anything happens.
  assert.equal(
    startConfirmText("2026-10-10", 6),
    "From Sat 10 Oct 2026, the iReports360 visits of these 6 reps stop counting and their Phoenix visits count instead.",
  );
  assert.match(startConfirmText("2026-10-10", 1), /of this 1 rep stop counting/);
  assert.match(startConfirmText("2026-10-10", 0), /of its reps stop counting/);
  assert.equal(
    stopConfirmText("2026-10-17", null, 6, today),
    "The start on Sat 17 Oct 2026 is taken back: the iReports360 visits of these 6 reps count again, and no day of it counts from Phoenix.",
  );
  assert.equal(
    stopConfirmText("2026-10-03", "2026-10-24", 6, today),
    "From Sat 24 Oct 2026, the Phoenix visits of these 6 reps stop counting and their iReports360 visits count again.",
  );
  assert.equal(teamStartRefusal('ERROR: P0001: phoenix_crm_team_start:before_month'), TEAM_START_REFUSALS.before_month);
  assert.equal(teamStartRefusal("phoenix_crm_team_start:something_else"), null);
  assert.equal(teamStartRefusal("permission denied"), null);
  assert.equal(saturdayLabel("2026-10-03"), "Sat 03 Oct 2026");
  assert.equal(countedFromLabel("2026-10-03"), "Saturday 03 Oct 2026", "a date-only Saturday is never shifted a day");
}

// ── The Super Admin's panel ──────────────────────────────────────────────────────────────────────────

function runPanelTests(): void {
  const org = buildOrgIndex([
    seat({ seatId: "SEAT-AIF-DM-D1", tier: "DM", occupantHrId: "b-12" }),
    seat({ seatId: "SEAT-AIF-REP-D13", parentSeatId: "SEAT-AIF-DM-D1", areaName: "Menoufia 2", occupantHrId: "B-7" }),
    seat({ seatId: "SEAT-AIF-REP-D14", parentSeatId: "SEAT-AIF-DM-D1", areaName: "Tanta", occupantHrId: "AI-0020" }),
    seat({ seatId: "SEAT-AIF-REP-D15", parentSeatId: "SEAT-AIF-DM-D1", areaName: "Mahalla" }),
    seat({ seatId: "SEAT-CNS-DM-GZ", tier: "DM", lineCode: "CN", lineName: "CNS", regionName: "Giza" }),
    seat({ seatId: "SEAT-CNS-REP-GZ6", parentSeatId: "SEAT-CNS-DM-GZ", lineCode: "CN", lineName: "CNS", regionName: "Giza", occupantHrId: "CN-1" }),
    seat({ seatId: "SEAT-PED-DM-AX", tier: "DM", lineCode: "PD", lineName: "Pedia", regionName: "Alexandria", occupantHrId: "B-300" }),
    seat({ seatId: "SEAT-PED-REP-AX1", parentSeatId: "SEAT-PED-DM-AX", lineCode: "PD", lineName: "Pedia", regionName: "Alexandria", occupantHrId: "B-301" }),
    seat({ seatId: "SEAT-PED-DM-QN", tier: "DM", lineCode: "PD", lineName: "Pedia", regionName: "Upper Egypt", occupantHrId: "B-400" }),
    seat({ seatId: "SEAT-PED-REP-QN1", parentSeatId: "SEAT-PED-DM-QN", lineCode: "PD", lineName: "Pedia", regionName: "Upper Egypt", occupantHrId: "B-401" }),
    seat({ seatId: "SEAT-CNS-DM-CA", tier: "DM", lineCode: "CN", lineName: "CNS", regionName: "Cairo", occupantHrId: "B-500" }),
    seat({ seatId: "SEAT-CNS-REP-CA1", parentSeatId: "SEAT-CNS-DM-CA", lineCode: "CN", lineName: "CNS", regionName: "Cairo", occupantHrId: "B-501" }),
  ]);
  const starts = [
    { id: "s1", team_seat_id: "SEAT-AIF-DM-D1", starts_on: "2026-10-03", stops_on: null, started_by: "owner_ruling", started_by_hr_id: null, note: "Owner's ruling" },
    { id: "s2", team_seat_id: "SEAT-CNS-DM-GZ", starts_on: "2026-10-17", stops_on: null, started_by: "super_admin", started_by_hr_id: "B-10", note: null },
    { id: "s3", team_seat_id: "SEAT-PED-DM-AX", starts_on: "2026-10-03", stops_on: "2026-10-10", started_by: "super_admin", started_by_hr_id: "B-10", note: null },
    { id: "s4", team_seat_id: "SEAT-PED-DM-QN", starts_on: "2026-10-03", stops_on: "2026-10-24", started_by: "super_admin", started_by_hr_id: "B-10", note: null },
    { id: "s5", team_seat_id: "SEAT-OLD-DM", starts_on: "2026-10-03", stops_on: null, started_by: "super_admin", started_by_hr_id: "B-10", note: null },
    { id: "s6", team_seat_id: "SEAT-X", starts_on: "2026-10-17", stops_on: null, started_by: "trigger", started_by_hr_id: null, note: null },
    { id: "", team_seat_id: "SEAT-Y", starts_on: "2026-10-17", stops_on: null, started_by: "super_admin", started_by_hr_id: null, note: null },
  ]
    .map((row) => parsePhoenixTeamStart(row))
    .filter((row): row is PhoenixTeamStart => row !== null);
  assert.equal(starts.length, 5, "a row with no id or an unknown cause is never shown");

  const names: Record<string, string> = { "B-12": "Dina Hamdy", "B-10": "Omar Gawish", "B-300": "Pedia Alex Manager", "B-400": "Pedia Qena Manager", "B-500": "CNS Cairo Manager", "B-901": "Ahmed Ali" };
  const rows = buildPhoenixTeamRows({
    org,
    starts,
    firstPlans: new Map([["SEAT-CNS-DM-CA", { repName: "Ahmed Ali", weekStart: "2026-10-17" }]]),
    names: (hrId) => names[hrId.toUpperCase()] ?? null,
    cairoToday: "2026-10-14",
  });
  const byTeam = new Map(rows.map((row): [string, PhoenixTeamRow] => [row.teamSeatId, row]));
  assert.deepEqual(
    rows.map((row) => [row.state, row.team]),
    [
      ["running", "A team no longer in the organogram"],
      ["running", "Dina Hamdy · Anti Infective · Delta (1)"],
      ["stopping", "Pedia Qena Manager · Pedia · Upper Egypt"],
      ["starts", "District manager seat vacant · CNS · Giza"],
      ["stopped", "Pedia Alex Manager · Pedia · Alexandria"],
      ["not_started", "CNS Cairo Manager · CNS · Cairo"],
    ],
    "every team, counted teams first; named by its manager, line and region — never a seat code",
  );
  for (const row of rows) {
    assert.doesNotMatch(`${row.team} ${row.stateLine} ${row.firstPlanLine ?? ""}`, /SEAT-|B-\d/, "no seat code or hr id is ever shown");
  }

  const delta = byTeam.get("SEAT-AIF-DM-D1")!;
  assert.equal(delta.stateLine, "Counted from Phoenix CRM since Saturday 03 Oct 2026 · set by ruling");
  assert.deepEqual([delta.territories, delta.reps], [3, 2], "a vacant territory is a territory with no rep");
  assert.deepEqual(delta.startOptions, [], "a running team offers no Start");
  assert.equal(delta.stopOptions[0], "2026-10-03", "and a Stop from its own Saturday on");

  const giza = byTeam.get("SEAT-CNS-DM-GZ")!;
  assert.equal(giza.stateLine, "Counted from Phoenix CRM from Saturday 17 Oct 2026 · started by Omar Gawish");
  assert.deepEqual(giza.stopOptions, [], "a start not reached yet offers only to take it back");
  assert.equal(giza.runningStartsOn, "2026-10-17");

  const alexandria = byTeam.get("SEAT-PED-DM-AX")!;
  assert.equal(alexandria.stateLine, "Back on iReports360 since Saturday 10 Oct 2026 · counted from Phoenix CRM Sat 03 Oct 2026 to Sat 10 Oct 2026");
  assert.equal(alexandria.startOptions[0], "2026-10-10", "a stopped team starts again only from its stop");
  assert.equal(alexandria.startDefault, "2026-10-17");

  const qena = byTeam.get("SEAT-PED-DM-QN")!;
  assert.equal(qena.stateLine, "Counted from Phoenix CRM since Saturday 03 Oct 2026, back on iReports360 from Saturday 24 Oct 2026");
  assert.equal(qena.startOptions[0], "2026-10-24");

  const cairo = byTeam.get("SEAT-CNS-DM-CA")!;
  assert.equal(cairo.stateLine, "Counted from iReports360");
  assert.equal(cairo.firstPlanLine, "Ahmed Ali sent a weekly plan for the week of Sat 17 Oct 2026", "the first real plan on a team not started is named on its row");
  assert.equal(cairo.startDefault, "2026-10-17");
  assert.equal(byTeam.get("SEAT-OLD-DM")!.territories, 0, "a start whose seat the organogram lost is still listed, and can be stopped");
  assert.ok(byTeam.get("SEAT-OLD-DM")!.stopOptions.length > 0);

  // The panel itself: a client component posting to the route, square, wrapping, the seat id only as a key.
  const panel = stripComments(read("src/components/crm/crm-phoenix-team-starts-panel.tsx"));
  assert.match(panel, /^"use client";/, "the Start and Stop buttons live in a client component");
  assert.match(panel, /fetch\("\/api\/crm\/phoenix-team-starts", \{\s*method: "POST",/);
  assert.match(panel, /startConfirmText\(pending\.day \?\? "", team\.reps\)/, "the confirm reads the same words the test pins");
  assert.match(panel, /stopConfirmText\(running \?\? "", pending\.day, team\.reps, cairoToday\)/);
  assert.match(panel, /id="phoenix-team-starts"/, "the notice's link lands on the panel");
  assert.equal(PHOENIX_TEAM_STARTS_PANEL_PATH, "/admin/crm#phoenix-team-starts");
  assert.doesNotMatch(panel, /rounded|overflow-x-auto|truncate|min-w-\[|whitespace-nowrap/, "square edges, no sideways scroll, nothing cut short");
  assert.match(panel, /key=\{team\.teamSeatId\}/, "the seat id is the row's key");
  assert.doesNotMatch(panel, />\s*\{team\.teamSeatId\}/, "and never its text");
  assert.doesNotMatch(panel, /…|\.\.\./, "no ellipsis anywhere");

  const page = stripComments(read("app/(admin)/admin/crm/page.tsx"));
  const gate = page.indexOf("redirect(resolveLandingPathForRole(access.role))");
  assert.ok(gate > 0 && gate < page.indexOf("loadPhoenixTeamStartsPanel()"), "the CRM hub is the Super Admin's: everyone else is redirected first");
  assert.match(page, /<CrmPhoenixTeamStartsPanel data=\{phoenixTeamStarts\} \/>/);

  // The loader reads; the writer is the function. Nothing in the app writes the table directly.
  const server = stripComments(read("src/lib/crm/phoenix-team-starts-server.ts"));
  assert.match(server, /\.from\(PHOENIX_CRM_TEAM_STARTS_TABLE\)\s*\.select\("id, team_seat_id, starts_on, stops_on, started_by, started_by_hr_id, note"\)/);
  assert.match(server, /\.from\(PHOENIX_CRM_TEAM_START_NOTICES_TABLE\)\.select\("team_seat_id, rep_hr_id, week_start"\)/);
  // Before the migration the panel says it is not set up — and the readiness board beside it
  // (src/lib/crm/phoenix-team-readiness.ts, 2026-10-03) says it cannot answer rather than printing
  // zeros, which would read as "nobody has a list".
  assert.match(
    server,
    /if \(isTableMissing\(startsRead\.error\)\) \{\s*return \{ provisioned: false, cairoToday, teams: \[\], readiness: unreadableTeamReadiness\(cairoToday\) \};\s*\}/,
    "before the migration, the panel says it is not set up",
  );
  assert.match(server, /\.rpc\(PHOENIX_CRM_SET_TEAM_START_RPC, \{\s*p: \{ action: input\.action, team_seat_id: input\.teamSeatId, day: input\.day, actor_hr_id: input\.actorHrId, actor_login_id: input\.actorLoginId \},\s*\}\)/);
  assert.match(server, /return access\.role === "Super Admin" \|\| access\.scope === "system";/, "the Super Admin alone");
  for (const file of sourceFiles("src").concat(sourceFiles("app"))) {
    const text = read(file);
    if (!text.includes("phoenix_crm_team_starts") && !text.includes("PHOENIX_CRM_TEAM_STARTS_TABLE")) continue;
    assert.doesNotMatch(stripComments(text), /\.from\((?:"phoenix_crm_team_starts"|PHOENIX_CRM_TEAM_STARTS_TABLE)\)[\s\S]{0,80}?\.(insert|update|upsert|delete)\(/, `${file} never writes a start except through the writer`);
  }
  assert.equal(PHOENIX_CRM_TEAM_STARTS_TABLE, "phoenix_crm_team_starts");
  assert.equal(PHOENIX_CRM_TEAM_START_NOTICES_TABLE, "phoenix_crm_team_start_notices");

  // THE ROUTE: Super Admin and the matrix permission, both asserted before the write.
  const route = stripComments(read("app/api/crm/phoenix-team-starts/route.ts"));
  const order = [
    "assertSameOriginMutation(request)",
    "resolveAccessContext(request)",
    "assertPhoenixTeamStartsAdmin(access)",
    'assertPermission(access, "crm_visits", "update")',
    "setPhoenixTeamStart({",
  ].map((call) => route.indexOf(call));
  assert.ok(order.every((index) => index > 0), "csrf, access, the Super Admin, the permission and the write are all there");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in that order: nothing is written before both gates");
  assert.match(route, /if \(error instanceof PhoenixTeamStartRefusal\) return NextResponse\.json\(\{ error: error\.message \}, \{ status: 409 \}\);/);
  assert.match(route, /if \(isForbiddenError\(error\)\) return NextResponse\.json\(\{ error: "Only the Super Admin starts or stops a team\." \}, \{ status: 403 \}\);/);
  const registry = read("src/lib/security/access-registry.ts");
  assert.ok(
    registry.includes(
      'sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/crm/phoenix-team-starts", permission: { resource: "crm_visits", action: "update" }, guard: "assert-permission", csrfRequired: true })',
    ),
    "the route is registered: an audited mutation, csrf-checked, behind the permission",
  );
  assert.match(read("src/lib/admin/audit.ts"), /\| "crm_phoenix_team_start"/, "the audit row's entity type is declared");
  assert.match(read("src/lib/admin/audit-entity-types.ts"), /crm_phoenix_team_start: true,/);
}

// ── The notice ─────────────────────────────────────────────────────────────────────────────────────

function runNoticeTests(): void {
  assert.deepEqual(
    teamNotStartedNotice({ team: "CNS Cairo Manager · CNS · Cairo", repName: "Ahmed Ali", weekStart: "2026-10-17" }),
    {
      title: "A team is planning in Phoenix CRM",
      message:
        "Ahmed Ali sent a weekly plan in Phoenix CRM for the week of Sat 17 Oct 2026. CNS Cairo Manager · CNS · Cairo is still counted from iReports360 on every other screen. Start it on the CRM page when you are ready.",
    },
    "the team, the rep and the week, by name",
  );
  assert.deepEqual(phoenixCrmChannels(PHOENIX_TEAM_NOT_STARTED_EVENT), ["in_app", "telegram", "push"], "in-app, Telegram and the phone — never email");

  const notice = stripComments(read("src/lib/crm/phoenix-team-start-notice.ts"));
  const testSkip = notice.indexOf('if (!row || row.is_test === true || row.status !== "submitted") return;');
  const claim = notice.indexOf(".from(PHOENIX_CRM_TEAM_START_NOTICES_TABLE)");
  const send = notice.indexOf("createSystemNotificationForRecipients(");
  assert.ok(testSkip > 0, "a test-world send, or a plan not sent for review, tells nobody");
  assert.ok(testSkip < claim && claim < send, "the team's row is claimed BEFORE anybody is told");
  assert.match(notice, /if \(isUniqueViolation\(claimError\)\) return;/, "a second send claims nothing and tells nobody");
  assert.match(notice, /start\.stops_on === null \|\| String\(start\.stops_on\)\.slice\(0, 10\) > weekStart/, "a team with a start running at that week is already in his hands");
  assert.match(notice, /resolveHrIdsForRole\("Super Admin", /, "the Super Admin is who is told");
  assert.match(notice, /channels: phoenixCrmChannels\(PHOENIX_TEAM_NOT_STARTED_EVENT\),/);
  assert.match(notice, /idempotencyKey: `phoenix_crm:team_not_started:\$\{teamSeatId\}`/, "once per team, whatever the delivery retries");
  assert.match(notice, /\} catch \(error\) \{\s*logError\(/, "a failure is logged, never thrown");
  assert.doesNotMatch(notice, /email:/, "no email block at all");

  const submit = stripComments(read("app/api/phoenix-crm/plans/submit/route.ts"));
  assert.match(submit, /import \{ after, NextResponse \} from "next\/server";/);
  assert.match(
    submit,
    /if \(action === "submit" && plan\.status === "submitted"\) after\(\(\) => noticeFirstPlanOnUnstartedTeam\(plan\.planId\)\);/,
    "the notice runs after the answer has gone, so it can never fail or slow the send",
  );
}

// ── 2. Nothing counted twice ─────────────────────────────────────────────────────────────────────────

type Start = { teamSeatId: string; startsOn: string; stopsOn: string | null };
type SeatRow = { seatId: string; parentSeatId: string | null; tier: string };
type Span = { seatId: string; hrId: string; from: string; until: string | null };
function within(day: string, from: string, until: string | null): boolean {
  return day >= from && (until === null || day < until);
}

/** phoenix_crm_started_team_seats, transcribed: each territory of a started team, with its start's days. */
function startedSeats(starts: readonly Start[], seats: readonly SeatRow[]) {
  return starts.flatMap((start) =>
    seats
      .filter((row) => row.parentSeatId === start.teamSeatId && row.tier === "REP")
      .map((row) => ({ seatId: row.seatId, startsOn: start.startsOn, stopsOn: start.stopsOn })),
  );
}

type Served = { system: "ireports360" | "phoenix"; who: string; day: string; double?: string | null };

/**
 * The visits door's three branches over a fixture, each predicate transcribed from the SQL pinned below.
 *
 * PHOENIX WINS THE DAY (owner, 2026-10-16): an iReports360 row drops only on a day its person has a
 * countable entry in Phoenix CRM — a real visit by that rep, or a recorded day activity of a counted kind,
 * on a REP seat of a started team (phoenix_crm_rep_entry_days). A district manager holds no rep seat, so
 * he has no entry day and keeps both systems.
 */
function serve(input: {
  starts: readonly Start[];
  seats: readonly SeatRow[];
  occupancy: readonly Span[];
  crmIds: Record<string, number>;
  vendor: ReadonlyArray<{ hrId: string | null; crmId: number | null; day: string }>;
  phoenix: ReadonlyArray<{ seatId: string; rep: string | null; manager: string | null; day: string; isTest?: boolean }>;
  activities: ReadonlyArray<{ seatId: string; rep: string; day: string; type: string; isTest?: boolean }>;
}): Served[] {
  const seats = startedSeats(input.starts, input.seats);
  const onSeat = (seatId: string, day: string) => seats.some((row) => row.seatId === seatId && within(day, row.startsOn, row.stopsOn));
  const kinds = ["meeting", "conference", "health_day", "sales_day", "training", "admin_work", "travel", "group_meeting", "rtd"];
  const countedVisits = input.phoenix.filter((row) => !row.isTest && onSeat(row.seatId, row.day));
  const countedActivities = input.activities.filter((row) => !row.isTest && kinds.includes(row.type) && onSeat(row.seatId, row.day));
  const entryDays = [
    ...countedVisits.filter((row) => row.rep).map((row) => ({ hrKey: row.rep!.trim().toLowerCase(), day: row.day })),
    ...countedActivities.map((row) => ({ hrKey: row.rep.trim().toLowerCase(), day: row.day })),
  ];
  const crmIdOf = (hrKey: string): number | null => input.crmIds[hrKey.toUpperCase()] ?? null;
  const vendor = input.vendor
    .filter((row) => {
      const key = row.hrId?.trim().toLowerCase() ?? "";
      if (key) return !entryDays.some((entry) => entry.hrKey === key && entry.day === row.day);
      return !entryDays.some((entry) => crmIdOf(entry.hrKey) !== null && crmIdOf(entry.hrKey) === row.crmId && entry.day === row.day);
    })
    .map((row): Served => ({ system: "ireports360", who: row.hrId ?? `crm:${row.crmId}`, day: row.day }));
  const visits = countedVisits.map((row): Served => ({ system: "phoenix", who: (row.rep ?? row.manager)!, day: row.day, double: row.rep ? row.manager : null }));
  const activities = countedActivities.map((row): Served => ({ system: "phoenix", who: row.rep, day: row.day }));
  return [...vendor, ...visits, ...activities];
}

function runNoDoubleCountTests(code: string): void {
  const view = viewSql(VISITS_DOOR, "crm_visits_unified");
  const [vendorBranch, visitBranch, activityBranch] = view.split("\nunion all\n");
  assert.ok(vendorBranch && visitBranch && activityBranch, "three branches: iReports360, Phoenix visits, Phoenix day activities");

  const vendor = flat(vendorBranch);
  // ONE SCAN, AND THE ENTRY DAY IS AN INDEX LOOKUP (speed, 2026-10-23). Until 20261024005000 the vendor rows
  // were read in TWO union-all runs split at Phoenix CRM's first day, so one read scanned ireports360_visits
  // twice; and both checks asked a MATERIALIZED CTE over phoenix_crm_rep_entry_days(), which a function scan
  // left the planner no way to index — all 542 entry days were walked once per vendor row (4,052 join-filter
  // evaluations thrown away on one October day). Measured on production, nine interleaved runs of each shape:
  // a day 17.0 -> 7.8 ms, a month straddling that first day 563 -> 320 ms, every row byte-identical.
  assert.equal(
    view.split("phoenix_crm_rep_entry_days()").length - 1,
    0,
    "the door does not call phoenix_crm_rep_entry_days() at all any more — a function scan carries no index",
  );
  assert.doesNotMatch(vendor, /entry_days as materialized/, "and there is no materialized CTE left to walk per row");
  // THE RULE DID NOT MOVE, THE READ DID. phoenix_crm_rep_entry_days_calc() is still the one body that computes
  // an entry day; the door reads the table that body writes, so it gets the cache's PRIMARY KEY
  // (hr_key, entry_day) and its partial (agent_crm_id, entry_day) index. Both are granted to postgres and
  // service_role alone — the door's own two grantees, both BYPASSRLS — so the reach is unchanged.
  assert.equal(
    view.split("public.phoenix_crm_rep_entry_days_cache").length - 1,
    2,
    "it reads the cache table directly, once per check and no more",
  );
  // BEFORE PHOENIX CRM'S FIRST DAY no rep can have an entry, so a vendor row dated earlier asks nothing: the
  // bound is the earliest team start, or its earlier day_activities_from, and no entry day precedes it (the
  // entry-day clauses pinned below). That bound is now an arm of ONE scan, not a second branch.
  const firstDay =
    "( select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date) from public.phoenix_crm_team_starts t )";
  const cutover = "x.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)";
  assert.equal(
    vendor.split("from public.ireports360_visits x").length - 1,
    1,
    "the vendor table is scanned ONCE, not once per side of the split",
  );
  assert.ok(
    vendor.includes(`from ( select x.* from public.ireports360_visits x where ${cutover} and ( x.visit_date < ${firstDay} or ( not exists`),
    "one scan, the cutover bound on it, and the first-day bound as the first arm of the choice",
  );
  assert.ok(
    vendor.includes(
      "not exists ( select 1 from public.phoenix_crm_rep_entry_days_cache e where e.hr_key = lower(btrim(x.agent_hr_id)) and e.entry_day = x.visit_date )",
    ),
    "PHOENIX WINS THE DAY: an iReports360 row leaves the branch only on a day its rep has a Phoenix entry",
  );
  assert.ok(
    vendor.includes(
      "and not exists ( select 1 from public.phoenix_crm_rep_entry_days_cache e where nullif(btrim(x.agent_hr_id), '') is null " +
        "and e.agent_crm_id = x.agent_crm_id and e.entry_day = x.visit_date ) ) ) ) v",
    ),
    "a vendor row with no hr id is still his, by his CRM id, and the choice closes before the scan does",
  );
  assert.doesNotMatch(vendor, /phoenix_crm_started_team_reps|counted_from|counted_until/, "and no longer from the start's window: a day with no Phoenix entry keeps its iReports360 rows");

  // The entry days themselves: a real visit by a REP on a started rep seat, or a recorded day activity of a
  // counted kind on one — the team's OWN seat is left out, so a district manager keeps both systems. Their two
  // lower bounds (a visit from its start, an activity from the earlier of the start and day_activities_from)
  // are what make the doors' split at Phoenix CRM's first day safe: loosen either and that bound must move too.
  //
  // THE RULE MOVED, IT DID NOT CHANGE (2026-10-23). `phoenix_crm_rep_entry_days()` now serves a cached
  // table and `phoenix_crm_rep_entry_days_calc()` holds the ONE body every write path recomputes through,
  // so these clauses are read from `_calc`. The reader is pinned below to serve the cache and never to
  // carry a second copy of the rule — which is the property that keeps one definition of "Phoenix wins
  // the day" after the cache.
  const entryDays = flat(
    functionSql(
      lastDefinerSql(/create or replace function public\.phoenix_crm_rep_entry_days_calc\(/, "phoenix_crm_rep_entry_days_calc"),
      "phoenix_crm_rep_entry_days_calc",
    ),
  );
  for (const clause of [
    "returns table(hr_key text, agent_crm_id bigint, entry_day date) language sql stable security definer rows 400 set search_path to 'public'",
    "select lower(btrim(p.rep_hr_id)) as hr_key, p.visit_date as entry_day from public.phoenix_crm_countable_visits p join public.phoenix_crm_started_team_seats() team on team.seat_id = p.seat_id and p.visit_date >= team.starts_on and (team.stops_on is null or p.visit_date < team.stops_on) where not p.is_test and nullif(btrim(p.rep_hr_id), '') is not null",
    "join public.phoenix_crm_started_team_seats() team on team.seat_id = a.seat_id",
    "a.activity_date >= least(team.starts_on, coalesce(run.day_activities_from, team.starts_on))",
    "and a.activity_type in ('meeting', 'conference', 'health_day', 'sales_day', 'training', 'admin_work', 'travel', 'group_meeting', 'rtd')",
    "where upper(btrim(emp.hr_id)) = upper(e.hr_key)",
  ]) {
    assert.ok(entryDays.includes(clause), `the entry days hold: ${clause}`);
  }
  assert.doesNotMatch(entryDays, /phoenix_crm_team_starts s\b|union all|team_seat_id, s\.team_seat_id/, "the team's own (district manager's) seat is no entry day");
  assert.doesNotMatch(entryDays, /lower\(btrim\(emp\.hr_id\)\)/, "the employee lookup uses the indexed upper(btrim()) expression, never lower()");
  const entryDaysSql = lastDefinerSql(/create or replace function public\.phoenix_crm_rep_entry_days\(/, "phoenix_crm_rep_entry_days");
  assert.match(entryDaysSql, /revoke execute on function public\.phoenix_crm_rep_entry_days\(\) from public, anon, authenticated;/);
  assert.match(entryDaysSql, /grant execute on function public\.phoenix_crm_rep_entry_days\(\) to service_role;/);
  // ONE BODY (2026-10-23): the reader serves the cache, and the rule itself exists only in `_calc` above.
  const entryDaysReader = flat(functionSql(entryDaysSql, "phoenix_crm_rep_entry_days"));
  assert.ok(
    entryDaysReader.includes("from public.phoenix_crm_rep_entry_days_cache c"),
    "the entry-days reader serves the cached table",
  );
  assert.ok(
    !entryDaysReader.includes("phoenix_crm_countable_visits") && !entryDaysReader.includes("phoenix_crm_day_activities"),
    "and never recomputes the rule itself — that lives once, in phoenix_crm_rep_entry_days_calc",
  );
  assert.ok(
    flat(visitBranch).includes(
      "join public.phoenix_crm_started_team_seats() team on team.seat_id = p.seat_id and p.visit_date >= team.starts_on and (team.stops_on is null or p.visit_date < team.stops_on)",
    ),
    "a Phoenix visit is served only on a started team's territory, for the days of its start",
  );
  assert.ok(
    flat(activityBranch).includes(
      "join ( select t.seat_id, t.team_seat_id, t.starts_on, t.stops_on from public.phoenix_crm_started_team_seats() t union " +
        "select s.team_seat_id, s.team_seat_id, s.starts_on, s.stops_on from public.phoenix_crm_team_starts s ) team on team.seat_id = a.seat_id",
    ),
    "and so is a day activity — on a territory, or on the team's own seat where a district manager's day sits",
  );
  // Owner, 2026-10-10: Cairo and Giza's go-live training of 7 Oct counts although their start is 10 Oct.
  // The gate may only move EARLIER than the start (least), never later, and never past the stop.
  assert.ok(
    flat(activityBranch).includes(
      "a.activity_date >= least(team.starts_on, coalesce(run.day_activities_from, team.starts_on)) and (team.stops_on is null or a.activity_date < team.stops_on)",
    ),
    "a day activity counts from the team's start, or from its day_activities_from when that is earlier",
  );
  assert.ok(
    flat(activityBranch).includes(
      "left join public.phoenix_crm_team_starts run on run.team_seat_id = team.team_seat_id and run.starts_on = team.starts_on and run.stops_on is not distinct from team.stops_on",
    ),
    "the day_activities_from is read from the SAME start run the territory came from",
  );
  assert.ok(
    !flat(visitBranch).includes("day_activities_from"),
    "a VISIT never counts before the start — only the recorded day activity does",
  );
  assert.ok(
    flat(functionSql(code, "phoenix_crm_started_team_seats")).includes(
      "select s.seat_id, s.parent_seat_id, t.starts_on, t.stops_on from public.phoenix_crm_team_starts t join au.seats s on s.parent_seat_id = t.team_seat_id and s.seat_tier = 'REP'",
    ),
    "a team's territories are the REP seats under its seat",
  );
  assert.ok(
    flat(functionSql(code, "phoenix_crm_started_team_reps")).includes(
      "select w.seat_id, btrim(o.occupant_hr_id), lower(btrim(o.occupant_hr_id)), person.agent_crm_id, greatest(o.effective_from, w.starts_on), least(o.effective_to, w.stops_on) " +
        "from ( select territory.seat_id, territory.starts_on, territory.stops_on from public.phoenix_crm_started_team_seats() territory " +
        "union all select t.team_seat_id, t.starts_on, t.stops_on from public.phoenix_crm_team_starts t ) w " +
        "join au.occupancy_history o on o.seat_id = w.seat_id",
    ),
    "the people are whoever SAT on those territories — or on the team's own seat (\"Yes, the whole team\") — from the seat history",
  );
  assert.ok(
    flat(functionSql(code, "phoenix_crm_started_team_reps")).includes(
      "where nullif(btrim(o.occupant_hr_id), '') is not null and (least(o.effective_to, w.stops_on) is null or least(o.effective_to, w.stops_on) > greatest(o.effective_from, w.starts_on))",
    ),
    "from the later of the start and the day they sat down, to the earlier of the stop and the day they left",
  );

  // Team T started Saturday 3 Oct, stopped from Saturday 24 Oct. R1: A throughout; R2: B until Tue
  // 6 Oct, then C. D holds the team's own seat (its district manager). E is on a team never started.
  // F sits on R3 from 10 Oct; his vendor rows carry no hr id, only his CRM id.
  const served = serve({
    starts: [{ teamSeatId: "T", startsOn: "2026-10-03", stopsOn: "2026-10-24" }],
    seats: [
      { seatId: "R1", parentSeatId: "T", tier: "REP" },
      { seatId: "R2", parentSeatId: "T", tier: "REP" },
      { seatId: "R3", parentSeatId: "T", tier: "REP" },
      { seatId: "R9", parentSeatId: "U", tier: "REP" },
      { seatId: "T", parentSeatId: "NSM", tier: "DM" },
      { seatId: "U", parentSeatId: "NSM", tier: "DM" },
    ],
    occupancy: [
      { seatId: "R1", hrId: "A-1", from: "2025-01-01", until: null },
      { seatId: "R2", hrId: "B-2", from: "2025-01-01", until: "2026-10-06" },
      { seatId: "R2", hrId: "c-3", from: "2026-10-06", until: null },
      { seatId: "R3", hrId: "F-6", from: "2026-10-10", until: null },
      { seatId: "T", hrId: "D-4", from: "2025-01-01", until: null },
      { seatId: "U", hrId: "G-7", from: "2025-01-01", until: null },
      { seatId: "R9", hrId: "E-5", from: "2025-01-01", until: null },
    ],
    crmIds: { "F-6": 6006 },
    vendor: [
      { hrId: "A-1", crmId: 1001, day: "2026-09-30" },
      { hrId: "A-1", crmId: 1001, day: "2026-10-04" },
      { hrId: "A-1", crmId: 1001, day: "2026-10-26" },
      { hrId: "B-2", crmId: 2002, day: "2026-10-05" },
      { hrId: "B-2", crmId: 2002, day: "2026-10-07" },
      { hrId: "C-3", crmId: 3003, day: "2026-10-05" },
      { hrId: "C-3", crmId: 3003, day: "2026-10-07" },
      { hrId: "D-4", crmId: 4004, day: "2026-10-01" },
      { hrId: "D-4", crmId: 4004, day: "2026-10-04" },
      { hrId: "G-7", crmId: 7007, day: "2026-10-04" },
      { hrId: "E-5", crmId: 5005, day: "2026-10-04" },
      { hrId: null, crmId: 6006, day: "2026-10-08" },
      { hrId: null, crmId: 6006, day: "2026-10-12" },
      { hrId: null, crmId: 6006, day: "2026-10-13" },
      { hrId: null, crmId: 9999, day: "2026-10-12" },
    ],
    phoenix: [
      { seatId: "R1", rep: "A-1", manager: null, day: "2026-10-01" },
      { seatId: "R1", rep: "A-1", manager: null, day: "2026-10-04" },
      { seatId: "R1", rep: "A-1", manager: null, day: "2026-10-04", isTest: true },
      { seatId: "R1", rep: "A-1", manager: "D-4", day: "2026-10-05" },
      { seatId: "R2", rep: null, manager: "D-4", day: "2026-10-04" },
      { seatId: "R2", rep: "B-2", manager: null, day: "2026-10-05" },
      { seatId: "R2", rep: "C-3", manager: null, day: "2026-10-07" },
      { seatId: "R1", rep: "A-1", manager: null, day: "2026-10-26" },
      { seatId: "R9", rep: "E-5", manager: null, day: "2026-10-04" },
      { seatId: "R3", rep: "F-6", manager: null, day: "2026-10-12" },
    ],
    activities: [
      { seatId: "R1", rep: "A-1", day: "2026-10-01", type: "meeting" },
      { seatId: "R1", rep: "A-1", day: "2026-10-06", type: "training" },
      { seatId: "R1", rep: "A-1", day: "2026-10-07", type: "training", isTest: true },
      { seatId: "R1", rep: "A-1", day: "2026-10-08", type: "something_new" },
    ],
  });
  const systemsOn = (who: string, day: string) =>
    served
      .filter((row) => row.who.toLowerCase() === who.toLowerCase() && row.day === day)
      .map((row) => row.system)
      .sort();

  assert.deepEqual(systemsOn("A-1", "2026-09-30"), ["ireports360"], "before the start iReports360 stays the source — Delta's 30 September is kept");
  assert.deepEqual(systemsOn("A-1", "2026-10-01"), [], "and nothing Phoenix is served before the start (onboarding stays out)");
  assert.deepEqual(systemsOn("A-1", "2026-10-04"), ["phoenix"], "on a day with a Phoenix entry, Phoenix INSTEAD of iReports360 — once, the test row left out");
  assert.deepEqual(systemsOn("A-1", "2026-10-26"), ["ireports360"], "a stop gives the vendor rows back from its Saturday, and serves no Phoenix row after it");
  assert.deepEqual(systemsOn("A-1", "2026-10-06"), ["phoenix"], "a recorded day activity is an entry too: that day is Phoenix's");
  assert.deepEqual(systemsOn("B-2", "2026-10-05"), ["phoenix"], "a rep with a Phoenix entry that day speaks through Phoenix only");
  assert.deepEqual(systemsOn("B-2", "2026-10-07"), ["ireports360"], "a rep with no Phoenix entry that day (he left the seat) keeps his iReports360 row");
  assert.deepEqual(systemsOn("C-3", "2026-10-05"), ["ireports360"], "a rep keeps every iReports360 day on which he made no Phoenix entry (any casing)");
  assert.deepEqual(systemsOn("C-3", "2026-10-07"), ["phoenix"], "and is counted from Phoenix on a day he has an entry");
  assert.deepEqual(systemsOn("D-4", "2026-10-01"), ["ireports360"], "the district manager's vendor rows before the start stay");
  assert.deepEqual(
    systemsOn("D-4", "2026-10-04"),
    ["ireports360", "phoenix"],
    "A DISTRICT MANAGER KEEPS BOTH (owner, 2026-10-16): he has no rep entry day, so his iReports360 row stays beside his own Phoenix visit",
  );
  assert.equal(served.find((row) => row.who === "A-1" && row.day === "2026-10-05")?.double, "D-4", "the double visit he makes credits him as the partner");
  assert.deepEqual(systemsOn("G-7", "2026-10-04"), ["ireports360"], "a district manager of a team never started is untouched");
  assert.deepEqual(systemsOn("E-5", "2026-10-04"), ["ireports360"], "a team never started keeps iReports360, and its Phoenix visits are not served");
  assert.deepEqual(systemsOn("crm:6006", "2026-10-08"), ["ireports360"], "a CRM-id-only row on a day he made no Phoenix entry stays");
  assert.deepEqual(systemsOn("crm:6006", "2026-10-12"), [], "and leaves on a day he has one, by his CRM id");
  assert.deepEqual(systemsOn("crm:6006", "2026-10-13"), ["ireports360"], "the next day, with no entry, it is the vendor's again");
  assert.deepEqual(systemsOn("crm:9999", "2026-10-12"), ["ireports360"], "a CRM id nobody on the team holds is untouched");
  assert.deepEqual(systemsOn("A-1", "2026-10-06"), ["phoenix"], "a recorded training day is a worked day from Phoenix (and, as an entry, wins that day)");
  assert.deepEqual(systemsOn("A-1", "2026-10-07"), [], "never a test one");
  assert.deepEqual(systemsOn("A-1", "2026-10-08"), [], "and never a kind the view has not been given a worked-day code for");

  // One Phoenix row per visit: the people it joins are one row per person, whatever the casing.
  // `partner1` and `partner2` since 2026-10-07 — the door carries BOTH people on a chain visit, and
  // each lookup has to stay one-row-per-person or a second slot would double the visit outright.
  //
  // THE LOOKUP MOVED, IT DID NOT CHANGE (2026-10-23). Each slot used to inline
  // `select distinct on (upper(btrim(e.hr_id))) ... order by upper(btrim(e.hr_id)), e.hr_id`, so one
  // read sorted all 220 employees once per slot. The rule now lives once, in
  // `crm_person_by_hr_key_calc()`, behind `crm_person_by_hr_key_cache` — whose PRIMARY KEY on hr_key
  // is what now makes "one row per person" unbreakable, rather than each site remembering to say
  // `distinct on`. Pinned in full by tests/crm-person-by-hr-key-cache.test.ts.
  for (const role of ["agent", "partner1", "partner2"]) {
    assert.ok(
      flat(visitBranch).includes(
        `left join public.crm_person_by_hr_key_cache ${role} on ${role}.hr_key = upper(btrim(`,
      ),
      `the ${role} lookup is one row per person, so it can never double a visit`,
    );
  }
  assert.ok(
    !flat(visitBranch).includes("distinct on (upper(btrim(e.hr_id)))"),
    "and no slot keeps a second copy of that rule inline",
  );
  // ONE CUSTOMER PER VISIT, AND THE JOIN IS A LEFT ONE ON PURPOSE (speed, 2026-10-24, 20261024180000).
  // It cannot drop a row either way: phoenix_crm_visits.customer_id is NOT NULL and
  // phoenix_crm_visits_customer_id_fkey references phoenix_crm_customers(id) VALIDATED, so every visit has
  // exactly one customer row, and on a unique key LEFT and INNER return the same rows. The word is what lets
  // the planner REMOVE the join outright for a read that selects none of the four columns it feeds
  // (contact_crm_id, contact_name, speciality, crm_contact_grade): Postgres drops a left join to a unique key
  // nothing selects, and will NOT use a foreign key to reach that conclusion about an inner one — the sibling
  // left join to this same table inside phoenix_crm_countable_visits disappeared from such a plan while this
  // one, four lines away, was paid in full. Measured on production as a true A/B, both bodies alternating in
  // one session: the 8-column month read goes from 22,508 buffers to 8,808, and all 148,814 rows of the door
  // hash the same either way (5a6976bcf91c994b338516e4d8c690ca).
  //
  // 🔴 ASSERTED WHOLE, BOTH WAYS, because "join public.phoenix_crm_customers" is a SUBSTRING of the left-join
  // text: the single includes() this replaced went green on either word and so pinned nothing at all.
  assert.ok(
    flat(visitBranch).includes("left join public.phoenix_crm_customers customer on customer.id = p.customer_id"),
    "one customer per visit, and LEFT so a read wanting no customer column pays nothing for it",
  );
  assert.ok(
    !/(?<!left )join public.phoenix_crm_customers/.test(flat(visitBranch)),
    "and no inner join to the customers table came back",
  );

  // The Phoenix CRM List's "iReports360 history" reads vendor rows only, so the visits it already shows
  // as "saved here" are never counted a second time beside them.
  // Since 2026-10-16 it is counted in the database (phx_crm_contact_visit_history) and the page walk
  // answers only where that function has not been applied — both read vendor rows only.
  const reads = stripComments(read("src/lib/crm/reads.ts"));
  const history = reads.slice(reads.indexOf("async function readContactVisitHistoryPaged("), reads.indexOf("\n}\n", reads.indexOf("async function readContactVisitHistoryPaged(")));
  assert.match(history, /\.eq\("source", IREPORTS360_VISIT_SOURCE\)/, "the List's iReports360 history reads iReports360 rows only");
  const countedHistory = flat(
    stripSqlComments(read("supabase/migrations/20261016180202_crm_contact_history_and_plan_dates_counted_in_sql.sql")),
  );
  assert.ok(
    countedHistory.includes("from public.crm_visits_unified v where v.source = 'ireports360' and v.contact_crm_id = any (p_contact_crm_ids)"),
    "and the count in the database reads iReports360 rows only",
  );
  assert.ok(
    countedHistory.includes("from public.crm_plan_entries_unified p where p.source = 'ireports360' and p.contact_crm_id = any (p_contact_crm_ids)"),
    "and so do the reference plan days the List's pattern is read from",
  );
  assert.equal(IREPORTS360_VISIT_SOURCE, "ireports360");
  assert.equal(PHOENIX_VISIT_SOURCE, "phoenix");
}

// ── 3. The Phoenix row's shape: AM · PM · Pharmacies apart, countable and real only, worked days ────

/** Every column the Phoenix visit branch may read off a visit. Anything else — location, accuracy, photo,
 * voice, dwell, capture source, offline sync — is golden rule #1's and never leaves Phoenix CRM.
 *
 * `product_manager_hr_id` and `senior_hr_id` joined the list on 2026-10-07. They are not integrity
 * columns: they are the OTHER PEOPLE WHO WERE THERE, which the vendor shape has always carried in its
 * own partner slot (121 Product Managers, a Group Product Manager, an RSM, a Training Manager and a
 * Marketing Manager since 1 September). Leaving them out is what made a product-manager visit carry
 * nobody and a chain visit lose its second person. */
const VISIT_COLUMNS_CARRIED = new Set([
  "captured_at",
  "comment",
  "created_at",
  "customer_id",
  "customer_validated",
  "id",
  "is_test",
  "list_type",
  "manager_hr_id",
  "product_manager_hr_id",
  "rep_hr_id",
  "seat_id",
  "senior_hr_id",
  "visit_date",
  // THE PHOENIX FIELD SET, 2026-10-07 — the owner's own ruling, asked directly and answered
  // "everything, GPS and evidence included". Golden rule #1 did not loosen: it moved from the DOOR to
  // the READER. The door carries the field set so an admin report can print it; WHO sees which half is
  // decided once, in `src/lib/crm/phoenix-visit-detail.ts`, against his 2026-10-02 three tiers —
  // mock-location evidence to the Super Admin alone, the DISTANCE ONLY to every reader below Super
  // Admin and SFE Manager, and a reader on his own row as its rep fully blind. The rep's own portal
  // My Visits is pinned below to select NONE of these.
  "accuracy_meters",
  "capture_source",
  "device_skew_minutes",
  "distance_meters",
  "dwell_seconds",
  "entered_by_hr_id",
  "form_open_seconds",
  "is_unplanned",
  "kind",
  "lat",
  "location_flag",
  "lon",
  "next_step",
  "next_step_on",
  "objection",
  "objection_note",
  "offline_seconds",
  "pharmacy_name",
  "photo_accuracy_meters",
  "photo_lat",
  "photo_lon",
  "photo_path",
  "product_availability",
  "products",
  "samples_given",
  "synced_at",
  "unplanned_kind",
  "voice_note_path",
  "voice_note_seconds",
]);
const ACTIVITY_COLUMNS_CARRIED = new Set(["activity_date", "activity_type", "created_at", "id", "is_test", "note", "rep_hr_id", "seat_id", "updated_at"]);

/** The worked-day code each recorded day activity is served under. */
const ACTIVITY_CODES: ReadonlyArray<{ kind: string; code: number; description: string }> = [
  { kind: "meeting", code: -11, description: "Meeting" },
  { kind: "conference", code: -1, description: "Conference" },
  { kind: "health_day", code: -15, description: "Health Day" },
  { kind: "sales_day", code: -7, description: "Sales day" },
  { kind: "training", code: -9, description: "Training" },
  { kind: "admin_work", code: -20, description: "Admin Work" },
  { kind: "travel", code: -12, description: "Traveling" },
  { kind: "group_meeting", code: -2, description: "Group Meeting" },
  { kind: "rtd", code: -22, description: "RTD" },
];

function runRowShapeTests(code: string): void {
  const view = viewSql(VISITS_DOOR, "crm_visits_unified");
  const [vendorBranch, visitBranch, activityBranch] = view.split("\nunion all\n");

  // COUNTABLE AND REAL ONLY.
  assert.ok(flat(visitBranch).includes("from public.phoenix_crm_countable_visits p"), "the module's own predicate for 'this visit counts', read and never re-typed");
  assert.ok(flat(visitBranch).endsWith("where not p.is_test"), "never a test account's visit");
  assert.doesNotMatch(view, /public\.phoenix_crm_visits\b/, "the view never reads the raw visits table, so an unapproved off-plan visit never counts");
  // 🔴 THE APPROVAL RULE IS STILL THE COUNTABLE VIEW'S, AND THE DOOR STILL NEVER RE-TYPES IT. From
  // 2026-10-07 the door CARRIES `is_unplanned` and `unplanned_kind` for the admin reports to print —
  // an off-plan visit and the reason the rep gave for it. Printing them is not deciding with them: the
  // test therefore moved from "the words never appear" to "the words appear only as a column being
  // selected, never in a predicate", which is the thing that would silently fork the count.
  const visitSelect = itemsOf(visitBranch, "from public.phoenix_crm_countable_visits p");
  const approvalItems = visitSelect.filter((item) => /is_unplanned|unplanned_kind|status/.test(item));
  assert.deepEqual(
    approvalItems,
    ["p.is_unplanned", "p.unplanned_kind"],
    "the only approval-shaped things the Phoenix branch names are the two columns it prints, bare",
  );
  const visitPredicate = flat(visitBranch).slice(flat(visitBranch).indexOf("from public.phoenix_crm_countable_visits p"));
  assert.doesNotMatch(
    visitPredicate,
    /is_unplanned|unplanned_kind|status/,
    "and nothing below the select list tests them — the countable view alone decides which visits count",
  );

  const vendorItems = itemsOf(vendorBranch, "from (\n");
  const phoenixItems = itemsOf(visitBranch, "from public.phoenix_crm_countable_visits p");
  assert.equal(vendorItems.length, 64, "the 30 columns, the four appended in #5477, the 29 of the Phoenix field set, and companion_hr_ids (2026-10-27)");
  assert.equal(phoenixItems.length, vendorItems.length, "both branches carry the same columns, item for item");
  const names = vendorItems.map(outputName);
  const phoenix = new Map(names.map((name, index): [string, string] => [name, phoenixItems[index]]));

  // The iReports360 branch is the previous view word for word, with four columns APPENDED. Appended and
  // never inserted, because a caller reading by position must keep reading the same column — and
  // because `create or replace view` accepts a new column only at the end of the list.
  // Since 20261022163000 four of them carry what Phoenix holds: the doctor's validated name and speciality,
  // and the person's own name for the agent and the double-visit partner.
  assert.deepEqual(
    vendorItems.slice(0, 30),
    withPhoenixOverrides(previousItems("crm_visits_unified", "from public.ireports360_visits v"), {
      agent_name: PERSON_NAME("agent_name", "agent_person"),
      double_name: PERSON_NAME("double_name", "double_person"),
      contact_name: "coalesce(truth.name, v.contact_name) as contact_name",
      speciality: "coalesce(truth.speciality, v.speciality) as speciality",
    }),
    "the first 30 columns keep their names, types and order",
  );
  assert.deepEqual(
    names.slice(30),
    [
      "phoenix_customer_validated",
      "double2_crm_id",
      "double2_name",
      "double2_hr_id",
      "visit_kind",
      "entered_by_hr_id",
      "products",
      "samples_given",
      "product_availability",
      "objection",
      "objection_note",
      "next_step",
      "next_step_on",
      "visit_pharmacy_name",
      "is_unplanned",
      "unplanned_kind",
      "photo_path",
      "voice_note_path",
      "voice_note_seconds",
      "lat",
      "lon",
      "accuracy_meters",
      "distance_meters",
      "location_flag",
      "photo_lat",
      "photo_lon",
      "photo_accuracy_meters",
      "dwell_seconds",
      "form_open_seconds",
      "capture_source",
      "offline_seconds",
      "device_skew_minutes",
      "phoenix_synced_at",
      "companion_hr_ids",
    ],
    "the appended columns, in the order they were added",
  );
  assert.deepEqual(
    vendorItems.slice(30, 34),
    [
      "null::boolean as phoenix_customer_validated",
      "null::bigint as double2_crm_id",
      "null::text as double2_name",
      "null::text as double2_hr_id",
    ],
    "and every one of them is null on an iReports360 row — the vendor shape records ONE partner",
  );
  // THE PHOENIX FIELD SET IS NULL ON A VENDOR ROW, every one of the 29, each cast so the two branches
  // agree on a type. iReports360 recorded none of it: no products, no samples, no GPS, no evidence and
  // no timing. A blank is the honest answer there, and a `0` would have read as "stood at the door for
  // no time at all" on a day the vendor simply never measured.
  for (const item of vendorItems.slice(34)) {
    assert.match(item, /^null::[a-z ]+(\[\])? as [a-z0-9_]+$/, `the vendor branch's "${item}" is a typed null, not a value`);
  }
  assert.ok(
    flat(vendorBranch).includes(
      "from ( select x.* from public.ireports360_visits x where x.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date) and ( x.visit_date < (",
    ),
    "the iReports360 branch keeps its source and its cutover clause on its one scan (20261024005000)",
  );

  const expected: Record<string, string> = {
    id: "p.id",
    crm_visit_id: "-1 - ('x' || substr(md5(p.id::text), 1, 13))::bit(52)::bigint",
    visit_date: "p.visit_date",
    agent_hr_id: "coalesce(p.rep_hr_id, p.manager_hr_id)",
    // SLOT 1 — the manager who rode along, else the product manager, else the senior. Reading
    // manager_hr_id alone is what made a 'product_manager' visit carry nobody: that column is null on
    // all 18 live ones, so 18 of Ahmed SharafEldeen's visits read as a day he did not work.
    double_hr_id: "case when p.rep_hr_id is not null then coalesce(p.manager_hr_id, p.product_manager_hr_id, p.senior_hr_id) end",
    // A doctor born in Phoenix CRM has no vendor id and answers to his own, out of the reserved
    // positive range — so no per-doctor report drops him. 923 of 12,574 customers, and growing daily.
    contact_crm_id: "coalesce(customer.reference_contact_crm_id, customer.own_contact_crm_id)",
    contact_name: "customer.name",
    customer_name: "null::text",
    comment: "p.comment",
    visit_type: "0",
    visit_type_description: "'Regular Visit'::text",
    call_type: "null::integer",
    ampm: "p.list_type",
    attendance: "null::integer",
    crm_save_date: "(p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC'",
    raw_payload: "null::jsonb",
    synced_at: "p.created_at",
    created_at: "p.created_at",
    updated_at: "p.created_at",
    visit_date_time: "(p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC'",
    crm_region_id: "null::integer",
    crm_region_name: "null::text",
    speciality: "customer.speciality",
    crm_contact_grade: "customer.grade",
    source: "'phoenix'::text",
    phoenix_customer_validated: "p.customer_validated",
  };
  for (const [column, expression] of Object.entries(expected)) {
    assert.equal(phoenix.get(column), expression, `a Phoenix visit's ${column} is ${expression}`);
  }
  assert.match(phoenix.get("agent_crm_id") ?? "", /^case when agent\.crm_id ~ '\^\[0-9\]\+\$' then agent\.crm_id::bigint end$/, "the agent's own CRM id, when he has one");
  assert.match(phoenix.get("double_crm_id") ?? "", /^case when p\.rep_hr_id is not null and partner1\.crm_id ~ /, "a partner only when a rep was there with somebody");
  assert.match(phoenix.get("exclusion_crm_id") ?? "", /^coalesce\(case when agent\.crm_id ~ .+ then agent\.crm_id::bigint end, -1::bigint\)$/);

  // SLOT 2 — the chain's other person, and the rule that keeps it from ever doubling a figure: it is
  // filled only from a column slot 1 did not take, so one visit stays one row with at most two people
  // beside the rep. Measured on production 2026-10-07 across all 743 real visits: no row sets all
  // three columns, and `senior_hr_id` never appears without `manager_hr_id`.
  assert.equal(
    flat(phoenix.get("double2_hr_id") ?? ""),
    "case when p.rep_hr_id is not null then case when p.manager_hr_id is not null then coalesce(p.senior_hr_id, p.product_manager_hr_id) when p.product_manager_hr_id is not null then p.senior_hr_id end end",
    "slot 2 is the senior above the manager, or the product manager who came with him",
  );
  assert.match(phoenix.get("double2_crm_id") ?? "", /^case when p\.rep_hr_id is not null and partner2\.crm_id ~ /, "slot 2's CRM id, when that person has one");
  assert.equal(phoenix.get("double2_name"), "case when p.rep_hr_id is not null then partner2.full_name end", "and his real name, never a CRM handle");
  // A district manager's OWN visit (rep_hr_id null, manager_hr_id himself) still names nobody beside
  // him: 4 live rows are that shape, and crediting himself as his own partner would invent a double.
  for (const column of ["double_crm_id", "double_name", "double_hr_id", "double2_crm_id", "double2_name", "double2_hr_id"]) {
    assert.match(phoenix.get(column) ?? "", /p\.rep_hr_id is not null/, `${column} is empty on a manager's own visit`);
  }

  // DAY ACTIVITIES — recorded, real, each under the code the readers already treat as a WORKED day.
  const activity = flat(activityBranch);
  assert.ok(activity.includes("from public.phoenix_crm_day_activities a"), "the recorded day activities — never a planned one");
  assert.ok(activity.endsWith("and a.activity_type in ('meeting', 'conference', 'health_day', 'sales_day', 'training', 'admin_work', 'travel', 'group_meeting', 'rtd');"), "real only, of a kind the view names");
  assert.ok(activity.includes("where not a.is_test and a.activity_date >= least("), "real only — never a test account's day");
  assert.ok(
    activity.includes(`case a.activity_type ${ACTIVITY_CODES.map((entry) => `when '${entry.kind}' then ${entry.code}`).join(" ")} end`),
    "each kind under its iReports360 code",
  );
  assert.ok(
    activity.includes(`case a.activity_type ${ACTIVITY_CODES.map((entry) => `when '${entry.kind}' then '${entry.description}'`).join(" ")} end`),
    "and its description",
  );
  assert.ok(activity.includes("case when a.activity_type = 'sales_day' then btrim('Sales day ' || coalesce(a.note, '')) else a.note end"), "a sales day's comment begins \"Sales day\", as iReports360 carried one");
  for (const entry of ACTIVITY_CODES) {
    const comment = entry.kind === "sales_day" ? "Sales day" : null;
    assert.equal(crmVisitTypeMeaningStrict(entry.code), "CP", `${entry.kind} (${entry.code}) is a WORKED day to compliance and the deductions`);
    assert.equal(isFieldWorkVisit(entry.code, comment, entry.description), false, `${entry.kind} is never a call`);
    assert.notEqual(classifyVisit(entry.code, comment, entry.description).bucket, "regular", `${entry.kind} is never a regular visit`);
  }
  assert.equal(classifyVisit(-7, "Sales day", "Sales day").label, "Health Day", "a sales day reads as iReports360 read one");
  const activityColumns = new Set([...activityBranch.matchAll(/\ba\.([a-z_]+)/g)].map((match) => match[1]));
  for (const column of activityColumns) {
    assert.ok(ACTIVITY_COLUMNS_CARRIED.has(column), `the day-activity branch reads a.${column}, which it has no use for`);
  }

  // AM · PM · PHARMACIES — the ampm column is the customer's list, the visit is a regular call, and no
  // Phoenix row is ever a pharmacy row.
  // 🔴 A PHARMACY ON A PHOENIX VISIT IS FEEDBACK ON A DOCTOR'S CALL, NEVER A PHARMACY CALL. The field
  // set carries the name the rep typed, so the admin reports can print it — and it is RENAMED to
  // `visit_pharmacy_name` for exactly one reason: the AM/PM/Pharmacies bucket keys off `ampm`, which is
  // the CUSTOMER'S OWN LIST. A column called `pharmacy_name` beside it is the shape a later sweep
  // "tidies" into the bucket, and that would move a published month's pharmacy figure.
  assert.deepEqual(
    phoenixItems.filter((item) => /pharmac/i.test(item)),
    ["p.pharmacy_name"],
    "the only pharmacy the Phoenix branch reads is the feedback the rep typed",
  );
  assert.equal(
    phoenix.get("visit_pharmacy_name"),
    "p.pharmacy_name",
    "and the door serves it under visit_pharmacy_name — renamed away from the bucket's own vocabulary",
  );
  assert.equal(
    names.filter((name) => /pharmac/i.test(name)).length,
    1,
    "nothing else the door serves is called a pharmacy, so nothing can be tidied into the AM/PM/Pharmacies bucket",
  );
  assert.equal(phoenix.get("ampm"), "p.list_type", "the bucket still reads the CUSTOMER'S OWN LIST and nothing the visit says");

  // Golden rule #1: nothing silent leaves Phoenix CRM.
  const columnsRead = new Set([...visitBranch.matchAll(/\bp\.([a-z_]+)/g)].map((match) => match[1]));
  for (const column of columnsRead) {
    assert.ok(VISIT_COLUMNS_CARRIED.has(column), `the Phoenix branch reads p.${column}, which golden rule #1 keeps inside Phoenix CRM`);
  }
  // 🔴 `p.synced_at` IS CARRIED, AND RENAMED, because the door ALREADY HAS a `synced_at` and it means
  // something else: the vendor's `synced_at` output is `p.created_at`, when the row reached the server.
  // Phoenix's own `synced_at` is when the rep's phone handed an offline row over, which is the number
  // the Capture cell prints. Emitting it under the existing name would have silently restated every
  // reader of the vendor column.
  assert.deepEqual(
    phoenixItems.filter((item) => /synced_at/.test(item)),
    ["p.synced_at"],
    "the offline-sync clock is read exactly once",
  );
  assert.equal(
    phoenix.get("phoenix_synced_at"),
    "p.synced_at",
    "and it is served under its OWN name, never over the door's existing synced_at",
  );
  assert.equal(
    phoenix.get("synced_at"),
    "p.created_at",
    "the door's own synced_at still means when the row reached the server — unchanged for every existing reader",
  );

  // The ids: negative, exact in JavaScript, and what staging computes.
  for (const sample of STAGING_IDS) {
    assert.equal(phoenixId(sample.uuid), sample.row, `the view's id for ${sample.uuid} is the one staging computed`);
    assert.ok(sample.row < 0 && Number.isSafeInteger(sample.row), "negative, so it never meets a vendor id, and exact in a JavaScript number");
  }

  // A Phoenix row buckets by ITS LIST and by nothing else it says: a doctor's call stays AM or PM however
  // much its comment talks about a pharmacy.
  const split = emptyVisitCountSplit();
  for (const row of [
    phoenixRow({ ampm: "AM" }),
    phoenixRow({ ampm: "AM", comment: "Left samples at the pharmacy downstairs — صيدلية" }),
    phoenixRow({ ampm: "PM" }),
    phoenixRow({ ampm: "PM", speciality: "General Practice" }),
    phoenixRow({ ampm: "PM", comment: "pharmacy" }),
  ]) {
    assert.notEqual(visitCountBucket(row), "Pharmacies", "a Phoenix doctor's call is never a pharmacy, whatever its comment says");
    addVisitToSplit(split, row);
  }
  addVisitToSplit(split, vendorRow({ ampm: "AM", speciality: "Pharmacy" }));
  assert.deepEqual(split, { am: 2, pm: 3, pharmacies: 1, phoenix: 5 }, "AM · PM · Pharmacies stay apart — a vendor pharmacy row is still a pharmacy, in neither AM nor PM");

  // THE PHARMACY CALL (owner, 2026-10-03) — a countable Phoenix visit of its own, carried with the
  // customer's own list in `ampm`. A rep adding a pharmacy at the door often leaves the speciality
  // empty — 5 of Delta (1)'s 25 calls of 3 October did — and those 5 were counted among the PM DOCTORS
  // until `visitCountBucket` read the list. Both spellings must bucket the same.
  for (const row of [phoenixRow({ ampm: "Pharmacy" }), phoenixRow({ ampm: "Pharmacy", speciality: "Pharmacy" })]) {
    assert.equal(visitCountBucket(row), "Pharmacies", "a Phoenix pharmacy call is a pharmacy on its list alone, speciality or not");
  }
  const pharmacySplit = addVisitToSplit(emptyVisitCountSplit(), phoenixRow({ ampm: "Pharmacy" }));
  assert.deepEqual(pharmacySplit, { am: 0, pm: 0, pharmacies: 1, phoenix: 1 }, "it lands in Pharmacies, never in PM");
  // And Phoenix records them now, so its figure is a real count — never "not recorded in Phoenix".
  assert.equal(pharmacyRecordingOf(pharmacySplit), "recorded", "Phoenix CRM records pharmacy calls since 2026-10-03");
  assert.equal(pharmacyRecordingOf({ am: 2, pm: 5, pharmacies: 0, phoenix: 7 }), "recorded", "a Phoenix-only split's 0 means nobody called a pharmacy, not that none was recorded");

  // The flags view: unchanged in shape, and a Phoenix row is its own check-in.
  const flagsView = viewSql(FLAGS_VIEW, "crm_visits_checkin_flags");
  const flagsItems = itemsOf(flagsView, "from public.crm_visits_unified v");
  assert.deepEqual(
    flagsItems,
    [
      ...names.slice(0, 30).map((name) => `v.${name}`),
      "ck.has_checkin",
      "(v.visit_type = 0 and not ck.has_checkin) as regular_no_checkin",
      // 20261021140001: the second manager and the Phoenix visit detail, APPENDED after the two flags. Frozen
      // at 32 columns until then, which left CRM Master's Regular · No Check-in tabs asking for 32 it lacked.
      // `phoenix_customer_validated` (names[30]) stays out: nothing reads it from this view. Nor does
      // `companion_hr_ids` (2026-10-27, the door's last column): the flag tabs name no companions.
      ...names.slice(31, -1).map((name) => `v.${name}`),
    ],
    "the flag view keeps its first 32 columns in place and APPENDS the second manager and the Phoenix visit detail",
  );
  assert.match(flat(flagsView), /select case when v\.source = 'phoenix' then true else exists \(/, "a Phoenix row is its own check-in, so it never sits on 'Regular · No Check-in'");
  const vendorCase = (sql: string) => {
    const text = flat(sql);
    return text.slice(text.indexOf("else exists ("), text.indexOf("end as has_checkin"));
  };
  assert.equal(vendorCase(flagsView), vendorCase(viewSql(stripSqlComments(read(PREVIOUS_FLAGS_VIEW)), "crm_visits_checkin_flags")), "an iReports360 visit's check-in test is the previous one, word for word");
}

// ── 4. The plan door ───────────────────────────────────────────────────────────────────────────────

type PlanEvent = { id: number; at: string; type: string; from: string | null; to: string | null; returnedDay?: string | null };

/** public.phoenix_crm_plan_day_status, transcribed — its clauses are pinned below to the save's own. */
function planDayAsOf(events: readonly PlanEvent[], acknowledgedAt: readonly string[], day: string, asOf: string): "submitted" | "approved" | null {
  const newestFirst = (left: PlanEvent, right: PlanEvent) => right.at.localeCompare(left.at) || right.id - left.id;
  const latest = events.filter((event) => event.to !== null && event.at <= asOf).sort(newestFirst)[0];
  if (!latest) return null;
  if (latest.to === "submitted" || latest.to === "approved") return latest.to;
  if (
    latest.to === "returned" &&
    latest.returnedDay &&
    day !== latest.returnedDay &&
    !acknowledgedAt.some((at) => at > latest.at && at <= asOf)
  ) {
    const returned = events.filter((event) => event.type === "returned" && event.at <= asOf).sort(newestFirst)[0];
    return returned?.from === "approved" ? "approved" : "submitted";
  }
  return null;
}

/** The plan view's inclusion: SENT AS OF THAT DAY — the end of that Cairo day, or now for a day to come. */
function servedAsOf(day: string, now: string): string {
  const endOfDay = `${addDays(day, 1)}T00:00`;
  return now < endOfDay ? now : endOfDay;
}

function runPlanDoorTests(plans: string): void {
  // THE RULE IS THE SAVE'S OWN: its subquery word for word, for one plan.
  const fn = flat(functionSql(plans, "phoenix_crm_plan_day_status"));
  const save = flat(stripSqlComments(read(SAVE_VISIT_RULE)));
  const latestInSave = "from public.phoenix_crm_plan_events e where e.plan_id = pl.id and e.to_status is not null and e.created_at <= v_captured_at order by e.created_at desc, e.id desc limit 1";
  const ackInSave = "from public.phoenix_crm_plan_edit_requests r where r.plan_id = pl.id and r.hr_acknowledged_at > e.created_at and r.hr_acknowledged_at <= v_captured_at";
  assert.ok(save.includes(latestInSave) && save.includes(ackInSave), "the save's rule is where it was (20261002125244)");
  assert.ok(fn.includes(latestInSave.replace("e.plan_id = pl.id", "e.plan_id = p_plan_id").replace("v_captured_at", "p_as_of")), "the plan's LATEST event as of the instant, exactly as the save asks it");
  assert.ok(
    fn.includes(ackInSave.replace("r.plan_id = pl.id", "r.plan_id = p_plan_id").replace("e.created_at", "latest.created_at").replace("v_captured_at", "p_as_of")),
    "an acknowledged edit after the return opens the whole week, exactly as the save reads it",
  );
  assert.ok(save.includes("then nullif(e.details ->> 'returned_day', '')::date"));
  assert.ok(fn.includes("p_day <> nullif(latest.details ->> 'returned_day', '')::date"), "the one-day return leaves the OTHER days sent");
  assert.ok(fn.includes("when latest.to_status in ('submitted', 'approved') then latest.to_status"), "a sent or approved week is sent");
  assert.ok(
    fn.includes("select case when rt.from_status = 'approved' then 'approved' end from public.phoenix_crm_plan_events rt where rt.plan_id = p_plan_id and rt.event_type = 'returned' and rt.created_at <= p_as_of order by rt.created_at desc, rt.id desc limit 1"),
    "what the week was is read off the RETURN event — never a later save",
  );
  assert.doesNotMatch(fn, /rt\.to_status|event_type = 'saved'|phoenix_crm_plans\b/, "never a save read as a change of status, never the plan's status column alone");
  assert.match(fn, /returns text language sql stable set search_path to 'public'/);
  assert.match(plans, /revoke execute on function public\.phoenix_crm_plan_day_status\(uuid, date, timestamptz\) from public, anon, authenticated;/);

  // The rule, run: a week sent, approved, one day returned, saved, opened, sent again.
  const week = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
  const events: PlanEvent[] = [
    { id: 1, at: "2026-10-01T08:00", type: "created", from: null, to: "draft" },
    { id: 2, at: "2026-10-01T09:00", type: "saved", from: "draft", to: "draft" },
    { id: 3, at: "2026-10-01T20:00", type: "submitted", from: "draft", to: "submitted" },
    { id: 4, at: "2026-10-02T10:00", type: "approved", from: "submitted", to: "approved" },
    { id: 5, at: "2026-10-04T12:00", type: "returned", from: "approved", to: "returned", returnedDay: "2026-10-06" },
    { id: 6, at: "2026-10-04T13:00", type: "saved", from: "returned", to: "returned", returnedDay: "2026-10-06" },
  ];
  assert.equal(planDayAsOf(events, [], "2026-10-03", "2026-10-01T12:00"), null, "a draft is no plan");
  assert.equal(planDayAsOf(events, [], "2026-10-03", "2026-10-01T21:00"), "submitted", "a sent week is a plan");
  assert.equal(planDayAsOf(events, [], "2026-10-03", "2026-10-03T23:00"), "approved");
  assert.equal(planDayAsOf(events, [], "2026-10-05", "2026-10-04T12:30"), "approved", "\"Still planned\": a one-day return leaves the other days as the week stood");
  assert.equal(planDayAsOf(events, [], "2026-10-06", "2026-10-04T12:30"), null, "the returned day itself is back with the rep");
  assert.equal(planDayAsOf(events, [], "2026-10-05", "2026-10-05T23:00"), "approved", "a SAVE of the returned day changes nothing: it is not a change of status");
  assert.equal(planDayAsOf(events, ["2026-10-04T15:00"], "2026-10-05", "2026-10-05T23:00"), null, "an edit acknowledged after the return opens the whole week");
  assert.equal(planDayAsOf(events, ["2026-10-04T11:00"], "2026-10-05", "2026-10-05T23:00"), "approved", "an acknowledgement BEFORE the return opens nothing of it");
  const oldSave: PlanEvent[] = [...events.slice(0, 5), { id: 6, at: "2026-10-04T13:00", type: "saved", from: "returned", to: "returned" }];
  assert.equal(planDayAsOf(oldSave, [], "2026-10-05", "2026-10-05T23:00"), null, "a save that names no day reads exactly as the visit save reads it");
  const resent: PlanEvent[] = [...events, { id: 7, at: "2026-10-05T09:00", type: "submitted", from: "returned", to: "submitted" }];
  assert.equal(planDayAsOf(resent, [], "2026-10-06", "2026-10-06T23:00"), "submitted", "sent again, the week is a plan on every day");
  const wholeWeek: PlanEvent[] = [...events.slice(0, 4), { id: 5, at: "2026-10-04T12:00", type: "returned", from: "approved", to: "returned" }];
  assert.equal(planDayAsOf(wholeWeek, [], "2026-10-05", "2026-10-05T23:00"), null, "a week returned whole is no plan on any day");

  // The SQL rule is the module's own: for every day and every state, the same answer as plan-rules.ts.
  const now = "2026-10-04T12:30";
  for (const day of week) {
    const sql = planDayAsOf(events, [], day, now);
    const inTypeScript = planDayStatus({ status: "returned", returnedDay: "2026-10-06", returnedFrom: "approved", date: day });
    assert.equal(sql !== null, isPlanSentForReview(inTypeScript), `${day}: sent in the view exactly when the module says it is sent`);
    if (sql !== null) assert.equal(sql, inTypeScript, `${day}: and as approved or as submitted alike`);
  }

  // The view: an as-of-that-day inclusion, today's verification, the rep who sat there that day.
  const view = viewSql(PLANS_DOOR, "crm_plan_entries_unified");
  const [vendorBranch, phoenixBranch] = view.split("\nunion all\n");
  const vendorItems = itemsOf(vendorBranch, "from public.ireports360_plan_entries pe");
  assert.deepEqual(
    vendorItems,
    withPhoenixOverrides(previousItems("crm_plan_entries_unified", "from public.ireports360_plan_entries pe"), {
      contact_name: "coalesce(truth.name, pe.contact_name) as contact_name",
      speciality: "coalesce(truth.speciality, pe.speciality) as speciality",
    }),
    "the 23 columns keep their names, types and order — the doctor's name and speciality are Phoenix's where he is validated (20261022163000)",
  );
  const vendor = flat(vendorBranch);
  assert.ok(vendor.includes("where (pe.plan_date is null or pe.plan_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)) and not exists"), "its one condition bracketed, then the two clauses");
  assert.ok(vendor.includes("where r.hr_key = lower(btrim(pe.agent_hr_id)) and pe.plan_date >= r.counted_from and (r.counted_until is null or pe.plan_date < r.counted_until)"), "the started team's people leave the vendor plan copy for the same days");
  assert.ok(vendor.includes("where nullif(btrim(pe.agent_hr_id), '') is null and r.agent_crm_id = pe.agent_crm_id and pe.plan_date >= r.counted_from"), "by CRM id on a row with no hr id");

  // The select list ends where the grouped plan-day subquery begins (20261028013400).
  const phoenixItems = itemsOf(phoenixBranch, "from (\n  select\n    x.plan_id,");
  const names = vendorItems.map(outputName);
  assert.equal(phoenixItems.length, names.length);
  const item = new Map(names.map((name, index): [string, string] => [name, phoenixItems[index]]));
  const phoenix = flat(phoenixBranch);
  // 🔴 A READ NARROWS ONLY ON THE SUBQUERY'S OWN GROUP KEYS — THE DAY AND THE REP. A predicate on a
  // grouping column is pushed INTO the grouped subquery; one on a table joined after it is not, and
  // Postgres propagates only an EQUALITY across a join, never a range or an "= any (…)".
  // The day: written on i.plan_date (20261024002000) the door answered ONE DAY in 22 ms and a WEEK in
  // 1,428 ms mean on production — max 17,787 ms, 24 Oct 2026 — because the range grouped all 14,037
  // plan items and ran the status function for every one of the ~1,128 plan-days in the company to
  // answer one rep's week. On pd.plan_date (20261024004000) that week is 38 ms.
  // The rep: joined AFTER the group (20261024004000), ten hr ids over October touched 17,954 pages a
  // call and fifty CRM ids 35,120, grouping every plan-day in the company for the month. Inside the
  // group (20261028013400) they touch 5,371 and 8,119 on production, 28 Oct 2026 — the same 10,065
  // Phoenix rows, 0 differing under "except all", the same md5.
  for (const onTheItems of [
    "i.plan_date",
    "extract(month from i.plan_date)",
    "extract(year from i.plan_date)",
  ]) {
    assert.ok(
      !phoenix.includes(onTheItems),
      `RED the Phoenix branch takes its day from the group key, never from the items: "${onTheItems}" stops a plan_date RANGE being pushed into the plan-day subquery, and a rep's week then scans every plan-day in the company (1,428 ms mean, max 17.8 s, production, 24 Oct 2026)`,
    );
  }
  assert.ok(
    phoenix.includes("join reps r on r.seat_id = p.seat_id and x.plan_date >= r.counted_from and (r.counted_until is null or x.plan_date < r.counted_until) group by x.plan_id, x.plan_date, r.rep_row, r.agent_crm_id, r.hr_id, p.updated_at having"),
    "RED the rep is joined INSIDE the plan-day group and his hr id and CRM id are group keys — joined after it, ten hr ids over a month grouped every plan-day in the company (17,954 pages a call, production, 28 Oct 2026)",
  );
  assert.equal(phoenix.split("join reps r").length - 1, 1, "RED and the reps are joined once, inside the group — never again after it");
  // rep_row keeps two equal rows of the roster apart, so two reps on one seat and day stay two rows.
  assert.ok(
    flat(view).includes("with reps as materialized ( select t.*, row_number() over () as rep_row from public.phoenix_crm_started_team_reps() t ) select"),
    "the started team's people are read once for the whole view, each row numbered",
  );
  // The items ride through the group as arrays, so the items table is read once; the customers are
  // hashed once behind OFFSET 0 instead of an index probe per plan item.
  assert.equal(phoenix.split("public.phoenix_crm_plan_items").length - 1, 1, "the items table is read once");
  assert.ok(
    phoenix.includes(") pd cross join lateral unnest(pd.item_ids, pd.customer_ids, pd.list_types, pd.created_ats, pd.updated_ats) as i(id, customer_id, list_type, created_at, updated_at) join ( select c.id, c.reference_contact_crm_id, c.own_contact_crm_id, c.name, c.grade, c.speciality from public.phoenix_crm_customers c offset 0 ) customer on customer.id = i.customer_id;"),
    "the day's items are unnested after the group, and each is given its customer from one hashed read",
  );
  const expected: Record<string, string> = {
    crm_plan_entry_id: "-1 - ('x' || substr(md5(i.id::text), 1, 13))::bit(52)::bigint",
    plan_kind: "'weekly'::text",
    crm_plan_id: "-1 - ('x' || substr(md5(pd.plan_id::text), 1, 8))::bit(30)::integer",
    // 🔴 pd.plan_date, NOT i.plan_date — the grouped subquery's OWN key, so a plan_date RANGE is pushed
    // into it. The narrowing pin above says what reverting this one word costs (24 Oct 2026).
    plan_date: "pd.plan_date",
    plan_month: "extract(month from pd.plan_date)::smallint",
    plan_year: "extract(year from pd.plan_date)::smallint",
    plan_frequency: "null::smallint",
    // 🔴 pd.*, NOT r.* — the rep is a group key, so a filter on him reaches the group (28 Oct 2026).
    agent_crm_id: "pd.agent_crm_id",
    agent_hr_id: "pd.hr_id",
    // The SAME expression as the visit door, to the character — see the cross-door pin below.
    contact_crm_id: "coalesce(customer.reference_contact_crm_id, customer.own_contact_crm_id)",
    contact_name: "customer.name",
    contact_grade: "customer.grade",
    crm_region_name: "null::text",
    speciality: "customer.speciality",
    ampm: "i.list_type",
    start_am: "null::text",
    start_pm: "null::text",
    // Read from the once-per-plan-day subquery below, not called per item (23 Oct 2026).
    plan_status: "(case when pd.status_now = 'approved' then 1 else 0 end)::smallint",
    raw_payload: "null::jsonb",
    synced_at: "greatest(pd.plan_updated_at, i.updated_at)",
    created_at: "i.created_at",
    updated_at: "i.updated_at",
    source: "'phoenix'::text",
  };
  for (const [column, expression] of Object.entries(expected)) {
    assert.equal(item.get(column), expression, `a Phoenix plan day's ${column} is ${expression}`);
  }
  assert.equal(flat(view).split("phoenix_crm_started_team_reps()").length - 1, 1, "and the function is named exactly once in it");
  // The plan day's status is asked of the plan's event log once per (plan, day, rep), not once per item:
  // a day carries about a dozen items. It takes the day through min() so the planner keeps it on the
  // group. Real plans only, carried for the rep who sat on that territory that day, within the start —
  // and a day only when its week was sent as of that day (the HAVING).
  assert.ok(
    phoenix.includes("from ( select x.plan_id, x.plan_date, r.agent_crm_id, r.hr_id, p.updated_at as plan_updated_at, public.phoenix_crm_plan_day_status(x.plan_id, min(x.plan_date), now()) as status_now, array_agg(x.id) as item_ids, array_agg(x.customer_id) as customer_ids, array_agg(x.list_type) as list_types, array_agg(x.created_at) as created_ats, array_agg(x.updated_at) as updated_ats from public.phoenix_crm_plan_items x join public.phoenix_crm_plans p on p.id = x.plan_id and not p.is_test join reps r on"),
    "the status is read once per plan-day as of now, for real plans only",
  );
  assert.ok(
    phoenix.includes("having public.phoenix_crm_plan_day_status( x.plan_id, min(x.plan_date), least(now(), (min(x.plan_date) + 1)::timestamp at time zone 'Africa/Cairo') ) is not null ) pd"),
    "and a day is served only when its week was sent as of the end of that day",
  );
  assert.equal(phoenix.split("phoenix_crm_plan_day_status(").length - 1, 2, "and the function is named exactly twice in the branch, both inside that subquery");
  assert.equal(servedAsOf("2026-10-05", "2026-10-09T10:00"), "2026-10-06T00:00", "a past day is judged at the end of its own day");
  assert.equal(servedAsOf("2026-10-08", "2026-10-04T12:30"), "2026-10-04T12:30", "a day to come is judged now");
  assert.equal(planDayAsOf(events, [], "2026-10-05", servedAsOf("2026-10-05", "2026-10-09T10:00")), "approved", "Monday was planned as of Monday");
  assert.equal(planDayAsOf(events, [], "2026-10-03", servedAsOf("2026-10-03", "2026-10-09T10:00")), "approved");
  for (const sample of STAGING_IDS) {
    assert.equal(phoenixPlanId(sample.uuid), sample.plan, `the plan id for ${sample.uuid} is the one staging computed`);
    assert.ok(sample.plan < 0 && sample.plan >= -(2 ** 30), "negative, and inside an integer");
  }
  const verify = stripComments(read("app/api/crm/plan-verification/verify/route.ts"));
  const negative = verify.indexOf("if (Number.isInteger(crmPlanId) && crmPlanId < 0) {");
  assert.ok(
    negative > 0 && negative < verify.indexOf("{ status: 409 }"),
    "the plan verification route answers a negative (Phoenix) plan id with 409 and no vendor write",
  );

  // The vendor's own reference plans stay vendor-only.
  assert.match(stripComments(read("src/lib/crm/shared-customers.ts")), /\.eq\("source", IREPORTS360_VISIT_SOURCE\)/, "the Phoenix CRM List's reference patterns read iReports360 plans only");
  assert.match(stripComments(read("src/lib/crm/plan-board.ts")), /\.eq\("source", IREPORTS360_VISIT_SOURCE\)/, "and so does \"Copy last month\"");

  // Hygiene: the file names itself, writes nothing, and keeps every browser role out.
  const raw = read(PLANS);
  assert.match(raw, /^-- phoenix_crm_plans_everywhere\n/);
  assert.match(plans, /^\s*begin;\s*set local lock_timeout = '5s';/m);
  assert.ok(plans.trimEnd().endsWith("commit;"));
  assert.doesNotMatch(plans, /\b(insert into|update\s+public\.|delete from)\b/, "the plan migration writes no row at all");
  assert.match(plans, /revoke all on table public\.crm_plan_entries_unified from anon, authenticated;/);
  assert.match(plans, /revoke all on table public\.crm_checkins_unified from anon, authenticated;/);
  assert.match(viewSql(PLANS_DOOR, "crm_plan_entries_unified"), /with \(security_invoker = true\)/);
  assert.match(viewSql(CHECKINS_DOOR, "crm_checkins_unified"), /with \(security_invoker = true\)/);
}

// ── 5. The check-in door ───────────────────────────────────────────────────────────────────────────

/** The integrity columns of a Phoenix visit — golden rule #1's, read only on the integrity board. */
const INTEGRITY_COLUMNS = [
  "accuracy_meters",
  "distance_meters",
  "location_flag",
  "device_skew_minutes",
  "photo_lat",
  "photo_lon",
  "photo_accuracy_meters",
  "photo_captured_at",
  "photo_path",
  "dwell_seconds",
  "form_open_seconds",
  "capture_source",
  "time_anchor_id",
  "offline_seconds",
  "synced_at",
  "voice_note_path",
];
const CHECKIN_COLUMNS_CARRIED = new Set(["captured_at", "created_at", "customer_id", "id", "is_test", "lat", "lon", "manager_hr_id", "rep_hr_id", "seat_id", "visit_date"]);

/** Readers that may ask for Phoenix check-ins: each is a screen no rep can reach (phoenix-team-starts.ts). */
const PHOENIX_CHECKIN_READERS = [
  "src/lib/crm-integrity/service.ts",
  "src/lib/crm/brick-coverage.ts",
  "src/lib/crm/master.ts",
  "src/lib/crm/rep-day.ts",
  "src/lib/crm/sfe-field-analytics.ts",
  "src/lib/employee-portal/nsm-crm-compliance.ts",
  "src/lib/field-activity/report.ts",
  "src/lib/probation/intelligence/sfe-evidence.ts",
];

/** Readers a rep CAN reach: they read iReports360 check-ins only. */
const REP_REACHABLE_CHECKIN_READERS = [
  "src/lib/early-birds/collect.ts",
  "src/lib/employee-360/service.ts",
  "src/lib/employee-portal/my-crm-visits.ts",
  "src/lib/crm/visit-workload.ts",
  "src/lib/crm/phoenix-kpi-data.ts",
  "src/lib/pharmacy-search/nearby.ts",
  "src/lib/crm/call-rate-service.ts",
  "src/lib/crm/rep-visits-data.ts",
];

function runCheckinDoorTests(plans: string): void {
  const view = viewSql(CHECKINS_DOOR, "crm_checkins_unified");
  const [vendorBranch, phoenixBranch] = view.split("\nunion all\n");
  assert.ok(vendorBranch && phoenixBranch, "two branches: iReports360 check-ins, and positioned Phoenix visits");

  const vendorItems = itemsOf(vendorBranch, "from (\n");
  assert.deepEqual(
    vendorItems,
    withPhoenixOverrides(previousItems("crm_checkins_unified", "from public.ireports360_checkins c"), {
      contact_name: "coalesce(truth.name, c.contact_name) as contact_name",
    }),
    "the 16 columns keep their names, types and order — the doctor's name is Phoenix's where he is validated (20261022163000)",
  );
  assert.equal(view.split("\nunion all\n").length, 2, "and only those two: the vendor table is no longer two runs of its own");
  const vendor = flat(vendorBranch);
  // ONE SCAN, AND THE ENTRY DAY IS AN INDEX LOOKUP (speed, 2026-10-28) — the visit door's shape since
  // 20261024005000, on the check-in's wall-clock day. Until 20261028024500 the vendor check-ins were two
  // union-all runs split at Phoenix CRM's first day, so the rep list's 50-doctor read walked the
  // (contact_crm_id, check_date) index twice, and both checks asked a MATERIALIZED CTE over
  // phoenix_crm_rep_entry_days(), which a function scan left the planner no way to index. Measured on
  // production: 795 -> 618 pages for the same 481 rows, byte-identical; the whole door, 145,388 rows, 0
  // and 0 differences.
  assert.equal(
    view.split("phoenix_crm_rep_entry_days()").length - 1,
    0,
    "the door does not call phoenix_crm_rep_entry_days() at all any more — a function scan carries no index",
  );
  assert.doesNotMatch(vendor, /entry_days as materialized/, "and there is no materialized CTE left to walk per row");
  // THE RULE DID NOT MOVE, THE READ DID: phoenix_crm_rep_entry_days_calc() is still the one body that
  // computes an entry day, and the door reads the table that body writes. The cache is granted to
  // postgres and service_role alone — the door's own two grantees, both BYPASSRLS — so the reach is
  // unchanged.
  assert.equal(
    view.split("public.phoenix_crm_rep_entry_days_cache").length - 1,
    2,
    "it reads the cache table directly, once per check and no more",
  );
  // A check-in before the first day's midnight "UTC" (the vendor's Cairo wall clock) is on a day before
  // it, where no rep has an entry day: that bound is now the first ARM of one scan, not a second run.
  const cutover = "x.check_date < coalesce( (select k.cutover_date::timestamp at time zone 'UTC' from public.crm_cutover k where k.id), 'infinity'::timestamptz )";
  const firstDay =
    "( select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)::timestamp at time zone 'UTC' from public.phoenix_crm_team_starts t )";
  assert.equal(
    vendor.split("from public.ireports360_checkins x").length - 1,
    1,
    "the vendor table is scanned ONCE, not once per side of the split",
  );
  assert.ok(
    vendor.includes(`from ( select x.* from public.ireports360_checkins x where ${cutover} and ( x.check_date < ${firstDay} or ( not exists`),
    "one scan, its cutover clause as it was, and the first-day bound as the first arm of the choice",
  );
  assert.ok(
    vendor.includes(
      "not exists ( select 1 from public.phoenix_crm_rep_entry_days_cache e where e.hr_key = lower(btrim(x.agent_hr_id)) and e.entry_day = (x.check_date at time zone 'UTC')::date )",
    ),
    "PHOENIX WINS THE DAY on a check-in too: it is ignored only on a day its rep has a Phoenix entry, as his visits are",
  );
  assert.ok(
    vendor.includes(
      "and not exists ( select 1 from public.phoenix_crm_rep_entry_days_cache e where nullif(btrim(x.agent_hr_id), '') is null " +
        "and e.agent_crm_id = x.agent_crm_id and e.entry_day = (x.check_date at time zone 'UTC')::date ) ) ) ) c",
    ),
    "by CRM id on a check-in with no hr id, and the choice closes before the scan does",
  );
  assert.doesNotMatch(vendor, /phoenix_crm_started_team_reps|counted_from|counted_until/, "no longer from the start's window");

  const names = vendorItems.map(outputName);
  const items = itemsOf(phoenixBranch, "from public.phoenix_crm_countable_visits p");
  assert.equal(items.length, names.length);
  const item = new Map(names.map((name, index): [string, string] => [name, items[index]]));
  const expected: Record<string, string> = {
    id: "p.id",
    crm_checkin_id: "-1 - ('x' || substr(md5(p.id::text), 1, 13))::bit(52)::bigint",
    agent_hr_id: "coalesce(p.rep_hr_id, p.manager_hr_id)",
    // The SAME expression as the visit door, to the character — see the cross-door pin below.
    contact_crm_id: "coalesce(customer.reference_contact_crm_id, customer.own_contact_crm_id)",
    contact_name: "customer.name",
    lat: "p.lat",
    lon: "p.lon",
    address: "null::text",
    check_date: "(p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC'",
    raw_payload: "null::jsonb",
    synced_at: "p.created_at",
    created_at: "p.created_at",
    updated_at: "p.created_at",
    source: "'phoenix'::text",
  };
  for (const [column, expression] of Object.entries(expected)) {
    assert.equal(item.get(column), expression, `a Phoenix check-in's ${column} is ${expression}`);
  }
  const phoenix = flat(phoenixBranch);
  assert.ok(phoenix.includes("join public.phoenix_crm_started_team_seats() team on team.seat_id = p.seat_id and p.visit_date >= team.starts_on and (team.stops_on is null or p.visit_date < team.stops_on)"), "only a started team's visits, within its start");
  assert.ok(phoenix.endsWith("where not p.is_test and p.lat is not null and p.lon is not null;"), "real only, and only a visit whose position was read");
  const columnsRead = new Set([...phoenixBranch.matchAll(/\bp\.([a-z_]+)/g)].map((match) => match[1]));
  for (const column of columnsRead) {
    assert.ok(CHECKIN_COLUMNS_CARRIED.has(column), `the Phoenix check-in reads p.${column}`);
  }
  for (const column of INTEGRITY_COLUMNS) {
    assert.ok(!columnsRead.has(column), `no integrity field leaves Phoenix CRM as a check-in: never p.${column}`);
  }

  // The door: iReports360 only unless a reader asks.
  const reads = stripComments(read("src/lib/crm/reads.ts"));
  const door = reads.slice(reads.indexOf("export async function queryCheckins"), reads.indexOf("// ── Visits Report view"));
  assert.match(door, /if \(!options\.includePhoenixVisits\) query = query\.eq\("source", IREPORTS360_VISIT_SOURCE\);/, "a bounded read is iReports360 only by default");
  assert.match(door, /const query = options\.includePhoenixVisits \? base : base\.eq\("source", IREPORTS360_VISIT_SOURCE\);/, "and so is every page of a scan");

  // Who asks: a screen no rep can reach, and nobody else.
  const asking = sourceFiles("src")
    .concat(sourceFiles("app"))
    .filter((file) => stripComments(read(file)).includes("includePhoenixVisits: true"))
    .sort();
  assert.deepEqual(asking, [...PHOENIX_CHECKIN_READERS].sort(), "only the readers no rep can reach ask for Phoenix check-ins — a new one is added here with its audience");
  for (const file of REP_REACHABLE_CHECKIN_READERS) {
    assert.doesNotMatch(stripComments(read(file)), /includePhoenixVisits/, `${file} reaches a rep, so it reads iReports360 check-ins only`);
  }
  // A reader of the view outside the door reads vendor rows only, except the Super Admin's CRM Master.
  const direct = sourceFiles("src")
    .concat(sourceFiles("app"))
    .filter((file) => file !== "src/lib/crm/tables.ts" && /\bCRM_CHECKINS_UNIFIED_VIEW\b|"crm_checkins_unified"/.test(stripComments(read(file))))
    .sort();
  assert.deepEqual(direct, ["src/lib/crm/master.ts", "src/lib/crm/reads.ts", "src/lib/crm/reps-list.ts"], "who reads the check-in view directly: the door, the Super Admin's CRM Master, and the List's pins");
  const repsList = stripComments(read("src/lib/crm/reps-list.ts"));
  const chains = repsList.split(".from(CRM_CHECKINS_UNIFIED_VIEW)").slice(1);
  assert.equal(chains.length, 2);
  for (const chain of chains) {
    // Measured in the chain's own text, comments blanked and whitespace folded: the filter is its next link.
    assert.match(flat(chain).slice(0, 200), /^\s*\.select\("[^"]+"\) \.eq\("source", IREPORTS360_VISIT_SOURCE\)/, "the Phoenix CRM List's pins never read a Phoenix visit's position");
  }

  // The CRM Master: a Phoenix visit is its own check-in, as crm_visits_checkin_flags says.
  const rows: CrmMasterRow[] = [
    { id: "a", raw_payload: null, visit_type: 0, crm_visit_id: -42, checkin_id: null },
    { id: "b", raw_payload: null, visit_type: 0, crm_visit_id: 42, checkin_id: null },
    { id: "c", raw_payload: null, visit_type: 0, crm_visit_id: 43, checkin_id: 7 },
  ];
  attachEffectiveType("visits", rows, true);
  assert.notEqual(rows[0].effective_type, REGULAR_NO_GPS_CHECKIN_LABEL, "a Phoenix visit is never \"no GPS check-in\" on the CRM Master");
  assert.equal(rows[1].effective_type, REGULAR_NO_GPS_CHECKIN_LABEL, "an iReports360 visit with no check-in still is");
  assert.notEqual(rows[2].effective_type, REGULAR_NO_GPS_CHECKIN_LABEL);
}

// ── 6. Early Birds and the SFE start times ──────────────────────────────────────────────────────────

function runStartClockTests(): void {
  const windows: StartedRepWindow[] = [
    { hrIdKey: "b7", agentCrmId: 4401, from: "2026-10-03", until: "2026-10-24" },
    { hrIdKey: null, agentCrmId: 6006, from: "2026-10-10", until: null },
  ];
  assert.equal(startedWindowCovers(windows, { hrId: "B-7", crmId: 4401 }, "2026-10-02"), false, "the day before the start is the vendor's");
  assert.equal(startedWindowCovers(windows, { hrId: "b-7", crmId: null }, "2026-10-03"), true, "from the start, matched on the hr id in any casing");
  assert.equal(startedWindowCovers(windows, { hrId: "B-7", crmId: 4401 }, "2026-10-24"), false, "and the vendor's again from the stop");
  assert.equal(startedWindowCovers(windows, { hrId: null, crmId: 6006 }, "2026-10-12"), true, "a row with no hr id is matched on its CRM id");
  assert.equal(startedWindowCovers(windows, { hrId: "Z-9", crmId: 6006 }, "2026-10-12"), false, "but a row WITH an hr id never on the CRM id alone");

  // A STARTED TEAM'S DAY IS NEVER FETCHED LIVE FROM THE VENDOR. `rep-day.ts` prefers a live iReports360
  // call for any day within 2 days of today, and gated that on the GLOBAL `crm_cutover` alone — which a
  // per-team start never sets. A live call that SUCCEEDS with zero rows is served as the truth (the
  // fallback below it only catches a THROW), and on production 2026-10-04 thirteen of Delta (1)'s
  // seventeen people had Phoenix visits since their 3 October start and no vendor visits at all — so
  // B-158's 22 Phoenix calls rendered as "no visits" on HR's field-workforce-compliance drill-down and
  // the National Sales Manager's team calendar. Asserted on the stripped source: the comment above the
  // gate names every one of these symbols, so a test reading the raw file would pass with the gate gone.
  const repDay = stripComments(read("src/lib/crm/rep-day.ts"));
  assert.match(repDay, /loadStartedRepWindows\(\)/, "rep-day reads the started windows");
  assert.match(
    repDay,
    /const countedFromPhoenix = startedWindowCovers\(startedWindows, \{ hrId: rep\.hrId, crmId: self\.crmId \}, day\)/,
    "it asks the shared rule for THIS rep on THIS day, matched on the hr id with the CRM id as the fallback",
  );
  assert.match(repDay, /!countedFromPhoenix &&/, "and a started rep-day can never reach the live vendor call");
  // Bounded by the gate's own semicolon, NOT by the `if (wantLive)` below it: a clause sitting between
  // the two would otherwise read as "inside the gate" when it decides nothing. Measured — a decoy
  // `const decoy = !countedFromPhoenix && true;` placed there passed a slice cut at the `if`.
  const gateStart = repDay.indexOf("const wantLive =");
  assert.ok(gateStart >= 0, "the live gate is still one `const wantLive =` expression");
  const liveGate = repDay.slice(gateStart, repDay.indexOf(";", gateStart));
  assert.ok(liveGate.length > 0 && liveGate.length < 600, "and it is the expression alone, not the block after it");
  assert.match(liveGate, /!countedFromPhoenix/, "the clause is INSIDE the gate, not merely somewhere in the file");
  assert.match(liveGate, /!isOnOrAfterCrmCutover\(cutover, day\)/, "and it stands BESIDE the global cutover, which it did not replace — neither one implies the other");

  // THE ONE HELPER: the first countable Phoenix visit of a rep-day, Cairo wall clock, never before 05:00.
  type StartRow = { agent_hr_id: string | null; crm_save_date: string | null; crm_visit_id?: number | null; source?: string | null; visit_date: string | null; visit_type: number | null };
  const row = (overrides: Partial<StartRow>): StartRow => ({
    agent_hr_id: "B-7",
    crm_save_date: "2026-10-04T08:40:00+00:00",
    crm_visit_id: -42,
    source: PHOENIX_VISIT_SOURCE,
    visit_date: "2026-10-04",
    visit_type: 0,
    ...overrides,
  });
  const starts = phoenixFirstVisitStarts([
    row({}),
    row({ crm_save_date: "2026-10-04T07:55:00+00:00" }),
    row({ crm_save_date: "2026-10-04T06:10:00+00:00", source: IREPORTS360_VISIT_SOURCE, crm_visit_id: 9 }),
    row({ crm_save_date: "2026-10-04T06:30:00+00:00", visit_type: -11 }),
    row({ visit_date: "2026-10-04", crm_save_date: "2026-10-05T01:30:00+00:00" }),
    row({ visit_date: "2026-10-05", crm_save_date: "2026-10-05T01:30:00+00:00" }),
    row({ visit_date: "2026-10-06", crm_save_date: "2026-10-06T09:05:00+00:00", source: null, crm_visit_id: -77 }),
  ]);
  assert.deepEqual(
    [...starts],
    [
      ["b7|2026-10-04", 475],
      ["b7|2026-10-06", 545],
    ],
    "the earliest Phoenix visit is the day's start — never a vendor row, a day activity, or an after-midnight capture",
  );
  const sfeKey = (visit: StartRow) => (visit.agent_hr_id ? `hr:${visit.agent_hr_id.toLowerCase()}` : null);
  assert.deepEqual([...phoenixFirstVisitStarts([row({})], sfeKey)], [["hr:b-7|2026-10-04", 520]], "the SFE table keys its people its own way through the same helper");
  const table = buildStartTimeRows(
    ["2026-10-04", "2026-10-05", "2026-10-06"].map((day, index) => ({ agentHrId: "B-7", agentKey: "hr:b-7", agentName: "Phoenix Rep", checkDate: `${day}T0${7 + index}:30:00` })),
  );
  assert.deepEqual(table.map((entry) => [entry.agentName, entry.medianStartMinutes, entry.daysObserved]), [["Phoenix Rep", 510, 3]], "a Phoenix start sits in the SFE table like a first check-in");

  const sfe = stripComments(read("src/lib/crm/sfe-field-analytics.ts"));
  assert.match(sfe, /const phoenixStarts = \[\.\.\.phoenixFirstVisitStarts\(visits, agentKeyOf\)\]/, "the SFE start times read the first Phoenix visit — the same helper as Early Birds");
  assert.match(sfe, /\.filter\(\(row\) => row\.source !== PHOENIX_VISIT_SOURCE\)/, "never the Phoenix check-in rows, which are those visits again");
  assert.match(sfe, /const CHECKIN_COLUMNS = "agent_crm_id,agent_hr_id,check_date,source";/);
  const collect = stripComments(read("src/lib/early-birds/collect.ts"));
  assert.match(collect, /import \{ crmMinutesPastMidnight, phoenixFirstVisitStarts \} from "@\/lib\/crm\/sfe-field-analytics";/, "Early Birds reads the one helper");
  assert.match(collect, /visit_type_description, contact_name, customer_name, comment, visit_date, crm_visit_id, source"/, "Early Birds reads what marks a Phoenix row");
  // PHOENIX WINS THE DAY: the clock is Phoenix's on a rep-day with a Phoenix visit and iReports360's on one
  // without, so Early Birds no longer asks the started windows at all — the read door has already left out
  // the iReports360 check-ins of every day a rep has a Phoenix entry.
  assert.doesNotMatch(collect, /loadStartedRepWindows|startedWindowCovers|liveCheckins/, "no start window decides a rep-day's clock any more");
  assert.match(collect, /const phoenixClockRepDays = new Set<string>\(phoenixStarts\.keys\(\)\);/, "a rep-day is on Phoenix's clock exactly when it has a countable Phoenix visit");
  assert.match(collect, /const checkinIndex = indexCheckinsByAgentContactDay\(checkins\);/, "a visit is matched to the check-ins the door serves for Phoenix-empty days");
  assert.match(collect, /for \(const \[key, minutes\] of phoenixStarts\) \{\s*gpsStartByRepDay\.set\(key, minutes\);\s*\}/, "on such a day his first Phoenix visit IS the day's start");
  assert.match(collect, /gpsEligible: !phoenixVisit && typeof row\.contact_crm_id === "number" && row\.contact_crm_id !== 0,/, "a Phoenix visit is never in the GPS share");
  for (const file of ["src/lib/early-birds/service.ts", "src/lib/early-birds/close.ts"]) {
    assert.match(read(file), /phoenixClockRepDays: inputs\.phoenixClockRepDays,/, `${file} scores on the same clock`);
  }

  // The scorer: a Phoenix day's start counts as a first visit, never as GPS; its Regular visits earn credit.
  const period = earlyBirdsPeriodFromKey("2026-10-H1");
  const reps: EarlyBirdsRepContext[] = [
    { hrIdKey: "p", hrId: "P-1", name: "Phoenix Rep", expectedWorkingDayWeight: 9, expectedWorkingDays: 9, activeAtPeriodEnd: true },
    { hrIdKey: "g", hrId: "G-1", name: "Vendor Rep", expectedWorkingDayWeight: 9, expectedWorkingDays: 9, activeAtPeriodEnd: true },
  ];
  const days = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-10", "2026-10-11"];
  const facts: EarlyBirdsVisitFact[] = days.flatMap((dateIso) => [
    { hrIdKey: "p", dateIso, startMinutes: 480, timeSource: "save_time" as const, visitType: 0, gpsEligible: false, phoenixVisit: true },
    { hrIdKey: "g", dateIso, startMinutes: 480, timeSource: "gps_checkin" as const, visitType: 0, gpsEligible: true },
  ]);
  const starts2 = new Map(days.flatMap((dateIso): Array<[string, number]> => [[`p|${dateIso}`, 480], [`g|${dateIso}`, 480]]));
  const phoenixDays = new Set(days.map((dateIso) => `p|${dateIso}`));
  const ranking = buildEarlyBirdsRanking({ period, reps, facts, dailyWinnerHrIdKeys: new Map(), gpsStartByRepDay: starts2, phoenixClockRepDays: phoenixDays, throughIso: "2026-10-11" });
  const phoenixRep = ranking.scores.find((score) => score.hrIdKey === "p")!;
  const vendorRep = ranking.scores.find((score) => score.hrIdKey === "g")!;
  assert.equal(phoenixRep.visitStartDays, 7, "every day of his starts at a first Phoenix visit");
  assert.equal(phoenixRep.gpsVerifiedDays, 0, "and none of them is called a GPS day");
  assert.equal(phoenixRep.phoenixClock, true);
  assert.ok(phoenixRep.timeline.every((day) => day.timeSource !== "gps_checkin"), "no day of his is labelled GPS");
  assert.equal(phoenixRep.regularVisitsWithCheckin, 7, "a Phoenix visit is its own check-in: its Regular credit is earned");
  assert.equal(phoenixRep.regularVisitsNoCheckin, 0, "and none reads \"no check-in\"");
  assert.equal(phoenixRep.gpsShare, null, "no Phoenix visit sits in the GPS share");
  assert.equal(phoenixRep.qualityWeight, 1, "so a started district is never marked down for evidence it cannot carry");
  assert.equal(phoenixRep.totalScore, vendorRep.totalScore, "and stands level with a fully checked-in vendor rep on the same work");
  assert.equal(vendorRep.visitStartDays, undefined, "a vendor rep's score carries none of the new fields");
  assert.equal(vendorRep.phoenixClock, undefined);
  const without = buildEarlyBirdsRanking({ period, reps: [reps[1]], facts: facts.filter((fact) => fact.hrIdKey === "g"), dailyWinnerHrIdKeys: new Map(), gpsStartByRepDay: starts2, throughIso: "2026-10-11" });
  assert.deepEqual(without.scores[0], vendorRep, "and scores exactly as it did before Phoenix rows existed");

  // "#1 days": the daily board ranks a started district on its Phoenix capture times.
  const board = buildEarlyBirdsDailyWinners({
    period,
    reps: [
      { hrId: "P-1", name: "Phoenix Rep" },
      { hrId: "P-2", name: "Second Rep" },
    ],
    visitsByDate: new Map<string, NsmCrmVisitRow[]>([
      [
        "2026-10-04",
        [
          { agent_hr_id: "P-2", agent_crm_id: 2, contact_crm_id: 55, double_hr_id: null, double2_hr_id: null, crm_save_date: "2026-10-04T08:05:00+00:00", synced_at: null, visit_type: 0, visit_type_description: "Regular Visit", contact_name: "Dr B", customer_name: null, comment: null },
          { agent_hr_id: "P-1", agent_crm_id: 1, contact_crm_id: 56, double_hr_id: null, double2_hr_id: null, crm_save_date: "2026-10-04T07:50:00+00:00", synced_at: null, visit_type: 0, visit_type_description: "Regular Visit", contact_name: "Dr A", customer_name: null, comment: null },
        ],
      ],
    ]),
    checkinsByDate: new Map(),
    throughIso: "2026-10-04",
  });
  assert.equal(board.winnersByDate.get("2026-10-04"), "p1", "the earliest first Phoenix visit wins the day");

  // Every Early Birds screen names a Phoenix start for what it is, never GPS (golden rule #1).
  const race = stripComments(read("src/components/early-birds/early-birds-race-panel.tsx"));
  assert.match(race, /score\.medianStartMinutes === null && score\.phoenixClock \? \(/);
  assert.match(race, /No start\s*<\/span>/);
  assert.match(race, /First visit · \{score\.gpsVerifiedDays \+ score\.visitStartDays\}d/);
  const table2 = stripComments(read("src/components/early-birds/early-birds-rep-table.tsx"));
  assert.match(table2, /label: "First visit",/);
  assert.match(table2, /title: "Each day's start is the time of that day's first visit",/);
  assert.match(table2, /return score\.phoenixClock && source === "save_time" \? SOURCE_BADGE\.none : SOURCE_BADGE\[source\];/, "never \"Logged — not GPS-verified\" for a Phoenix rep");
  assert.match(table2, /\{phoenixBoard \? "Start days" : "GPS days"\}/);
  const history = stripComments(read("src/components/early-birds/early-birds-rep-history-panel.tsx"));
  assert.match(history, /A grey cell is a day with no start time; it is never read as late\./);
  const decisions = stripComments(read("src/lib/early-birds/decisions.ts"));
  assert.match(decisions, /\? \{ "Start days": String\(startDayCount\) \}\s*: \{ GPS: String\(row\.gps_verified_visits \?\? 0\) \}/, "the winner's card says Start days, never GPS, for a Phoenix fortnight");
  assert.match(read("src/lib/early-birds/close.ts"), /evidence: \{ timeline: score\.timeline, \.\.\.\(score\.visitStartDays \? \{ visitStartDays: score\.visitStartDays \} : \{\}\) \},/);

  // The rep's own visits page: a Phoenix visit's time stands bare.
  const workspace = stripComments(read("src/components/employee-portal/my-visits-workspace.tsx"));
  assert.match(workspace, /if \(phoenix\) return <span title=\{formatVendorLocal\(value\)\}>\{formatVendorTimeOnly\(value\)\}<\/span>;/, "no GPS or Logged word on a Phoenix visit");
  assert.equal([...workspace.matchAll(/<VisitTimeBadge phoenix=\{row\.phoenixVisit\} /g)].length, 6, "on every list, card and table of the page");
  assert.equal([...workspace.matchAll(/<VisitTimeBadge source=/g)].length, 0);
  const mine = stripComments(read("src/lib/employee-portal/my-crm-visits.ts"));
  assert.equal([...mine.matchAll(/\.\.\.\(isPhoenixNativeVisitRow\(row\) \? \{ phoenixVisit: true \} : \{\}\),/g)].length, 3, "my visits, my team's and my double visits");
}

// ── 7. The call rate and the drill-down read a Phoenix row as its own proof ────────────────────────

function runCallRateTests(): void {
  assert.equal(isPhoenixNativeVisitRow({ source: "phoenix" }), true);
  assert.equal(isPhoenixNativeVisitRow({ crm_visit_id: -3543007088324739 }), true, "a reader that did not select source knows it by the negative id");
  assert.equal(isPhoenixNativeVisitRow({ source: "ireports360", crm_visit_id: 9_120_001 }), false);
  assert.equal(isPhoenixNativeVisitRow({}), false, "a row carrying neither is a vendor row — the rule before Phoenix rows existed");
  assert.equal(isCrmDoubleVisitRow({ crm_visit_id: -42, double_crm_id: null, double_hr_id: "B-90", visit_type: 0 }), true);
  assert.equal(isCrmDoubleVisitRow({ crm_visit_id: 42, double_crm_id: null, double_hr_id: "B-90", source: "ireports360", visit_type: 0 }), false);
  const readsSource = stripComments(read("src/lib/crm/reads.ts"));
  assert.match(readsSource, /const isNative = isPhoenixNativeVisitRow\(row\);/, "the double-visit rule reads the shared predicate");
  assert.doesNotMatch(readsSource, /crm_visit_id < 0/, "and keeps no copy of it");
  assert.doesNotMatch(stripComments(read("src/lib/crm/call-rate.ts")), /crm_visit_id < 0|source === "phoenix"/, "the call rate keeps no copy of it either");

  const empty = indexCheckinsByAgentContactDay<CheckinForMatch>([]);
  assert.equal(classifyCallProof(phoenixRow(), empty), "verified", "a Phoenix visit was captured on the spot — it is its own check-in");
  assert.equal(classifyCallProof(vendorRow(), empty), "unverified", "an iReports360 visit still needs its GPS check-in");
  assert.equal(classifyCallProof(phoenixRow({ visit_type: -4 }), empty), null, "the proof rule changes nothing about what is a call");

  assert.equal(callRateExclusionOf("2026-10-05", 555, undefined, phoenixRow({ phoenix_customer_validated: false })), "not-validated", "a visit to a customer not validated yet is left out of the rate until he is");
  assert.equal(callRateExclusionOf("2026-10-05", 555, undefined, phoenixRow({ phoenix_customer_validated: true })), null, "a validated customer's visit counts");
  assert.equal(callRateExclusionOf("2026-10-05", 555, undefined, phoenixRow({ phoenix_customer_validated: null })), null, "unknown is never read as not validated");
  assert.equal(callRateExclusionOf("2026-10-05", 555, undefined, vendorRow({ phoenix_customer_validated: false })), null, "an iReports360 row is never held back by it");
  assert.equal(callRateExclusionOf("2026-10-08", 555, undefined, phoenixRow({ phoenix_customer_validated: false })), "weekend", "a Thursday stays a Thursday");

  const report = computeCallRate(
    [
      phoenixRow({ ampm: "AM", visit_date: "2026-10-04" }),
      phoenixRow({ ampm: "PM", visit_date: "2026-10-05", phoenix_customer_validated: false, contact_crm_id: 556 }),
      phoenixRow({ ampm: "PM", visit_date: "2026-10-05", contact_crm_id: 557 }),
      phoenixRow({ ampm: "PM", visit_date: "2026-10-06", contact_crm_id: null }),
    ],
    [],
    { dateFrom: "2026-10-03", dateTo: "2026-10-07" },
  );
  const rep = report.reps[0];
  assert.ok(rep && report.reps.length === 1, "one rep");
  assert.equal(rep.am.verified, 1);
  assert.equal(rep.pm.verified, 2, "the not-yet-validated customer's visit is left out; a customer new in Phoenix (no contact id) still counts");
  assert.equal(rep.am.unverified + rep.pm.unverified, 0, "no Phoenix visit is ever 'No proof'");
  assert.ok((rep.gpsCheckins ?? 0) > 0, "a rep who works in Phoenix CRM has a live feed");
  assert.equal(hasNoGpsFeed(rep), false, "and is never set aside as 'No GPS feed'");

  const vendorMonth = [vendorRow(), vendorRow({ crm_visit_id: 9_120_003, contact_crm_id: 556, ampm: "AM" }), vendorRow({ crm_visit_id: 9_120_004, visit_type: -8, contact_crm_id: null })];
  const vendorCheckins: CheckinForMatch[] = [{ agent_crm_id: 4401, agent_hr_id: "B-7", contact_crm_id: 555, check_date: "2026-09-29T09:50:00" }];
  const bare = vendorMonth.map((row) => {
    const copy: VisitForCallRate = { ...row };
    delete copy.source;
    delete copy.phoenix_customer_validated;
    return copy;
  });
  assert.deepEqual(
    computeCallRate(vendorMonth, vendorCheckins, { dateFrom: "2026-09-26", dateTo: "2026-09-30" }),
    computeCallRate(bare, vendorCheckins, { dateFrom: "2026-09-26", dateTo: "2026-09-30" }),
    "an iReports360 month reads exactly as before",
  );

  const drilldown = (overrides: Partial<VisitForRepDrilldown>): VisitForRepDrilldown => ({
    ...phoenixRow(),
    contact_name: "Dr Phoenix",
    crm_contact_grade: "A",
    crm_region_id: null,
    crm_region_name: null,
    crm_visit_id: phoenixId("00000000-0000-0000-0000-000000000001"),
    customer_name: null,
    double_hr_id: null,
    double_name: null,
    double2_hr_id: null,
    double2_name: null,
    speciality: "Pediatrics",
    ...overrides,
  });
  const visits = buildRepVisits(
    [drilldown({ phoenix_customer_validated: false }), drilldown({ visit_date: "2026-10-05", crm_visit_id: phoenixId("ffffffff-ffff-ffff-ffff-ffffffffffff") })],
    [],
    { territoryIndex: new Map() },
  );
  const waiting = visits.rows.find((row) => row.dateIso === "2026-10-04");
  const counted = visits.rows.find((row) => row.dateIso === "2026-10-05");
  assert.equal(waiting?.standing, "verified");
  assert.equal(waiting?.unscored, "not-validated");
  assert.equal(waiting ? unscoredLabel(waiting) : null, "Not scored · customer not validated yet");
  assert.equal(counted?.standing, "verified");
  assert.equal(counted?.unscored, null);

  const service = stripComments(read("src/lib/crm/call-rate-service.ts"));
  const serviceColumns = /const VISIT_COLUMNS =\s*"([^"]+)"/.exec(service)?.[1].split(",") ?? [];
  for (const column of ["crm_visit_id", "phoenix_customer_validated"]) {
    assert.ok(serviceColumns.includes(column), `the call-rate service reads ${column}`);
  }
  const drilldownData = stripComments(read("src/lib/crm/rep-visits-data.ts"));
  for (const column of ["crm_visit_id", "phoenix_customer_validated"]) {
    assert.ok(drilldownData.includes(`"${column}",`), `the drill-down reads ${column}`);
  }
  assert.equal(
    /export const VISITS_ORIGIN = "([^"]+)";/.exec(read("src/lib/business-review/sources/visits.ts"))?.[1],
    "public.crm_visits_unified via the CRM read door, keyed on visit_date",
    "the Business Review's source line stays one short line — it lands in a cell that does not wrap",
  );
}

// ── The migrations' own hygiene ───────────────────────────────────────────────────────────────────────

function runHygieneTests(code: string): void {
  const raw = read(VISITS);
  assert.match(raw, /^-- phoenix_crm_visits_everywhere\n/, "the file names itself");
  assert.match(code, /^\s*begin;\s*set local lock_timeout = '5s';/m, "one transaction that never waits on a lock for long");
  assert.ok(code.trimEnd().endsWith("commit;"));
  assert.match(raw, /-- ROLLBACK \(roll the CODE back first/, "the rollback says which half goes first");

  // It writes the seed, and the writer writes starts and their audit rows. No deduction, allowance,
  // payroll or visit row, ever.
  const writes = [...code.matchAll(/\b(insert into|update|delete from)\s+(?:public\.)?([a-z_.]+)/g)].map((match) => `${match[1]} ${match[2]}`);
  assert.deepEqual(
    [...new Set(writes)].sort(),
    ["delete from phoenix_crm_team_starts", "insert into audit_logs", "insert into phoenix_crm_team_starts", "update phoenix_crm_team_starts"],
    "the migration writes starts and their audit rows, and nothing else",
  );

  assert.match(code, /alter table public\.phoenix_crm_team_starts enable row level security;/);
  assert.match(code, /revoke all on table public\.phoenix_crm_team_starts from public, anon, authenticated;/);
  assert.match(code, /revoke all on table public\.phoenix_crm_team_starts from service_role;\s*grant select on table public\.phoenix_crm_team_starts to service_role;/, "the app reads the starts; only the writer writes them");
  assert.match(code, /alter table public\.phoenix_crm_team_start_notices enable row level security;/);
  assert.match(code, /revoke all on table public\.phoenix_crm_team_start_notices from service_role;\s*grant select, insert on table public\.phoenix_crm_team_start_notices to service_role;/, "a notice claim is inserted, never changed");
  assert.match(flat(code), /team_seat_id text primary key, -?-? ?.*?plan_id uuid not null, rep_hr_id text, week_start date not null/, "one claim per team, ever");

  for (const name of ["phoenix_crm_set_team_start", "phoenix_crm_started_team_seats", "phoenix_crm_started_team_reps"]) {
    const body = flat(functionSql(code, name));
    assert.match(body, /security definer set search_path to 'public'/, `${name} runs with a fixed search path`);
    assert.match(code, new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`), `${name} is taken from every browser role`);
    assert.match(code, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`), `the service role runs ${name}`);
  }

  for (const view of [viewSql(VISITS_DOOR, "crm_visits_unified"), viewSql(FLAGS_VIEW, "crm_visits_checkin_flags")]) assert.match(view, /with \(security_invoker = true\)/);
  assert.match(code, /revoke all on table public\.crm_visits_unified from anon, authenticated;/);
  assert.match(code, /revoke all on table public\.crm_visits_checkin_flags from anon, authenticated;/);
}

/**
 * 🔴 THE THREE DOORS ANSWER THE SAME contact_crm_id FOR THE SAME CUSTOMER, or a report invents a miss.
 *
 * A visit carrying a doctor's id against a plan that does not read MISSED — worse than the blank it
 * replaces, because a blank looks like missing data and a miss looks like a rep who did not go. So the
 * expression is pinned EQUAL ACROSS THE DOORS rather than three times separately: a session widening
 * one of them cannot leave the other two behind and stay green.
 */

/**
 * GOLDEN RULE #1 AT THE READER, not at the door.
 *
 * The door carries the Phoenix field set from 2026-10-07 (owner, asked directly: "everything, GPS and
 * evidence included"), so the ADMIN reports can print it. That ruling named the admin reports and
 * nothing else, and his 2026-10-05 ruling — "in the score, admin sees detail" — already settled where
 * it stops: the rep's own portal **My Visits** is unchanged, and the metrics never leave the server for
 * a portal.
 *
 * This is pinned at the SELECT STRING because that is where it can silently break. A select is a
 * string: nothing type-checks it, and adding `distance_meters` to the portal's list would compile,
 * render, and quietly put a rep's own GPS distance in front of him — the one reader his
 * `isLocationBlind` rule (absolute since 2026-09-29) makes fully blind.
 */
function runPortalKeepsNoneOfTheFieldSetTests(): void {
  const source = readFileSync("src/lib/employee-portal/my-crm-visits.ts", "utf8");
  // Every column of the field set as the door NAMES it, which is what a select string would have to say.
  const fieldSet = [
    "visit_kind",
    "entered_by_hr_id",
    "products",
    "samples_given",
    "product_availability",
    "objection",
    "objection_note",
    "next_step",
    "next_step_on",
    "visit_pharmacy_name",
    "is_unplanned",
    "unplanned_kind",
    "photo_path",
    "voice_note_path",
    "voice_note_seconds",
    "lat",
    "lon",
    "accuracy_meters",
    "distance_meters",
    "location_flag",
    "photo_lat",
    "photo_lon",
    "photo_accuracy_meters",
    "dwell_seconds",
    "form_open_seconds",
    "capture_source",
    "offline_seconds",
    "device_skew_minutes",
    "phoenix_synced_at",
  ];
  // The select strings only — a comment may name a column, and a prose sentence about GPS is not a read.
  const selects = [...source.matchAll(/"([a-z0-9_,.$ {}`]+)"/g)]
    .map((match) => match[1])
    .filter((value) => value.includes(","))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim());
  for (const column of fieldSet) {
    assert.ok(
      !selects.includes(column),
      `the rep's own My Visits selects ${column} — the Phoenix field set goes on the ADMIN reports, and his own GPS never goes back to him`,
    );
  }
  // And the shaper that decides who sees which half is never imported here at all, so there is no
  // second route by which a sight tier could be resolved inside a portal page.
  assert.doesNotMatch(
    source,
    /phoenix-visit-detail/,
    "My Visits does not import the detail shaper — a portal has no sight tier to resolve",
  );
}

function runContactIdAcrossDoorsTests(): void {
  const expressions = [
    { door: "crm_visits_unified", sql: VISITS_DOOR, from: "from public.phoenix_crm_countable_visits p" },
    { door: "crm_plan_entries_unified", sql: PLANS_DOOR, from: "from (\n  select\n    x.plan_id," },
    { door: "crm_checkins_unified", sql: CHECKINS_DOOR, from: "from public.phoenix_crm_countable_visits p" },
  ].map(({ door, sql, from }) => {
    const branches = viewSql(sql, door).split("\nunion all\n");
    const phoenixBranch = branches.find((branch) => branch.includes(from));
    assert.ok(phoenixBranch, `${door} has a Phoenix branch`);
    const item = itemsOf(phoenixBranch, from).find((line) => line.includes("reference_contact_crm_id"));
    assert.ok(item, `${door}'s Phoenix branch carries a contact id`);
    return { door, item };
  });
  const [first, ...rest] = expressions;
  assert.equal(
    first.item,
    "coalesce(customer.reference_contact_crm_id, customer.own_contact_crm_id)",
    "the vendor id when the doctor has one, else the id he owns in the reserved positive range",
  );
  for (const other of rest) {
    assert.equal(other.item, first.item, `${other.door} answers the same contact id as ${first.door}, to the character`);
  }

  // POSITIVE, and inside the reserved range. A negative synthetic id breaks three live constraints —
  // crm_contacts_real_contact, direct_order_pharmacies_crm_contact_id_positive — and cannot be inserted
  // into ireports360_crm_customer_brick_resolutions.crm_contact_id at all, which is an INTEGER: it
  // answers 22003 numeric field overflow, turning a permanent blank into a permanent error.
  // 🔴 EACH FACT IS ASKED OF ITS OWN LAST DEFINER, and the RANGE is pinned rather than the WORDING.
  // Both halves cost a red pin on this branch. The column and the trigger were one migration when the
  // id shipped, so reading the VIEW's definer found them by accident — and the accident ended the
  // moment the Phoenix field set redefined the view in a file of its own. Then the column's own
  // definer became `20261008001500`, which writes the constraint the way `pg_get_constraintdef` prints
  // it (`>= … and <= …`), so a pin spelled `between … and …` went red over an IDENTICAL constraint.
  // A pin on a spelling tests the author, not the database.
  const column = lastDefinerSql(/add column if not exists own_contact_crm_id bigint/, "phoenix_crm_customers.own_contact_crm_id");
  assert.match(
    column,
    /own_contact_crm_id bigint not null/,
    "the id is a column on the customer, issued once and never recomputed",
  );
  assert.match(
    column,
    /nextval\('(public\.)?crm_contacts_phoenix_id_seq'/,
    "drawn from the sequence 20260914020000 reserved for exactly this, which the vendor ids never touch",
  );
  for (const bound of ["1000000000", "2000000000"]) {
    assert.ok(
      column.includes(bound),
      `the reserved range's ${bound} bound is enforced — POSITIVE, because a negative synthetic id breaks crm_contacts_real_contact and direct_order_pharmacies_crm_contact_id_positive, and answers 22003 against ireports360_crm_customer_brick_resolutions.crm_contact_id, which is an INTEGER`,
    );
  }
  const trigger = lastDefinerSql(
    /before update of reference_contact_crm_id on public\.phoenix_crm_customers/,
    "phoenix_crm_customers_no_late_reference",
  );
  assert.match(
    trigger,
    /before update of reference_contact_crm_id on public\.phoenix_crm_customers/,
    "and a customer who has carried his own id can never be re-pointed at a vendor id afterwards",
  );
}

export function runPhoenixCrmVisitsEverywhereTests(): void {
  const code = stripSqlComments(read(VISITS));
  const plans = stripSqlComments(read(PLANS));
  runWhoStartsATeamTests(code);
  runPanelTests();
  runNoticeTests();
  runNoDoubleCountTests(code);
  runRowShapeTests(code);
  runPlanDoorTests(plans);
  runCheckinDoorTests(plans);
  runStartClockTests();
  runCallRateTests();
  runHygieneTests(code);
  runContactIdAcrossDoorsTests();
  runPortalKeepsNoneOfTheFieldSetTests();
}
