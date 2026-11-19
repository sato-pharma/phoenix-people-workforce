import assert from "node:assert/strict";

import { STALE_DECISION_CONFLICT, recordDecision } from "../src/lib/deductions/service.ts";
import { releaseDailyLines, withdrawDailyLine } from "../src/lib/daily-deductions/release.ts";
// Loaded up front so a fire-and-forget error row written by the code under test resolves its module
// from the cache and lands inside the stand-in, never after it has been taken down.
import "../src/lib/error-monitor/service.ts";
import {
  atomically,
  filtered,
  json,
  RpcRaise,
  rpcCalls,
  snapshot,
  STAND_IN_ORIGIN,
  withStandIn,
  writesTo,
  type Row,
  type Seen,
  type StandIn,
  type Tables,
} from "./support/postgrest-transaction-stand-in.ts";

/**
 * DEDUCTION MONEY PATHS, TESTED BY WHAT THEY DO (REC-078; enterprise audit F-PAY-004).
 *
 * Every test below calls the REAL domain function — `recordDecision`, `releaseDailyLines`,
 * `withdrawDailyLine` — through the REAL Supabase admin client, pointed at the shared in-memory
 * PostgREST in tests/support/postgrest-transaction-stand-in.ts. No network, no environment file, no real
 * database, and nothing can be sent: the stand-in refuses every other host, the sending keys are
 * blanked while the daily tests run, and a recorder notes any attempt to reach another host so the
 * tests can assert there was none.
 *
 * On top of the stand-in this file models, statefully, the database rules the code relies on:
 *   - the trigger phx_deductions_decisions_refuse_locked (errcode 55000) — a decision written for a
 *     candidate a publication has locked is refused, and only for rows the write actually reaches;
 *   - the trigger that stamps `updated_at` on every decision write, which is what makes
 *     `recordDecision({ expectedUpdatedAt })` a compare-and-set;
 *   - the unique key on deductions_decisions.candidate_id (a second insert is a 23505);
 *   - phx_release_daily_deduction_lines (latest body, migration 20261113181600),
 *     phx_withdraw_daily_deduction_line and phx_publish_daily_deductions (20261012132430), each as
 *     one transaction: a refusal keeps nothing it did.
 *
 * What is pinned:
 *   1. A refused decision write — a stale revision, or the lock trigger firing because a publication
 *      locked the candidate between the read and the write — leaves every table exactly as it was,
 *      writes no audit row, runs no payroll resync, and the caller reads a Conflict, never "saved".
 *   2. When the AUDIT write fails after the decision landed, the decision stands and the caller is
 *      told it saved. This is the documented design (the audit is best-effort and queued), not a defect.
 *   3. Two Super Admins deciding the same candidate from the same revision at once: exactly one
 *      lands, the other gets STALE_DECISION_CONFLICT, one audit row, the stored decision is the
 *      winner's. And two FIRST decisions on a candidate with no decision row: one insert, one Conflict.
 *   4. Daily deductions: releasing one line releases exactly that line and MERGES it into the active
 *      snapshot; the same line released twice at once is stored once and noticed once; withdrawing a
 *      released line takes out exactly that line and returns it; a refused release or withdraw changes
 *      nothing and tells nobody. The release notice reaches only stand-in tables — nothing leaves.
 */

const SUPER_ADMIN = { hrId: "B-10", loginId: "b-10", role: "Super Admin" } as const;
const CANDIDATE = "cand-41";
const SEEN = "2026-11-13T09:00:00.654321+00:00";
const PUBLICATION_LOCK = "2026-11-13T10:00:05.000000+00:00";

/** The tables with every empty array dropped: a read makes the stand-in create an empty table. */
function stored(tables: Tables): Tables {
  return Object.fromEntries(Object.entries(snapshot(tables)).filter(([, rows]) => rows.length > 0));
}

/** Let fire-and-forget work the code started (an error row, a queue drain) finish inside the stand-in. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

const reads = (seen: Seen[], table: string): Seen[] => seen.filter((request) => request.table === table && request.method === "GET");
const auditWrites = (seen: Seen[]): Seen[] => [...writesTo(seen, "audit_logs"), ...writesTo(seen, "audit_log_outbox")];
const resyncReads = (seen: Seen[]): Seen[] => reads(seen, "automated_payroll_runs");

type DatabaseRules = {
  /** Runs as a decision write reaches the database — a publication landing between read and write. */
  beforeDecisionWrite?: () => void;
};

/**
 * Wraps the stand-in's fetch (inside a `withStandIn` body) with the database's own rules, and records
 * every attempt to reach a host other than the stand-in. `withStandIn` puts the real fetch back.
 */
function applyDatabaseRules(standIn: StandIn, seen: Seen[], rules: DatabaseRules = {}): { foreign: string[] } {
  const inner = globalThis.fetch;
  const foreign: string[] = [];
  let sequence = 0;
  let revision = 0;
  const nextRevision = () => `2026-11-13T10:00:${String(++revision).padStart(2, "0")}.000001+00:00`;

  const refuseIfLocked = (candidateId: string): Response | null => {
    const candidate = (standIn.tables.deductions_candidates ?? []).find((row) => row.id === candidateId);
    if (!candidate?.locked_at) return null;
    return json(
      {
        code: "55000",
        details: null,
        hint: null,
        message: `deductions_decisions: candidate ${candidateId} is locked by a publication (locked_at=${String(candidate.locked_at)}) — withdraw its line before deciding it again`,
      },
      400,
    );
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== STAND_IN_ORIGIN) {
      foreign.push(`${url.origin}${url.pathname}`);
      return inner(input, init);
    }
    const method = String(init?.method ?? "GET").toUpperCase();
    const table = url.pathname.startsWith("/rest/v1/") && !url.pathname.startsWith("/rest/v1/rpc/") ? decodeURIComponent(url.pathname.slice(9)) : null;
    if (!table || (method !== "POST" && method !== "PATCH") || typeof init?.body !== "string") return inner(input, init);

    const parsed = JSON.parse(init.body) as Row | Row[];
    const incoming = Array.isArray(parsed) ? parsed : [parsed];
    const conflictColumns = url.searchParams.get("on_conflict")?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
    const existingRows = standIn.tables[table] ?? [];
    const rebody = (rows: Row[]): RequestInit => ({ ...init, body: JSON.stringify(Array.isArray(parsed) ? rows : rows[0]) });
    // A refusal answered here never reaches the stand-in, so it is recorded here, as the stand-in would.
    const refused = (response: Response): Response => {
      seen.push({ body: parsed, method, params: url.searchParams, rpc: null, table });
      return response;
    };

    if (table === "deductions_decisions") {
      if (method === "PATCH") {
        // A trigger fires only for the rows the UPDATE reaches: a stale revision matches none.
        const reached = filtered(existingRows, url.searchParams);
        if (reached.length > 0) {
          rules.beforeDecisionWrite?.();
          for (const row of reached) {
            const refusal = refuseIfLocked(String(row.candidate_id));
            if (refusal) return refused(refusal);
          }
        }
        return inner(input, rebody([{ ...(parsed as Row), updated_at: nextRevision() }]));
      }
      rules.beforeDecisionWrite?.();
      for (const row of incoming) {
        const refusal = refuseIfLocked(String(row.candidate_id));
        if (refusal) return refused(refusal);
      }
      if (conflictColumns.length === 0) {
        // The unique key on candidate_id: a decision row already there refuses a plain insert.
        if (incoming.some((row) => existingRows.some((current) => current.candidate_id === row.candidate_id))) {
          return refused(json({ code: "23505", details: null, hint: null, message: 'duplicate key value violates unique constraint "deductions_decisions_candidate_id_key"' }, 409));
        }
        return inner(
          input,
          rebody(incoming.map((row) => ({ created_at: "2026-11-13T10:00:00+00:00", id: `dec-${++sequence}`, ...row, updated_at: nextRevision() }))),
        );
      }
      return inner(input, rebody(incoming.map((row) => ({ ...row, updated_at: nextRevision() }))));
    }

    if (method === "POST") {
      // A column default: a new row gets an id, as `gen_random_uuid()` gives it. An upsert onto an
      // existing row keeps that row's id.
      const withIds = incoming.map((row) => {
        const lands = conflictColumns.length > 0 && existingRows.some((current) => conflictColumns.every((key) => String(current[key] ?? "") === String(row[key] ?? "")));
        return lands || row.id !== undefined ? row : { created_at: "2026-11-19T08:00:00+00:00", id: `${table}-${++sequence}`, ...row };
      });
      return inner(input, rebody(withIds));
    }
    return inner(input, init);
  }) as typeof fetch;
  return { foreign };
}

// ─────────────────────────────────────────────────────────────── 1–3. the deduction decision

function decisionTables(options: { decisionRow?: boolean } = {}): Tables {
  return {
    deductions_candidates: [
      {
        category: "dsm_no_record",
        dates: ["2026-10-05", "2026-10-06"],
        employee_hr_id: "B-77",
        employee_hr_id_compact: "b77",
        estimated_amount: 600,
        id: CANDIDATE,
        locked_at: null,
        month_key: "2026-10",
        raw_value: 2,
        unit: "days",
      },
    ],
    deductions_decisions:
      options.decisionRow === false
        ? []
        : [
            {
              actor_role_at_decision: "Super Admin",
              applied_amount: null,
              applied_dates: null,
              applied_value: null,
              candidate_id: CANDIDATE,
              created_at: "2026-11-01T00:00:00+00:00",
              decided_at: null,
              decided_by: null,
              decision_reason: "",
              decision_status: "Pending",
              hr_note: "",
              id: "dec-41",
              updated_at: SEEN,
            },
          ],
  };
}

/** A decision that moves payroll money (Pending → Approved), so a landed one WOULD resync. */
function approve(input: { appliedDates: string[]; hrNote: string; expectedUpdatedAt?: string | null }) {
  return recordDecision({
    actor: SUPER_ADMIN,
    appliedDates: input.appliedDates,
    candidateId: CANDIDATE,
    decisionReason: "Confirmed from the day report",
    decisionStatus: "Approved for Payroll",
    expectedUpdatedAt: input.expectedUpdatedAt,
    hrNote: input.hrNote,
  });
}

async function refusedDecisionWritesChangeNothing(): Promise<void> {
  // (a) A stale revision: somebody changed the decision after this screen read it.
  {
    const tables = decisionTables();
    tables.deductions_decisions[0].updated_at = "2026-11-13T09:30:00.000001+00:00";
    tables.deductions_decisions[0].decision_status = "Do Not Take Action";
    const standIn: StandIn = { tables };
    const before = stored(tables);
    await withStandIn(standIn, async (seen) => {
      applyDatabaseRules(standIn, seen);
      let outcome: unknown = "saved";
      try {
        await approve({ appliedDates: ["2026-10-05"], expectedUpdatedAt: SEEN, hrNote: "stale screen" });
      } catch (error) {
        outcome = error;
      }
      assert.ok(outcome instanceof Error, "STALE: a save over a decision that moved since the screen read it reaches the caller as a refusal, never as saved");
      assert.equal(outcome.message, STALE_DECISION_CONFLICT, "STALE: the refusal is the stale-decision Conflict");
      const decisionWrites = writesTo(seen, "deductions_decisions");
      assert.equal(decisionWrites.length, 1, "STALE: exactly one decision write was attempted");
      assert.equal(decisionWrites[0].params.get("updated_at"), `eq.${SEEN}`, "STALE: the revision the screen saw is a condition of the write itself");
      assert.equal(auditWrites(seen).length, 0, "STALE: no audit row for a decision that did not happen");
      assert.equal(resyncReads(seen).length, 0, "STALE: no payroll resync for a decision that did not happen");
      await settle();
    });
    assert.deepEqual(stored(tables), before, "STALE: every table is exactly as the other reviewer left it");
  }

  // (b) THE TRIGGER (55000): a publication locks the candidate after recordDecision read it unlocked
  // and before its write lands. Whichever way the write is made — the compare-and-set, the insert of a
  // first decision, or the plain upsert of a caller with no revision — the database refuses it.
  for (const path of ["compare-and-set", "first insert", "upsert"] as const) {
    const tables = decisionTables({ decisionRow: path !== "first insert" });
    const standIn: StandIn = { tables };
    const before = stored(tables);
    await withStandIn(standIn, async (seen) => {
      applyDatabaseRules(standIn, seen, {
        beforeDecisionWrite: () => {
          standIn.tables.deductions_candidates[0].locked_at = PUBLICATION_LOCK;
        },
      });
      let outcome: unknown = "saved";
      try {
        await approve({
          appliedDates: ["2026-10-05"],
          expectedUpdatedAt: path === "compare-and-set" ? SEEN : path === "first insert" ? null : undefined,
          hrNote: "lock landed in between",
        });
      } catch (error) {
        outcome = error;
      }
      assert.ok(outcome instanceof Error, `LOCK (${path}): the trigger's refusal reaches the caller as a refusal, never as saved`);
      assert.equal(
        outcome.message,
        "Conflict: this candidate was locked by a publication a moment ago — it can no longer be decided directly.",
        `LOCK (${path}): the trigger's 55000 is the publication-lock Conflict`,
      );
      assert.equal(writesTo(seen, "deductions_decisions").length, 1, `LOCK (${path}): exactly the one refused decision write`);
      assert.equal(auditWrites(seen).length, 0, `LOCK (${path}): no audit row claims a decision the database refused`);
      assert.equal(resyncReads(seen).length, 0, `LOCK (${path}): no payroll resync for a refused decision`);
      await settle();
    });
    const after = stored(tables);
    assert.deepEqual(after.deductions_decisions, before.deductions_decisions, `LOCK (${path}): the decisions table is exactly as it was`);
    assert.deepEqual(
      after.deductions_candidates,
      [{ ...before.deductions_candidates[0], locked_at: PUBLICATION_LOCK }],
      `LOCK (${path}): the candidate carries only the publication's own lock`,
    );
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), `LOCK (${path}): no other table gained a row`);
  }
}

async function auditFailureAfterTheDecisionLandsKeepsTheDecision(): Promise<void> {
  // The decision is one statement; the audit row and the payroll resync after it are best-effort by
  // design (writeAuditLog never throws; a failed audit row is queued to audit_log_outbox). So an audit
  // that fails AFTER the decision landed leaves the decision standing, and the caller is told it saved.
  for (const queue of ["queued for retry", "queue down too"] as const) {
    const tables = decisionTables();
    const standIn: StandIn = {
      failWrites: {
        audit_logs: { body: { code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout" }, status: 500 },
        ...(queue === "queue down too"
          ? { audit_log_outbox: { body: { code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout" }, status: 500 } }
          : {}),
      },
      tables,
    };
    await withStandIn(standIn, async (seen) => {
      applyDatabaseRules(standIn, seen);
      let outcome: unknown;
      try {
        outcome = await approve({ appliedDates: ["2026-10-05"], expectedUpdatedAt: SEEN, hrNote: "audit will fail" });
      } catch (error) {
        outcome = error;
      }
      assert.ok(!(outcome instanceof Error), `AUDIT (${queue}): the caller is told the decision saved — the audit failing after it never turns a landed decision into an error`);
      const saved = outcome as { decisionStatus: string; appliedAmount: number | null };
      assert.equal(saved.decisionStatus, "Approved for Payroll", `AUDIT (${queue}): the answer is the decision that landed`);
      assert.equal(saved.appliedAmount, 300, `AUDIT (${queue}): with the amount derived for the one day chosen`);
      assert.ok(writesTo(seen, "audit_logs").length >= 1, `AUDIT (${queue}): the audit row was attempted`);
      assert.equal(resyncReads(seen).length, 1, `AUDIT (${queue}): the payroll resync still runs for a decision that moves money`);
      await settle();
    });
    const [decision] = tables.deductions_decisions;
    assert.equal(decision.decision_status, "Approved for Payroll", `AUDIT (${queue}): the stored decision stands`);
    assert.equal(decision.applied_amount, 300, `AUDIT (${queue}): at the derived amount`);
    assert.notEqual(decision.updated_at, SEEN, `AUDIT (${queue}): and the row's revision moved, so it is the new decision`);
    assert.equal((tables.audit_logs ?? []).length, 0, `AUDIT (${queue}): no audit row was stored`);
    assert.equal(
      (tables.audit_log_outbox ?? []).length,
      queue === "queued for retry" ? 1 : 0,
      queue === "queued for retry" ? "AUDIT: the failed audit row is parked in the outbox for a later retry, not lost" : "AUDIT: with the queue down too nothing is parked",
    );
  }
}

async function twoSuperAdminsOneWinner(): Promise<void> {
  // (a) A REAL RACE on the compare-and-set: two decisions made from the same revision, at once.
  {
    const tables = decisionTables();
    const standIn: StandIn = { tables };
    let results: PromiseSettledResult<Awaited<ReturnType<typeof approve>>>[] = [];
    await withStandIn(standIn, async (seen) => {
      applyDatabaseRules(standIn, seen);
      results = await Promise.allSettled([
        approve({ appliedDates: ["2026-10-05"], expectedUpdatedAt: SEEN, hrNote: "screen A" }),
        approve({ appliedDates: ["2026-10-05", "2026-10-06"], expectedUpdatedAt: SEEN, hrNote: "screen B" }),
      ]);
      const decisionReads = seen.flatMap((request, index) => (request.table === "deductions_decisions" && request.method === "GET" ? [index] : []));
      const decisionWrites = seen.flatMap((request, index) => (request.table === "deductions_decisions" && request.method !== "GET" ? [index] : []));
      assert.equal(decisionReads.length, 2, "RACE: both callers read the decision");
      assert.equal(decisionWrites.length, 2, "RACE: both callers attempted their write");
      assert.ok(Math.max(...decisionReads) < Math.min(...decisionWrites), "RACE: both read the same revision before either wrote — a real race, not one after the other");
      assert.equal(writesTo(seen, "audit_logs").length, 1, "RACE: one audit row — the decision was applied once");
      assert.equal(resyncReads(seen).length, 1, "RACE: one payroll resync — the decision was applied once");
      await settle();
    });
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result) => result.status === "rejected");
    assert.equal(won.length, 1, "RACE: exactly one of the two decisions lands");
    assert.equal(lost.length, 1, "RACE: and exactly one is refused");
    assert.equal(((lost[0] as PromiseRejectedResult).reason as Error).message, STALE_DECISION_CONFLICT, "RACE: the loser gets the stale-decision Conflict");
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof approve>>>).value;
    assert.equal(tables.deductions_decisions.length, 1, "RACE: still one decision row");
    const [decision] = tables.deductions_decisions;
    assert.equal(decision.hr_note, winner.hrNote, "RACE: the stored decision is the winner's");
    assert.equal(decision.applied_amount, winner.appliedAmount, "RACE: at the winner's amount, never a mix of the two");
    assert.deepEqual(decision.applied_dates, winner.appliedDates, "RACE: with the winner's days");
    assert.equal(decision.updated_at, winner.updatedAt, "RACE: the row carries the winner's revision");
    const [audit] = tables.audit_logs ?? [];
    assert.equal((audit?.new_values as Row | undefined)?.hr_note, winner.hrNote, "RACE: the one audit row records the winner's decision");
  }

  // (b) Two FIRST decisions on a candidate with no decision row: both screens saw none (null).
  {
    const tables = decisionTables({ decisionRow: false });
    const standIn: StandIn = { tables };
    let results: PromiseSettledResult<Awaited<ReturnType<typeof approve>>>[] = [];
    await withStandIn(standIn, async (seen) => {
      applyDatabaseRules(standIn, seen);
      results = await Promise.allSettled([
        approve({ appliedDates: ["2026-10-05"], expectedUpdatedAt: null, hrNote: "first screen A" }),
        approve({ appliedDates: ["2026-10-05", "2026-10-06"], expectedUpdatedAt: null, hrNote: "first screen B" }),
      ]);
      assert.equal(writesTo(seen, "audit_logs").length, 1, "FIRST: one audit row — the first decision was applied once");
      assert.equal(resyncReads(seen).length, 1, "FIRST: one payroll resync");
      assert.equal(writesTo(seen, "deductions_decisions").filter((request) => request.method === "POST").length, 2, "FIRST: both callers attempted an insert");
      assert.ok(
        writesTo(seen, "deductions_decisions").every((request) => !request.params.get("on_conflict")),
        "FIRST: each is a plain insert, never an upsert that would land over the other",
      );
      await settle();
    });
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result) => result.status === "rejected");
    assert.equal(won.length, 1, "FIRST: exactly one first decision is inserted");
    assert.equal(lost.length, 1, "FIRST: the other is refused");
    assert.equal(((lost[0] as PromiseRejectedResult).reason as Error).message, STALE_DECISION_CONFLICT, "FIRST: the duplicate insert is the stale-decision Conflict");
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof approve>>>).value;
    assert.equal(tables.deductions_decisions.length, 1, "FIRST: one decision row");
    assert.equal(tables.deductions_decisions[0].hr_note, winner.hrNote, "FIRST: and it is the winner's");
    assert.equal(tables.deductions_decisions[0].applied_amount, winner.appliedAmount, "FIRST: at the winner's amount");
  }
}

// ─────────────────────────────────────────────────────────────── 4. daily deductions

const SENDING_KEYS = [
  "RESEND_API_KEY",
  "BREVO_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "ONESIGNAL_REST_API_KEY",
  "NEXT_PUBLIC_ONESIGNAL_APP_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "EMAIL_NOTIFICATIONS_ENABLED",
] as const;

/** Run `body` with every sending key blanked, putting each back afterwards. */
async function withoutSendingKeys(body: () => Promise<void>): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const saved = SENDING_KEYS.map((key) => [key, env[key]] as const);
  for (const key of SENDING_KEYS) delete env[key];
  try {
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

const CLOCK = "2026-11-19T08:00:00+00:00";
let dailySequence = 0;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function activePublication(tables: Tables): Row | undefined {
  return (tables.daily_deductions_publications ?? []).find((row) => row.status === "published" && row.superseded_at == null);
}

/** Counts, totals and the window derived from the rows that are actually there, as both functions do. */
function recount(tables: Tables, publication: Row): void {
  const lines = tables.daily_deductions_lines.filter((line) => line.publication_id === publication.id);
  publication.line_count = lines.length;
  publication.employee_count = new Set(lines.map((line) => line.employee_hr_id_compact)).size;
  const totals: Record<string, number> = {};
  for (const line of lines) totals[String(line.category)] = round2((totals[String(line.category)] ?? 0) + Number(line.amount));
  publication.category_totals = totals;
  if (lines.length > 0) {
    publication.range_start = lines.map((line) => String(line.range_start ?? publication.range_start)).sort()[0];
    publication.range_end = lines.map((line) => String(line.range_end ?? publication.range_end)).sort().at(-1);
  }
}

const nameOf = (line: Row) => String(line.employeeName ?? line.employeeHrId);

/** phx_release_daily_deduction_lines, latest body (20261113181600), as one transaction. */
function releaseLinesRpc(args: Record<string, unknown>, tables: Tables) {
  return atomically(tables, (t) => {
    const actor = String(args.p_actor ?? "").trim();
    if (!actor) throw new RpcRaise("P0001", "phx_release_daily_deduction_lines: an actor is required");
    const rangeStart = String(args.p_range_start ?? "");
    const rangeEnd = String(args.p_range_end ?? "");
    if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) {
      throw new RpcRaise("P0001", "phx_release_daily_deduction_lines: range_start must be <= range_end and neither may be null");
    }
    const lines = args.p_lines as Row[];
    if (!Array.isArray(lines) || lines.length === 0) throw new RpcRaise("P0001", "phx_release_daily_deduction_lines: p_lines must be a non-empty JSON array");
    const misdated = lines.find((line) => line.deductionDate && JSON.stringify(line.dates ?? []) !== JSON.stringify([line.deductionDate]));
    if (misdated) throw new RpcRaise("P0001", `phx_release_daily_deduction_lines: the one-day deduction for ${nameOf(misdated)} must list exactly its own day`);

    t.daily_deductions_publications ??= [];
    t.daily_deductions_lines ??= [];
    let publication = activePublication(t);
    if (!publication) {
      publication = {
        category_totals: {},
        created_at: CLOCK,
        employee_count: 0,
        id: `pub-new-${++dailySequence}`,
        line_count: 0,
        notes: args.p_notes ?? null,
        published_at: CLOCK,
        published_by: actor,
        range_end: rangeEnd,
        range_start: rangeStart,
        status: "published",
        superseded_at: null,
        superseded_by_publication_id: null,
      };
      t.daily_deductions_publications.push(publication);
    }
    const sameLine = (row: Row, line: Row) =>
      row.publication_id === publication.id && row.employee_hr_id_compact === line.employeeHrIdCompact && row.category === line.category;
    for (const line of lines) {
      if (!line.deductionDate) continue;
      if (t.daily_deductions_lines.some((row) => sameLine(row, line) && row.deduction_date == null && (row.dates as string[]).includes(String(line.deductionDate)))) {
        throw new RpcRaise("P0001", `phx_release_daily_deduction_lines: ${nameOf(line)} on ${String(line.deductionDate)} is already released inside an earlier whole-range deduction`);
      }
    }
    for (const line of lines) {
      if (line.deductionDate) continue;
      const clash = t.daily_deductions_lines.find((row) => sameLine(row, line) && row.deduction_date != null && ((line.dates as string[]) ?? []).includes(String(row.deduction_date)));
      if (clash) {
        throw new RpcRaise("P0001", `phx_release_daily_deduction_lines: ${nameOf(line)} on ${String(clash.deduction_date)} is already released on its own, so the whole range cannot be released over it`);
      }
    }
    for (const line of lines) {
      const day = line.deductionDate ? String(line.deductionDate) : null;
      const values: Row = {
        amount: Number(line.amount ?? 0),
        dates: line.dates ?? [],
        days_count: Number(line.daysCount ?? 0),
        employee_hr_id: line.employeeHrId,
        employee_name: line.employeeName || null,
        hr_note: line.hrNote ?? "",
        range_end: day ?? rangeEnd,
        range_start: day ?? rangeStart,
        raw_days_count: Number(line.rawDaysCount ?? 0),
        reason: line.reason || null,
        released_at: CLOCK,
        released_by: actor,
        source_system: line.sourceSystem ?? "",
        unit: line.unit || "days",
      };
      // on conflict (publication, employee, category, deduction_date) do update — the row keeps its id.
      const existing = t.daily_deductions_lines.find((row) => sameLine(row, line) && (row.deduction_date ?? null) === day);
      if (existing) Object.assign(existing, values);
      else {
        t.daily_deductions_lines.push({
          category: line.category,
          created_at: CLOCK,
          deduction_date: day,
          employee_hr_id_compact: line.employeeHrIdCompact,
          id: `line-new-${++dailySequence}`,
          publication_id: publication.id,
          ...values,
        });
      }
    }
    recount(t, publication);
    return { body: { ...publication }, status: 200 };
  });
}

/** phx_withdraw_daily_deduction_line (20261012132430), as one transaction. */
function withdrawLineRpc(args: Record<string, unknown>, tables: Tables) {
  return atomically(tables, (t) => {
    if (!String(args.p_actor ?? "").trim()) throw new RpcRaise("P0001", "phx_withdraw_daily_deduction_line: an actor is required");
    const publication = activePublication(t);
    if (!publication) throw new RpcRaise("P0001", "phx_withdraw_daily_deduction_line: nothing is published, so there is no line to withdraw");
    const line = (t.daily_deductions_lines ?? []).find((row) => row.id === args.p_line_id && row.publication_id === publication.id);
    if (!line) throw new RpcRaise("P0001", `phx_withdraw_daily_deduction_line: line ${String(args.p_line_id)} is not in the active snapshot`);
    t.daily_deductions_lines = t.daily_deductions_lines.filter((row) => row !== line);
    if (t.daily_deductions_lines.every((row) => row.publication_id !== publication.id)) {
      Object.assign(publication, { category_totals: {}, employee_count: 0, line_count: 0, status: "superseded", superseded_at: CLOCK });
    } else {
      recount(t, publication);
    }
    return { body: line, status: 200 };
  });
}

/** phx_publish_daily_deductions (20261012132430): the replace-everything publish the page no longer calls. */
function publishEverythingRpc(args: Record<string, unknown>, tables: Tables) {
  return atomically(tables, (t) => {
    const actor = String(args.p_actor ?? "").trim();
    t.daily_deductions_publications ??= [];
    t.daily_deductions_lines ??= [];
    const old = activePublication(t);
    const publication: Row = {
      category_totals: {},
      created_at: CLOCK,
      employee_count: 0,
      id: `pub-replaced-${++dailySequence}`,
      line_count: 0,
      notes: null,
      published_at: CLOCK,
      published_by: actor,
      range_end: args.p_range_end,
      range_start: args.p_range_start,
      status: "published",
      superseded_at: null,
      superseded_by_publication_id: null,
    };
    if (old) Object.assign(old, { status: "superseded", superseded_at: CLOCK, superseded_by_publication_id: publication.id });
    t.daily_deductions_publications.push(publication);
    for (const line of (args.p_lines as Row[]) ?? []) {
      t.daily_deductions_lines.push({
        amount: Number(line.amount ?? 0),
        category: line.category,
        created_at: CLOCK,
        dates: line.dates ?? [],
        days_count: Number(line.daysCount ?? 0),
        deduction_date: null,
        employee_hr_id: line.employeeHrId,
        employee_hr_id_compact: line.employeeHrIdCompact,
        employee_name: line.employeeName || null,
        id: `line-replaced-${++dailySequence}`,
        publication_id: publication.id,
        range_end: args.p_range_end,
        range_start: args.p_range_start,
        released_at: CLOCK,
        released_by: actor,
      });
    }
    recount(t, publication);
    return { body: { ...publication }, status: 200 };
  });
}

const DAILY_RPCS = {
  phx_publish_daily_deductions: publishEverythingRpc,
  phx_release_daily_deduction_lines: releaseLinesRpc,
  phx_withdraw_daily_deduction_line: withdrawLineRpc,
};

function releasedLine(overrides: Row): Row {
  return {
    amount: 500,
    created_at: "2026-11-12T08:00:00+00:00",
    days_count: 1,
    hr_note: "",
    publication_id: "pub-1",
    raw_days_count: 1,
    reason: null,
    released_at: "2026-11-12T08:00:00+00:00",
    released_by: "B-10",
    source_system: "daily_tally",
    unit: "days",
    ...overrides,
  };
}

/** An active snapshot already holding two released one-day lines, and the people the notices read. */
function dailyTables(): Tables {
  return {
    daily_deductions_lines: [
      releasedLine({
        amount: 400,
        category: "no_records_activity",
        dates: ["2026-11-03"],
        deduction_date: "2026-11-03",
        employee_hr_id: "B-55",
        employee_hr_id_compact: "b55",
        employee_name: "Sara Nabil",
        id: "line-1",
        range_end: "2026-11-03",
        range_start: "2026-11-03",
      }),
      releasedLine({
        category: "unpaid_vacation",
        dates: ["2026-11-09"],
        deduction_date: "2026-11-09",
        employee_hr_id: "B-77",
        employee_hr_id_compact: "b77",
        employee_name: "Omar Gawish",
        id: "line-2",
        range_end: "2026-11-09",
        range_start: "2026-11-09",
      }),
    ],
    daily_deductions_publications: [
      {
        category_totals: { no_records_activity: 400, unpaid_vacation: 500 },
        created_at: "2026-11-12T08:00:00+00:00",
        employee_count: 2,
        id: "pub-1",
        line_count: 2,
        notes: null,
        published_at: "2026-11-12T08:00:00+00:00",
        published_by: "B-10",
        range_end: "2026-11-09",
        range_start: "2026-11-03",
        status: "published",
        superseded_at: null,
        superseded_by_publication_id: null,
      },
    ],
    // A real address and a manager, so the employee's email and the manager CC both run their course.
    employees: [
      { employment_status: "active", full_name: "Omar Gawish", hr_id: "B-77", is_active: true, manager_hr_id: "B-20", work_email: "omar.gawish@example.invalid" },
      { employment_status: "active", full_name: "Hany Mostafa", hr_id: "B-20", is_active: true, work_email: "hany.mostafa@example.invalid" },
      { employment_status: "active", full_name: "Sara Nabil", hr_id: "B-55", is_active: true, manager_hr_id: "B-20", work_email: "sara.nabil@example.invalid" },
    ],
  };
}

/** One day of Omar's unpaid leave, as the Daily Deductions page sends it. */
const OMAR_DAY_10 = {
  amount: 500,
  category: "unpaid_vacation",
  dates: ["2026-11-10"],
  daysCount: 1,
  deductionDate: "2026-11-10",
  employeeHrId: "B-77",
  employeeName: "Omar Gawish",
  rawDaysCount: 1,
  sourceSystem: "daily_tally",
};

function release(lines: unknown[]) {
  return releaseDailyLines({ actor: SUPER_ADMIN, lines, rangeEnd: "2026-11-18", rangeStart: "2026-11-01", todayIso: "2026-11-19" });
}

const notificationWrites = (seen: Seen[]): Seen[] =>
  seen.filter((request) => request.method !== "GET" && /^notification/.test(request.table ?? ""));
const releaseAudits = (tables: Tables): Row[] => (tables.audit_logs ?? []).filter((row) => row.entity_type === "daily_deductions_publication");
const noticeKeysFor = (tables: Tables, lineId: string): string[] =>
  (tables.notification_events ?? []).map((row) => String(row.event_key)).filter((key) => key.startsWith(`deduction-pushed:${lineId}:`));

async function releasingOneLineMergesIt(): Promise<void> {
  const tables = dailyTables();
  const standIn: StandIn = { rpc: DAILY_RPCS, tables };
  const before = snapshot(tables);
  await withoutSendingKeys(async () => {
    await withStandIn(standIn, async (seen) => {
      const { foreign } = applyDatabaseRules(standIn, seen);
      const result = await release([OMAR_DAY_10]);
      await settle();

      assert.equal(result.releasedCount, 1, "RELEASE: one line was released");
      assert.equal(result.publication.id, "pub-1", "RELEASE: into the snapshot already active — a release MERGES, it never starts a new one");
      assert.equal(rpcCalls(seen, "phx_release_daily_deduction_lines").length, 1, "RELEASE: through the per-line release");
      assert.equal(rpcCalls(seen, "phx_publish_daily_deductions").length, 0, "RELEASE: never through the replace-everything publish");
      assert.deepEqual(foreign, [], "RELEASE: the notice reached no host but the stand-in — nothing was sent anywhere");
      assert.ok(notificationWrites(seen).length > 0, "RELEASE: the notice ran and every one of its writes landed in the stand-in");
      const [notice] = result.notifications;
      assert.equal(result.notifications.length, 1, "RELEASE: one notice, for the one line released");
      assert.equal(notice.employeeHrId, "B-77", "RELEASE: addressed to the employee charged");
    });
  });

  assert.equal(tables.daily_deductions_publications.length, 1, "RELEASE: still one snapshot");
  const [publication] = tables.daily_deductions_publications;
  assert.equal(publication.status, "published", "RELEASE: the snapshot is still the active one");
  assert.equal(publication.superseded_at, null, "RELEASE: and was not superseded");
  assert.equal(publication.line_count, 3, "RELEASE: it now holds the two earlier lines and the new one");
  assert.deepEqual(publication.category_totals, { no_records_activity: 400, unpaid_vacation: 1000 }, "RELEASE: its totals count the new day once, beside the earlier ones");
  assert.deepEqual(
    tables.daily_deductions_lines.filter((line) => line.id === "line-1" || line.id === "line-2"),
    before.daily_deductions_lines,
    "RELEASE: the lines released earlier are exactly as they were",
  );
  const added = tables.daily_deductions_lines.filter((line) => line.id !== "line-1" && line.id !== "line-2");
  assert.equal(added.length, 1, "RELEASE: exactly one row was added");
  assert.equal(added[0].employee_hr_id_compact, "b77", "RELEASE: for the employee released");
  assert.equal(added[0].category, "unpaid_vacation", "RELEASE: for the type released");
  assert.equal(added[0].deduction_date, "2026-11-10", "RELEASE: as its own one-day row — never grouped with the employee's other day");
  assert.deepEqual(added[0].dates, ["2026-11-10"], "RELEASE: charging exactly that day");
  assert.equal(added[0].amount, 500, "RELEASE: at the figure released");
  assert.deepEqual(noticeKeysFor(tables, String(added[0].id)), [`deduction-pushed:${String(added[0].id)}:2026-11-10`], "RELEASE: the employee's notice names that row and that day");
  assert.deepEqual(noticeKeysFor(tables, "line-1"), [], "RELEASE: nobody is re-told about a line released earlier");
  assert.deepEqual(noticeKeysFor(tables, "line-2"), [], "RELEASE: not even the same employee's earlier day");
  assert.equal(releaseAudits(tables).length, 1, "RELEASE: one audit row records the release");
}

async function sameLineReleasedTwiceAtOnce(): Promise<void> {
  // The page's Release pressed twice, or two tabs: the same line, at once. The function is an upsert
  // on employee × type × day under one lock, so both calls answer — and the end state holds the line
  // once, priced once, told once. There is no Conflict to return here by design: the second release
  // writes the same row with the same figures.
  const tables = dailyTables();
  const standIn: StandIn = { rpc: DAILY_RPCS, tables };
  let results: PromiseSettledResult<Awaited<ReturnType<typeof release>>>[] = [];
  await withoutSendingKeys(async () => {
    await withStandIn(standIn, async (seen) => {
      const { foreign } = applyDatabaseRules(standIn, seen);
      results = await Promise.allSettled([release([OMAR_DAY_10]), release([OMAR_DAY_10])]);
      await settle();
      assert.equal(rpcCalls(seen, "phx_release_daily_deduction_lines").length, 2, "TWICE: both releases reached the database");
      assert.deepEqual(foreign, [], "TWICE: neither notice reached any host but the stand-in");
    });
  });
  assert.ok(results.every((result) => result.status === "fulfilled"), "TWICE: both calls answer — re-releasing the same line is not an error");
  const rows = tables.daily_deductions_lines.filter((line) => line.employee_hr_id_compact === "b77" && line.category === "unpaid_vacation" && line.deduction_date === "2026-11-10");
  assert.equal(rows.length, 1, "TWICE: the line is stored once — one row for employee × type × day");
  const [publication] = tables.daily_deductions_publications;
  assert.equal(publication.line_count, 3, "TWICE: the snapshot counts it once");
  assert.deepEqual(publication.category_totals, { no_records_activity: 400, unpaid_vacation: 1000 }, "TWICE: and charges it once, never 1,500");
  const lineIds = results.map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof release>>>).value.notifications[0]?.lineId);
  assert.deepEqual(lineIds, [rows[0].id, rows[0].id], "TWICE: both answers name the same stored row");
  assert.deepEqual(noticeKeysFor(tables, String(rows[0].id)), [`deduction-pushed:${String(rows[0].id)}:2026-11-10`], "TWICE: the employee's notice is one notice, under one key");
}

async function withdrawingAReleasedLineReturnsIt(): Promise<void> {
  const tables = dailyTables();
  const standIn: StandIn = { rpc: DAILY_RPCS, tables };
  const before = snapshot(tables);
  await withoutSendingKeys(async () => {
    await withStandIn(standIn, async (seen) => {
      const { foreign } = applyDatabaseRules(standIn, seen);
      const { line } = await withdrawDailyLine({ actor: SUPER_ADMIN, lineId: "line-2" });
      await settle();
      const stored2 = before.daily_deductions_lines.find((row) => row.id === "line-2") as Row;
      assert.equal(line.id, "line-2", "WITHDRAW: the call returns the line it took out");
      assert.equal(line.employeeHrId, stored2.employee_hr_id, "WITHDRAW: with its employee");
      assert.equal(line.category, stored2.category, "WITHDRAW: its type");
      assert.equal(line.amount, stored2.amount, "WITHDRAW: the figure it charged");
      assert.equal(line.daysCount, stored2.days_count, "WITHDRAW: its days");
      assert.deepEqual(line.dates, stored2.dates, "WITHDRAW: and exactly the dates it charged");
      assert.equal(line.deductionDate, stored2.deduction_date, "WITHDRAW: its one day");
      assert.equal(rpcCalls(seen, "phx_withdraw_daily_deduction_line").length, 1, "WITHDRAW: through the one-line withdraw");
      assert.equal(notificationWrites(seen).length, 0, "WITHDRAW: a withdraw notifies nobody");
      assert.deepEqual(foreign, [], "WITHDRAW: and reaches no other host");
    });
  });
  assert.deepEqual(
    tables.daily_deductions_lines,
    before.daily_deductions_lines.filter((row) => row.id !== "line-2"),
    "WITHDRAW: exactly that line left the snapshot; every other line is untouched",
  );
  const [publication] = tables.daily_deductions_publications;
  assert.equal(publication.status, "published", "WITHDRAW: the snapshot stays active while a line is left");
  assert.equal(publication.line_count, 1, "WITHDRAW: its count drops by one");
  assert.deepEqual(publication.category_totals, { no_records_activity: 400 }, "WITHDRAW: and its totals no longer charge the withdrawn day");
  const [audit] = releaseAudits(tables);
  assert.equal(releaseAudits(tables).length, 1, "WITHDRAW: one audit row");
  assert.deepEqual(
    audit.old_values,
    { amount: 500, category: "unpaid_vacation", daysCount: 1, employeeHrId: "B-77" },
    "WITHDRAW: the audit row records the line that was taken out",
  );
}

async function refusedReleaseOrWithdrawChangesNothing(): Promise<void> {
  // (a) A release the database refuses: Omar's 10 November is already inside an older whole-range row.
  {
    const tables = dailyTables();
    tables.daily_deductions_lines.push(
      releasedLine({
        amount: 1500,
        category: "unpaid_vacation",
        dates: ["2026-11-10", "2026-11-11", "2026-11-12"],
        deduction_date: null,
        employee_hr_id: "B-77",
        employee_hr_id_compact: "b77",
        employee_name: "Omar Gawish",
        id: "line-range",
        range_end: "2026-11-12",
        range_start: "2026-11-10",
      }),
    );
    const standIn: StandIn = { rpc: DAILY_RPCS, tables };
    const before = stored(tables);
    await withoutSendingKeys(async () => {
      await withStandIn(standIn, async (seen) => {
        const { foreign } = applyDatabaseRules(standIn, seen);
        let outcome: unknown = "released";
        try {
          await release([OMAR_DAY_10]);
        } catch (error) {
          outcome = error;
        }
        await settle();
        assert.ok(outcome instanceof Error, "REFUSED RELEASE: the database's refusal reaches the caller, never as released");
        assert.match(
          outcome.message,
          /^Failed to release the selected daily deductions: .*Omar Gawish on 2026-11-10 is already released inside an earlier whole-range deduction/,
          "REFUSED RELEASE: the caller is told why — the day would be charged twice",
        );
        assert.equal(notificationWrites(seen).length, 0, "REFUSED RELEASE: nobody is told about a release that did not happen");
        assert.equal(auditWrites(seen).length, 0, "REFUSED RELEASE: no audit row");
        assert.deepEqual(foreign, [], "REFUSED RELEASE: and no other host was reached");
      });
    });
    assert.deepEqual(stored(tables), before, "REFUSED RELEASE: every table is exactly as it was");
  }

  // (b) A line that was already withdrawn is withdrawn again (a stale screen, a second click).
  {
    const tables = dailyTables();
    tables.daily_deductions_lines = tables.daily_deductions_lines.filter((row) => row.id !== "line-2");
    Object.assign(tables.daily_deductions_publications[0], { category_totals: { no_records_activity: 400 }, employee_count: 1, line_count: 1 });
    const standIn: StandIn = { rpc: DAILY_RPCS, tables };
    const before = stored(tables);
    await withoutSendingKeys(async () => {
      await withStandIn(standIn, async (seen) => {
        const { foreign } = applyDatabaseRules(standIn, seen);
        let outcome: unknown = "withdrawn";
        try {
          await withdrawDailyLine({ actor: SUPER_ADMIN, lineId: "line-2" });
        } catch (error) {
          outcome = error;
        }
        await settle();
        assert.ok(outcome instanceof Error, "REFUSED WITHDRAW: withdrawing a line already gone is refused, never answered withdrawn");
        assert.match(
          outcome.message,
          /^Failed to withdraw the released deduction: .*line line-2 is not in the active snapshot/,
          "REFUSED WITHDRAW: the caller is told the line is no longer in the snapshot",
        );
        assert.equal(auditWrites(seen).length, 0, "REFUSED WITHDRAW: no audit row for a withdraw that did not happen");
        assert.equal(notificationWrites(seen).length, 0, "REFUSED WITHDRAW: nobody is told");
        assert.deepEqual(foreign, [], "REFUSED WITHDRAW: and no other host was reached");
      });
    });
    assert.deepEqual(stored(tables), before, "REFUSED WITHDRAW: every table is exactly as it was");
  }
}

export async function runDeductionsMoneyPathsBehaviourTests(): Promise<void> {
  await refusedDecisionWritesChangeNothing();
  await auditFailureAfterTheDecisionLandsKeepsTheDecision();
  await twoSuperAdminsOneWinner();
  await releasingOneLineMergesIt();
  await sameLineReleasedTwiceAtOnce();
  await withdrawingAReleasedLineReturnsIt();
  await refusedReleaseOrWithdrawChangesNothing();
}
