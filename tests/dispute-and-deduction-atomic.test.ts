import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DISPUTE_DECISION_CLAIM_LAPSE_MINUTES, type DeductionDisputeSnapshot } from "../src/lib/dispute-center/decision-claim.ts";
import { decideDeductionDispute, type DecideDeductionDisputeDeps } from "../src/lib/dispute-center/deduction.ts";
import type { CaseEventInput } from "../src/lib/dispute-center/events.ts";
import { deriveDisputeCaseState } from "../src/lib/dispute-center/state.ts";
import type { DisputeCaseEvent } from "../src/lib/dispute-center/types.ts";
import { STALE_DECISION_CONFLICT, recordDecision } from "../src/lib/deductions/service.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * A DISPUTE DECISION IS ALL OR NOTHING, ONE AT A TIME — AND A DEDUCTION DECISION NEVER OVERWRITES WHAT
 * IT DID NOT SEE (enterprise audit 2026-11-13, F-PAY-005 and F-PAY-004).
 *
 * F-PAY-005. decideDeductionDispute was five or six separate writes — the payslip line off, the
 * decision, the smaller figure back on, a refund recommended or cancelled — with the "decided" event
 * LAST and the "already decided" gate a plain read in front of all of them. Two decides of one case
 * both passed the gate; a failure after the money moved but before the event left the case reading
 * open while payroll already charged the new figure. Now the case is CLAIMED before the first write,
 * "already decided" is asked again under the claim, the before-state is captured, and a failure after
 * the first write puts everything back before the claim is released.
 *
 * F-PAY-004. recordDecision read the candidate's lock, then upserted the decision with no condition,
 * so a publication locking the candidate in between was overwritten; and a reviewer's save landed over
 * a decision somebody else changed after the screen loaded. The trigger
 * phx_deductions_decisions_refuse_locked now refuses the first in the database, and an optional
 * expected revision makes the save a compare-and-set.
 *
 * The behaviour is exercised against stand-ins for the database: decideDeductionDispute through its
 * `deps` (no Supabase client is built), recordDecision through the real client with every request
 * answered by an in-memory PostgREST, as tests/deduction-open-step-saved-figure.test.ts does.
 */

// ─────────────────────────────────────────────────────────── the in-memory deduction world

type Row = Record<string, unknown>;

type World = {
  candidates: Map<string, Row>;
  decisions: Map<string, Row>;
  lines: Row[];
  refunds: Row[];
  events: Row[];
  claims: Map<string, { token: string; lapseAt: number; claimedAt: string; snapshot: DeductionDisputeSnapshot | null }>;
  monthState: "open" | "paid";
  tick: number;
  writes: string[];
  notified: number;
};

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const clone = <T>(value: T): T => structuredClone(value);

function world(options: { pushed?: boolean; monthState?: "open" | "paid" } = {}): World {
  const pushed = options.pushed ?? true;
  return {
    candidates: new Map([
      [
        CANDIDATE_ID,
        {
          category: "fingerprint",
          dates: ["2026-10-05", "2026-10-06"],
          employee_hr_id: "B-77",
          employee_hr_id_compact: "b77",
          employee_name: "Test Person",
          estimated_amount: 600,
          evidence: {},
          id: CANDIDATE_ID,
          locked_at: pushed ? "2026-10-30T10:00:00.000000+00:00" : null,
          month_key: "2026-10",
          raw_value: 2,
          reason: "Two days with no fingerprint",
          severity: null,
          unit: "days",
        },
      ],
    ]),
    claims: new Map(),
    decisions: new Map([
      [
        CANDIDATE_ID,
        {
          applied_amount: 600,
          applied_dates: null,
          applied_value: 2,
          candidate_id: CANDIDATE_ID,
          decided_at: "2026-10-29T09:00:00.000000+00:00",
          decided_by: "B-10",
          decision_reason: "Approved",
          decision_status: "Approved for Payroll",
          hr_note: "",
        },
      ],
    ]),
    events: [],
    lines: pushed
      ? [
          {
            applied_amount: 600,
            applied_value: 2,
            candidate_id: CANDIDATE_ID,
            employee_hr_id: "B-77",
            employee_name: "Test Person",
            id: "line-1",
            line_status: "active",
            month_key: "2026-10",
            publication_id: "pub-1",
            superseded_by_line_id: null,
          },
        ]
      : [],
    monthState: options.monthState ?? "open",
    notified: 0,
    refunds: [],
    tick: 0,
    writes: [],
  };
}

/** Every table a decision can touch, as the database would hold it. The claims are compared on their own. */
function tables(w: World) {
  return clone({
    candidates: [...w.candidates.values()],
    decisions: [...w.decisions.values()],
    events: w.events,
    lines: w.lines,
    refunds: w.refunds,
  });
}

/** Let the other decide run: every database call is a round trip. */
const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve));

function nowIso(w: World): string {
  w.tick += 1;
  return new Date(Date.UTC(2026, 10, 13, 10, 0, w.tick)).toISOString();
}

function toEvent(row: Row): DisputeCaseEvent {
  return {
    actorHrId: (row.actor_hr_id as string | null) ?? null,
    actorName: null,
    actorRole: (row.actor_role as string | null) ?? null,
    createdAt: String(row.created_at),
    details: (row.details as Record<string, unknown>) ?? {},
    eventType: row.event_type as DisputeCaseEvent["eventType"],
    id: String(row.id),
    note: (row.note as string | null) ?? null,
  };
}

function appendEvents(w: World, inputs: CaseEventInput[]) {
  const createdAt = nowIso(w);
  for (const input of inputs) {
    w.events.push({
      actor_hr_id: input.actorHrId,
      actor_role: input.actorRole,
      case_kind: input.kind,
      case_ref: input.ref,
      created_at: createdAt,
      details: input.details ?? {},
      event_type: input.eventType,
      id: `ev-${w.events.length + 1}`,
      note: input.note ?? null,
    });
  }
}

function chargeOf(candidate: Row, value: number): number {
  return Math.round(((Number(candidate.estimated_amount) * value) / Number(candidate.raw_value)) * 100) / 100;
}

/**
 * Stand-ins that do to the in-memory world what the real functions do to the database, closely enough
 * that "the world is back as it was" means the same thing it means there. `failAt` makes one step
 * throw — the injected failure — and `restoreFails` makes the undo itself fail.
 */
function fakeDeps(
  w: World,
  options: { failAt?: keyof DecideDeductionDisputeDeps; restoreFails?: boolean } = {},
): DecideDeductionDisputeDeps {
  const failing = <F extends (...args: never[]) => Promise<unknown>>(name: keyof DecideDeductionDisputeDeps, fn: F): F =>
    (async (...args: never[]) => {
      await roundTrip();
      if (options.failAt === name) throw new Error(`injected failure in ${String(name)}`);
      return fn(...args);
    }) as unknown as F;
  const write = (name: string) => w.writes.push(name);

  const deps = {
    cancelLiveRefund: failing("cancelLiveRefund", async (input: { ref: string; reason: string; deferEvents?: CaseEventInput[]; actorHrId: string | null; actorRole: string | null; kind: "deduction" }) => {
      write("cancelLiveRefund");
      const live = w.refunds.find((refund) => refund.case_ref === input.ref && refund.status === "recommended");
      if (!live) return { alreadyPaid: null, cancelled: null };
      live.status = "cancelled";
      live.cancelled_at = nowIso(w);
      live.cancel_reason = input.reason;
      const event: CaseEventInput = { actorHrId: input.actorHrId, actorRole: input.actorRole, eventType: "refund_cancelled", kind: "deduction", ref: input.ref };
      if (input.deferEvents) input.deferEvents.push(event);
      else appendEvents(w, [event]);
      return { alreadyPaid: null, cancelled: null };
    }),
    capture: failing("capture", async (candidateId: string): Promise<DeductionDisputeSnapshot> => {
      const candidate = w.candidates.get(candidateId)!;
      return clone({
        candidateId,
        decision: w.decisions.get(candidateId) ?? null,
        lines: w.lines.filter((line) => line.candidate_id === candidateId),
        lockedAt: (candidate.locked_at as string | null) ?? null,
        monthKey: String(candidate.month_key),
        publicationIds: ["pub-1"],
        refunds: w.refunds.filter((refund) => refund.case_ref === candidateId),
      });
    }),
    claim: failing("claim", async (input: { kind: string; ref: string; claimedBy: string | null }) => {
      // One statement in the database: check and take, with nothing in between.
      const key = `${input.kind}:${input.ref}`;
      const held = w.claims.get(key);
      if (held && held.lapseAt > Date.now()) return { claimedAt: held.claimedAt, held: false as const };
      const token = `token-${w.tick}-${Math.random()}`;
      w.claims.set(key, { claimedAt: nowIso(w), lapseAt: Date.now() + 5 * 60_000, snapshot: null, token });
      return { held: true as const, interrupted: null, token };
    }),
    listEvents: failing("listEvents", async (_kind: string, refs: string[]) => {
      const map = new Map<string, DisputeCaseEvent[]>();
      for (const ref of refs) map.set(ref, w.events.filter((event) => event.case_ref === ref).map(toEvent));
      return map;
    }),
    loadParts: failing("loadParts", async (ids: string[]) => {
      const candidates = new Map();
      const decisions = new Map();
      const lines = new Map();
      for (const id of ids) {
        const candidate = w.candidates.get(id);
        if (candidate) candidates.set(id, clone(candidate));
        const decision = w.decisions.get(id);
        if (decision) decisions.set(id, clone(decision));
        for (const line of w.lines.filter((row) => row.candidate_id === id)) {
          const existing = lines.get(id);
          if (!existing || line.line_status === "active") lines.set(id, clone(line));
        }
      }
      return { candidates, decisions, lines };
    }),
    notify: failing("notify", async () => {
      w.notified += 1;
      return undefined;
    }),
    payrollMonthState: failing("payrollMonthState", async () => w.monthState),
    pushDeduction: failing("pushDeduction", async (input: { candidateId: string }) => {
      write("pushDeduction");
      const candidate = w.candidates.get(input.candidateId)!;
      const decision = w.decisions.get(input.candidateId)!;
      const id = `line-${w.lines.length + 1}`;
      for (const line of w.lines) {
        if (line.candidate_id === input.candidateId && line.line_status === "active") {
          line.line_status = "withdrawn";
          line.superseded_by_line_id = id;
        }
      }
      w.lines.push({
        applied_amount: decision.applied_amount,
        applied_value: decision.applied_value,
        candidate_id: input.candidateId,
        employee_hr_id: candidate.employee_hr_id,
        employee_name: candidate.employee_name,
        id,
        line_status: "active",
        month_key: candidate.month_key,
        publication_id: "pub-1",
        superseded_by_line_id: null,
      });
      if (!candidate.locked_at) candidate.locked_at = nowIso(w);
      return { appliedAmount: Number(decision.applied_amount), candidateId: input.candidateId, lineId: id, ok: true as const };
    }),
    recommendDisputeRefund: failing("recommendDisputeRefund", async (input: { ref: string; amount: number; reason: string; deferEvents?: CaseEventInput[]; actorHrId: string | null; actorRole: string | null }) => {
      write("recommendDisputeRefund");
      for (const refund of w.refunds) {
        if (refund.case_ref === input.ref && refund.status === "recommended") {
          refund.status = "cancelled";
          refund.cancelled_at = nowIso(w);
        }
      }
      const refund = { amount: input.amount, cancel_reason: null, cancelled_at: null, case_kind: "deduction", case_ref: input.ref, id: `refund-${w.refunds.length + 1}`, reason: input.reason, status: "recommended", target_month_key: "2026-11" };
      w.refunds.push(refund);
      const event: CaseEventInput = { actorHrId: input.actorHrId, actorRole: input.actorRole, eventType: "refund_recommended", kind: "deduction", ref: input.ref };
      if (input.deferEvents) input.deferEvents.push(event);
      else appendEvents(w, [event]);
      return { refund: { amount: input.amount, createdAt: "", id: refund.id, reason: input.reason, sourceMonthKey: "2026-10", status: "recommended" as const, targetMonthKey: "2026-11" }, sentence: "Refund recommended in November 2026 payroll." };
    }),
    recordDecision: failing("recordDecision", async (input: { candidateId: string; decisionStatus: string; decisionReason: string; hrNote?: string; appliedValue?: number | null; actor: { hrId: string | null } }) => {
      const candidate = w.candidates.get(input.candidateId)!;
      // The module's own rule, and now the database's too: a locked candidate is not decided.
      if (candidate.locked_at) throw new Error("Conflict: this candidate is locked by a publication — it can no longer be decided directly.");
      write("recordDecision");
      const value = input.appliedValue === undefined ? Number(candidate.raw_value) : Number(input.appliedValue);
      const row = {
        applied_amount: chargeOf(candidate, value),
        applied_dates: null,
        applied_value: value,
        candidate_id: input.candidateId,
        decided_at: nowIso(w),
        decided_by: input.actor.hrId,
        decision_reason: input.decisionReason,
        decision_status: input.decisionStatus,
        hr_note: input.hrNote ?? "",
      };
      w.decisions.set(input.candidateId, row);
      return { appliedAmount: row.applied_amount, appliedValue: row.applied_value, payrollNotices: [] as string[] };
    }),
    recordEvents: failing("recordEvents", async (inputs: CaseEventInput[]) => {
      write("recordEvents");
      appendEvents(w, inputs);
    }),
    release: failing("release", async (input: { kind: string; ref: string; token: string }) => {
      const key = `${input.kind}:${input.ref}`;
      if (w.claims.get(key)?.token === input.token) w.claims.delete(key);
    }),
    resolveParticipant: failing("resolveParticipant", async () => ({
      canRead: true,
      isOwner: false,
      isReviewer: true,
      ownerHrId: "B-77",
      viewerHrId: "B-10",
    })),
    restore: failing("restore", async (input: { snapshot: DeductionDisputeSnapshot }) => {
      // What phx_restore_deduction_dispute_state does, in one go.
      if (options.restoreFails) throw new Error("the undo was refused");
      const snap = input.snapshot;
      const keepLines = new Set(snap.lines.map((line) => String(line.id)));
      w.lines = w.lines.filter((line) => line.candidate_id !== snap.candidateId || keepLines.has(String(line.id)));
      for (const before of snap.lines) {
        const line = w.lines.find((row) => row.id === before.id)!;
        Object.assign(line, clone(before));
      }
      if (snap.decision) w.decisions.set(snap.candidateId, clone(snap.decision));
      else w.decisions.delete(snap.candidateId);
      const keepRefunds = new Set(snap.refunds.map((refund) => String(refund.id)));
      w.refunds = w.refunds.filter((refund) => refund.case_ref !== snap.candidateId || keepRefunds.has(String(refund.id)));
      for (const before of snap.refunds) Object.assign(w.refunds.find((row) => row.id === before.id)!, clone(before));
      w.candidates.get(snap.candidateId)!.locked_at = snap.lockedAt;
      return { publicationsLeftEmpty: [] };
    }),
    stampSnapshot: failing("stampSnapshot", async (input: { kind: string; ref: string; token: string; snapshot: DeductionDisputeSnapshot }) => {
      const claim = w.claims.get(`${input.kind}:${input.ref}`);
      if (claim?.token === input.token) claim.snapshot = clone(input.snapshot);
    }),
    withdrawDeduction: failing("withdrawDeduction", async (input: { lineId: string }) => {
      write("withdrawDeduction");
      const line = w.lines.find((row) => row.id === input.lineId && row.line_status === "active");
      if (!line) return { ok: false, reason: "line not found or already withdrawn" };
      line.line_status = "withdrawn";
      w.candidates.get(String(line.candidate_id))!.locked_at = null;
      return { candidateId: String(line.candidate_id), lineId: input.lineId, ok: true };
    }),
  };
  return deps as unknown as DecideDeductionDisputeDeps;
}

const SUPER_ADMIN = { hrId: "B-10", loginId: "b-10", role: "Super Admin" } as unknown as AccessContext;

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  assert.fail("the decision was expected to be refused");
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
}

async function runBehaviour() {
  // ── (a) A FAILURE AFTER THE FIRST WRITE PUTS EVERYTHING BACK ──────────────────────────────────
  // Accept on a pushed, approved deduction in a PAID month: line off, decision, refund recommended,
  // then the events. Each step in turn fails; every table must end byte-equal to where it began.
  for (const failAt of ["recordDecision", "recommendDisputeRefund", "recordEvents"] as const) {
    const w = world({ monthState: "paid", pushed: true });
    const before = tables(w);
    const error = await refusal(
      decideDeductionDispute(SUPER_ADMIN, { candidateId: CANDIDATE_ID, note: "", outcome: "accept" }, fakeDeps(w, { failAt })),
    );
    assert.ok(w.writes.length > 0, `the ${failAt} run must have written something before it failed, or it tests nothing`);
    assert.match(error.message, /put back/, `a failure at ${failAt} after the first write says everything was put back`);
    assert.equal(statusOf(error), 409, "…and is a Conflict, not a server error");
    assert.deepEqual(
      tables(w),
      before,
      `F-PAY-005: a failure at ${failAt} leaves the line, the decision, the lock, the refunds and the timeline exactly as they were`,
    );
    assert.ok(!w.events.some((event) => event.event_type === "decided"), "and no 'decided' event exists");
    assert.equal(w.claims.size, 0, "the claim is released once the undo is done, so the reviewer can decide again");
    assert.equal(w.notified, 0, "nobody is told about a decision that did not happen");
  }

  // Reduce on an undecided-by-HR deduction would push; a failed push of the smaller figure is undone too.
  {
    const w = world({ monthState: "open", pushed: true });
    const before = tables(w);
    await refusal(
      decideDeductionDispute(
        SUPER_ADMIN,
        { candidateId: CANDIDATE_ID, note: "one day only", outcome: "reduce", reducedValue: 1 },
        fakeDeps(w, { failAt: "pushDeduction" }),
      ),
    );
    assert.deepEqual(tables(w), before, "a reduce whose re-push fails is undone: the old line is live again at the old figure");
  }

  // The same accept with nothing failing does land — so the runs above failed for the injected reason.
  {
    const w = world({ monthState: "paid", pushed: true });
    const result = await decideDeductionDispute(SUPER_ADMIN, { candidateId: CANDIDATE_ID, note: "", outcome: "accept" }, fakeDeps(w));
    assert.equal(result.chargedAmount, 0, "accepted: nothing charged");
    assert.equal(w.decisions.get(CANDIDATE_ID)?.decision_status, "Do Not Take Action");
    assert.deepEqual(
      w.events.map((event) => event.event_type),
      ["refund_recommended", "decided"],
      "the refund event and the decided event land together, as the last write",
    );
    assert.equal(w.claims.size, 0, "a completed decision releases its claim");
    assert.equal(w.notified, 1, "the employee is told once");
  }

  // Where even the undo fails, the case reads "needs attention" — never open, never decided.
  {
    const w = world({ monthState: "paid", pushed: true });
    const error = await refusal(
      decideDeductionDispute(
        SUPER_ADMIN,
        { candidateId: CANDIDATE_ID, note: "", outcome: "accept" },
        fakeDeps(w, { failAt: "recommendDisputeRefund", restoreFails: true }),
      ),
    );
    assert.match(error.message, /could NOT be put back/, "the reviewer is told the undo failed");
    assert.match(error.message, /needs attention/, "…and what the case now says");
    const events = w.events.map(toEvent);
    assert.deepEqual(events.map((event) => event.eventType), ["decision_interrupted"], "the marker is the one event written");
    assert.equal(
      deriveDisputeCaseState({ decided: false, events, messages: [], openedAt: "2026-11-01T00:00:00.000Z" }),
      "needs_attention",
      "the case reads Needs attention, not Waiting for reviewer",
    );
    assert.equal(w.claims.size, 0, "the claim is released so the reviewer can decide it again once checked");
  }

  // ── (b) TWO DECIDES OF ONE CASE: EXACTLY ONE PROCEEDS ────────────────────────────────────────
  {
    const w = world({ monthState: "paid", pushed: true });
    // Another window holds the claim right now.
    w.claims.set(`deduction:${CANDIDATE_ID}`, { claimedAt: "2026-11-13T09:59:00.000Z", lapseAt: Date.now() + 60_000, snapshot: null, token: "other" });
    const before = tables(w);
    let captured = false;
    const deps = fakeDeps(w);
    const capture = deps.capture;
    deps.capture = async (id) => {
      captured = true;
      return capture(id);
    };
    const error = await refusal(decideDeductionDispute(SUPER_ADMIN, { candidateId: CANDIDATE_ID, note: "", outcome: "accept" }, deps));
    assert.equal(statusOf(error), 409, "a decide that meets a live claim is a Conflict");
    assert.match(error.message, /being decided right now/, "…that says someone is deciding it now");
    assert.deepEqual(w.writes, [], "and it writes NOTHING — not the line, not the decision, not a refund, not an event");
    assert.equal(captured, false, "it never even reads the before-state");
    assert.deepEqual(tables(w), before, "every table is untouched");
    assert.equal(w.claims.get(`deduction:${CANDIDATE_ID}`)?.token, "other", "and the other window's claim is not released by the refused one");
  }
  {
    // Truly at once: both pass the cheap read gate, the claim lets exactly one through.
    const w = world({ monthState: "paid", pushed: true });
    const deps = fakeDeps(w);
    const settled = await Promise.allSettled([
      decideDeductionDispute(SUPER_ADMIN, { candidateId: CANDIDATE_ID, note: "", outcome: "accept" }, deps),
      decideDeductionDispute(SUPER_ADMIN, { candidateId: CANDIDATE_ID, note: "", outcome: "accept" }, deps),
    ]);
    assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1, "exactly one of two simultaneous decides proceeds");
    const rejected = settled.find((entry) => entry.status === "rejected") as PromiseRejectedResult | undefined;
    assert.equal(statusOf(rejected?.reason), 409, "the other is refused with a Conflict");
    assert.equal(w.events.filter((event) => event.event_type === "decided").length, 1, "one decided event, never two");
    assert.equal(w.refunds.length, 1, "one refund recommended, never one stacked on another");
    assert.equal(w.writes.filter((name) => name === "withdrawDeduction").length, 1, "the line comes off once");
  }
  {
    // "Already decided" is asked again UNDER the claim: a decision that landed after the cheap read is seen.
    const w = world({ monthState: "open", pushed: true });
    const deps = fakeDeps(w);
    const claim = deps.claim;
    deps.claim = async (input) => {
      appendEvents(w, [{ actorHrId: "B-10", actorRole: "Super Admin", eventType: "decided", kind: "deduction", ref: CANDIDATE_ID }]);
      return claim(input);
    };
    const before = tables(w);
    const error = await refusal(decideDeductionDispute(SUPER_ADMIN, { candidateId: CANDIDATE_ID, note: "", outcome: "accept" }, deps));
    assert.match(error.message, /already decided/, "the re-check under the claim refuses a case decided a moment earlier");
    assert.deepEqual(w.writes, [], "…before it writes anything");
    assert.deepEqual({ ...tables(w), events: [] }, { ...before, events: [] }, "no line, decision, lock or refund changed");
    assert.equal(w.events.length, 1, "the only event is the other decision’s own");
  }
}

// ─────────────────────────────────────────────── recordDecision against an in-memory PostgREST

type Captured = { method: string; table: string; params: URLSearchParams; body: unknown };

async function withFakePostgrest(
  tablesIn: Record<string, Row[]>,
  body: (requests: Captured[]) => Promise<void>,
): Promise<void> {
  const requests: Captured[] = [];
  const realFetch = globalThis.fetch;
  const realUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const realKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54398";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in-key-never-sent";
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" }, status });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const marker = "/rest/v1/";
    const table = url.pathname.includes(marker) ? url.pathname.slice(url.pathname.indexOf(marker) + marker.length) : url.pathname;
    const parsed: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ body: parsed, method, params: url.searchParams, table });
    const wantsObject = String(new Headers(init?.headers).get("accept") ?? "").includes("pgrst.object");
    const rows = tablesIn[table];
    if (!rows) return json(wantsObject ? null : [], method === "GET" ? 200 : 201);
    // eq filters only — all recordDecision sends.
    const filters = [...url.searchParams.entries()].filter(([key, value]) => key !== "select" && key !== "on_conflict" && value.startsWith("eq."));
    const matches = rows.filter((row) => filters.every(([key, value]) => String(row[key]) === value.slice(3)));
    if (method === "GET") {
      if (wantsObject) return matches[0] ? json(matches[0]) : json(null);
      return json(matches);
    }
    if (method === "PATCH") {
      for (const row of matches) Object.assign(row, parsed as Row, { updated_at: "2026-11-13T10:00:09.123456+00:00" });
      return json(wantsObject ? matches[0] ?? null : matches);
    }
    if (method === "POST") {
      const incoming = (Array.isArray(parsed) ? parsed : [parsed]) as Row[];
      const prefer = String(new Headers(init?.headers).get("prefer") ?? "");
      const upsert = prefer.includes("resolution=merge-duplicates");
      for (const row of incoming) {
        const existing = rows.find((current) => current.candidate_id === row.candidate_id);
        if (existing && !upsert) return json({ code: "23505", details: null, hint: null, message: "duplicate key value violates unique constraint" }, 409);
        if (existing) Object.assign(existing, row);
        else rows.push({ ...row, created_at: "2026-11-13T10:00:00+00:00", id: `dec-${rows.length + 1}`, updated_at: "2026-11-13T10:00:00+00:00" });
      }
      return json(wantsObject ? rows[rows.length - 1] : incoming, 201);
    }
    return json(null, 200);
  }) as typeof fetch;
  try {
    await body(requests);
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = realUrl;
    if (realKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = realKey;
  }
}

const SEEN = "2026-11-13T09:00:00.654321+00:00";

function decisionTables(): Record<string, Row[]> {
  return {
    deductions_candidates: [
      {
        category: "dsm_no_record",
        dates: ["2026-10-05", "2026-10-06"],
        employee_hr_id: "B-77",
        employee_hr_id_compact: "b77",
        estimated_amount: 600,
        id: "cand-9",
        locked_at: null,
        month_key: "2026-10",
        raw_value: 2,
        unit: "days",
      },
    ],
    deductions_decisions: [
      {
        actor_role_at_decision: "Super Admin",
        applied_amount: null,
        applied_dates: null,
        applied_value: null,
        candidate_id: "cand-9",
        created_at: "2026-11-01T00:00:00+00:00",
        decided_at: null,
        decided_by: null,
        decision_reason: "",
        decision_status: "Pending",
        hr_note: "",
        id: "dec-1",
        updated_at: SEEN,
      },
    ],
  };
}

const ACTOR = { hrId: "B-10", loginId: "b-10", role: "Super Admin" } as const;

async function runCompareAndSet() {
  // (c) A stale revision: somebody else changed the decision after the screen read it.
  {
    const db = decisionTables();
    db.deductions_decisions[0].updated_at = "2026-11-13T09:30:00.000001+00:00"; // moved since SEEN
    const before = clone(db);
    await withFakePostgrest(db, async (requests) => {
      await assert.rejects(
        recordDecision({
          actor: ACTOR,
          candidateId: "cand-9",
          decisionReason: "",
          decisionStatus: "Do Not Take Action",
          expectedUpdatedAt: SEEN,
        }),
        (error: Error) => error.message === STALE_DECISION_CONFLICT,
        "F-PAY-004: a save over a decision that moved since the screen read it is a Conflict",
      );
      const writes = requests.filter((request) => request.table === "deductions_decisions" && request.method !== "GET");
      assert.equal(writes.length, 1, "exactly one write was attempted");
      assert.equal(writes[0].method, "PATCH", "…an UPDATE, never an upsert that would land regardless");
      assert.equal(writes[0].params.get("candidate_id"), "eq.cand-9");
      assert.equal(
        writes[0].params.get("updated_at"),
        `eq.${SEEN}`,
        "the revision the reviewer saw is IN the write's own WHERE — a compare-and-set, not a read then a write",
      );
      assert.ok(
        !requests.some((request) => request.table === "audit_logs" || request.table === "admin_audit_logs"),
        "no audit row for a save that did not happen",
      );
    });
    assert.deepEqual(db, before, "and nothing was written: the decision is exactly as the other person left it");
  }

  // The revision the screen saw is current: the write lands, through the same conditional UPDATE.
  {
    const db = decisionTables();
    await withFakePostgrest(db, async () => {
      const saved = await recordDecision({
        actor: ACTOR,
        candidateId: "cand-9",
        decisionReason: "",
        decisionStatus: "Do Not Take Action",
        expectedUpdatedAt: SEEN,
      });
      assert.equal(saved.decisionStatus, "Do Not Take Action", "a current revision saves");
    });
    assert.equal(db.deductions_decisions[0].decision_status, "Do Not Take Action", "and the row holds it");
  }

  // The screen saw NO decision row, and one has appeared since: the insert is refused, nothing overwritten.
  {
    const db = decisionTables();
    const before = clone(db);
    await withFakePostgrest(db, async () => {
      await assert.rejects(
        recordDecision({ actor: ACTOR, candidateId: "cand-9", decisionReason: "", decisionStatus: "Do Not Take Action", expectedUpdatedAt: null }),
        (error: Error) => error.message === STALE_DECISION_CONFLICT,
        "a decision written since the screen read 'none' is not overwritten",
      );
    });
    assert.deepEqual(db, before, "nothing was written");
  }
}

// ──────────────────────────────────────────────────────────────────────────────── source pins

const CLAIM_MIGRATION = "supabase/migrations/20261113162318_dispute_decision_claim_and_undo.sql";
const LOCK_MIGRATION = "supabase/migrations/20261113162321_deduction_decision_refuses_locked_candidate.sql";

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const open = sql.indexOf("as $$", start);
  const close = sql.indexOf("$$;", open + 5);
  assert.ok(open > start && close > open, `${name} has a body`);
  return sql.slice(start, close + 3);
}

function runSourcePins() {
  const claimSql = stripSqlComments(readFileSync(CLAIM_MIGRATION, "utf8")).toLowerCase();
  const lockSql = stripSqlComments(readFileSync(LOCK_MIGRATION, "utf8")).toLowerCase();

  // The claim: one atomic statement, a lapse the TypeScript agrees with, service-role only.
  const claim = functionBody(claimSql, "phx_claim_dispute_case_decision");
  assert.ok(
    claim.includes("on conflict (case_kind, case_ref) do nothing") && claim.includes("for update"),
    "the claim is taken in one insert, and a lapsed one is taken over under a row lock — never a read then a write",
  );
  assert.ok(claim.includes("lapse_at > now()"), "a live claim refuses the second decide");
  const lapses = [...claim.matchAll(/interval '(\d+) minutes'/g)].map((match) => Number(match[1]));
  assert.ok(lapses.length > 0 && lapses.every((minutes) => minutes === DISPUTE_DECISION_CLAIM_LAPSE_MINUTES), "the SQL lapse and decision-claim.ts agree");
  for (const signature of [
    "phx_claim_dispute_case_decision(text, text, text)",
    "phx_capture_deduction_dispute_state(uuid)",
    "phx_restore_deduction_dispute_state(jsonb, text)",
  ]) {
    assert.ok(
      claimSql.includes(`revoke execute on function public.${signature} from public, anon, authenticated;`) &&
        claimSql.includes(`grant execute on function public.${signature} to service_role;`),
      `${signature} is revoked from every browser role and granted to the service role alone`,
    );
  }
  assert.ok(
    claimSql.includes("alter table public.dispute_case_decision_claims enable row level security") &&
      claimSql.includes("revoke all on table public.dispute_case_decision_claims from public, anon, authenticated"),
    "the claims table is server-only",
  );

  // The undo writes decisions through the table, so the history trigger keeps firing — no trigger is disabled.
  const restore = functionBody(claimSql, "phx_restore_deduction_dispute_state");
  assert.ok(
    restore.includes("update public.deductions_decisions") && restore.includes("insert into public.deductions_decisions"),
    "the undo writes the decision back through deductions_decisions, where phx_deductions_decisions_history records it",
  );
  assert.ok(
    !/session_replication_role|disable trigger/.test(claimSql + lockSql),
    "nothing here switches a trigger off",
  );
  const unlock = restore.indexOf("set locked_at = null");
  const decisionWrite = restore.indexOf("update public.deductions_decisions");
  const relock = restore.indexOf("set locked_at = nullif(p_snapshot->>'lockedat'");
  assert.ok(
    unlock >= 0 && unlock < decisionWrite && decisionWrite < relock,
    "the undo takes the lock off, writes the decision back, then restores the lock — the lock trigger is obeyed, not bypassed",
  );
  assert.ok(claimSql.includes("'decision_interrupted'::text"), "the timeline may hold the needs-attention marker");

  // F-PAY-004: the database refuses a decision on a locked candidate.
  const guard = functionBody(lockSql, "phx_deductions_decisions_refuse_locked");
  assert.ok(
    lockSql.includes("before insert or update on public.deductions_decisions"),
    "the guard runs before every insert and update of a decision",
  );
  assert.ok(guard.includes("for share"), "it reads the lock under a row lock, so a publication cannot slip between");
  assert.ok(
    guard.includes("locked by a publication") && guard.includes("errcode = '55000'"),
    "a locked candidate's decision is refused with the code recordDecision turns into a Conflict",
  );
  assert.ok(
    guard.includes("recovery.restore_preimages") && guard.includes("source_table = 'deductions_decisions'"),
    "the one exemption is the owner's whole-table restore, recognised by its own pre-image",
  );
  assert.ok(
    lockSql.includes("revoke execute on function public.phx_deductions_decisions_refuse_locked() from public, anon, authenticated;") &&
      lockSql.includes("grant execute on function public.phx_deductions_decisions_refuse_locked() to service_role;"),
    "the security-definer trigger function is not callable by a browser role",
  );

  // The TypeScript side.
  const decide = stripComments(readFileSync("src/lib/dispute-center/deduction.ts", "utf8"));
  const claimAt = decide.indexOf("await deps.claim(");
  for (const firstWrite of ["deps.withdrawDeduction(", "deps.recordDecision(", "deps.pushDeduction(", "deps.recommendDisputeRefund(", "deps.cancelLiveRefund("]) {
    assert.ok(claimAt >= 0 && decide.indexOf(firstWrite) > claimAt, `the claim is taken before ${firstWrite}`);
  }
  assert.ok(
    decide.includes("deferEvents: deferredEvents") && decide.includes("...deferredEvents,") && decide.includes('eventType: "decided"'),
    "the refund events and the decided event are written together, as the decision's last write",
  );
  assert.ok(!/recordCaseEvent\(\{[^}]*eventType: "decided"/.test(decide), "the decided event is no longer a write of its own");

  const service = stripComments(readFileSync("src/lib/deductions/service.ts", "utf8"));
  assert.ok(
    service.includes('.eq("updated_at", expectedUpdatedAt)') && service.includes("writeDecisionRow(supabase, payload, input.expectedUpdatedAt)"),
    "recordDecision's expected revision is a condition of the write itself",
  );
  assert.ok(service.includes("isPublicationLockRefusal(error)"), "the database's lock refusal reaches the reviewer as a Conflict");
  const route = stripComments(readFileSync("app/api/admin/deductions/decisions/route.ts", "utf8"));
  assert.ok(route.includes("expectedUpdatedAt:"), "the Decide route passes the revision the screen read");
}

export async function runDisputeAndDeductionAtomicTests() {
  await runBehaviour();
  await runCompareAndSet();
  runSourcePins();
}
