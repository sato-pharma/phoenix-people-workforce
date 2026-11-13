import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  HIRE_HANDOFF_MAX_ATTEMPTS,
  hireHandoffStepProblems,
  hireHandoffSteps,
  loginProvisioningFailure,
  runHandoffStep,
  sanitizeHandoffContext,
  setHireHandoffStoreForTests,
  startHireHandoff,
  type HireHandoffRow,
  type HireHandoffStatus,
  type HireHandoffStep,
  type HireHandoffStore,
  type HireHandoffWrite,
} from "../src/lib/employees/hire-handoff.ts";
import {
  HIRE_HANDOFF_STALE_PENDING_MS,
  hireHandoffBackoffMs,
  isHireHandoffDue,
  retryHireHandoffNow,
  runHireHandoffReconciler,
  type HireHandoffLease,
  type HireHandoffRetryDeps,
} from "../src/lib/employees/hire-handoff-reconciler.ts";
import { hireHandoffItems } from "../src/lib/needs-you/hire-handoff-items.ts";
import { needsYouDestinations, needsYouSourceIds, needsYouSourceLabels } from "../src/lib/needs-you/types.ts";
import { findNewHiresWithoutLogin } from "../src/lib/reconciliation/new-hires-without-login.ts";

/**
 * THE HIRE HAND-OFF IS COMPLETE OR SELF-REPAIRING (enterprise audit 2026-11-13, REC-027).
 *
 * After a new employee row is written, both hiring doors — HR's Add Employee and the candidate's
 * offer joining form — run follow-up steps (offer letter linked, candidate hired, login, CV, mailbox
 * task, offer stamped accepted, the joining form's audit row). Each one only LOGGED its failure, so a
 * joiner with no login was found by a person noticing. The bar: a forced failure at each step leaves
 * a visible, retryable item and no silent gap — and the door's reply does not change.
 *
 * Fakes only: the ledger store, the lease and every step function are injected. Nothing here reaches
 * a database, a mailbox, a login or a network.
 */

// ── The fakes ──────────────────────────────────────────────────────────────────────────────────

type FakeStore = HireHandoffStore & {
  rows: Map<string, HireHandoffRow>;
  writes: HireHandoffWrite[];
  failWrites: boolean;
  seed(row: Partial<HireHandoffRow> & { employeeHrId: string; step: HireHandoffStep }): void;
};

function fakeStore(): FakeStore {
  const rows = new Map<string, HireHandoffRow>();
  const writes: HireHandoffWrite[] = [];
  const id = (hrId: string, step: string) => `${hrId.toLowerCase()}|${step}`;
  const store: FakeStore = {
    failWrites: false,
    rows,
    writes,
    seed(row) {
      rows.set(id(row.employeeHrId, row.step), {
        attempts: 1,
        context: {},
        createdAt: "2026-11-01T08:00:00.000Z",
        lastError: "it failed",
        source: "add_employee",
        status: "failed",
        updatedAt: "2026-11-01T08:00:00.000Z",
        ...row,
      });
    },
    async write(row) {
      if (store.failWrites) throw new Error("ledger down");
      writes.push(row);
      const key = id(row.employeeHrId, row.step);
      const before = rows.get(key);
      const now = new Date().toISOString();
      rows.set(key, {
        attempts: row.attempts,
        context: row.context ?? before?.context ?? {},
        createdAt: before?.createdAt ?? now,
        employeeHrId: row.employeeHrId,
        lastError: row.lastError,
        source: row.source,
        status: row.status,
        step: row.step,
        updatedAt: now,
      });
    },
    async get(employeeHrId, step) {
      return rows.get(id(employeeHrId, step)) ?? null;
    },
    async listByStatus(statuses, limit) {
      return [...rows.values()]
        .filter((row) => statuses.includes(row.status))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .slice(0, limit);
    },
    async hrIdsWithStep(step, statuses) {
      return [...rows.values()].filter((row) => row.step === step && statuses.includes(row.status)).map((row) => row.employeeHrId);
    },
  };
  return store;
}

type Calls = Record<string, unknown[]>;

function fakeDeps(overrides: Partial<HireHandoffRetryDeps> = {}): { calls: Calls; deps: HireHandoffRetryDeps } {
  const calls: Calls = {};
  const record = (name: string, input: unknown) => {
    (calls[name] ??= []).push(input);
  };
  const deps: HireHandoffRetryDeps = {
    async acceptanceAuditExists(offerId, hrId) {
      record("acceptanceAuditExists", { hrId, offerId });
      return false;
    },
    async attachEmployeeCvOnCreate(input) {
      record("attachEmployeeCvOnCreate", input);
      return { attached: true, fileName: "cv.pdf", source: null, warnings: [] };
    },
    async employeeHasCv(hrId) {
      record("employeeHasCv", hrId);
      return false;
    },
    async insertAcceptanceAudit(row) {
      record("insertAcceptanceAudit", row);
    },
    async loginExistsFor(hrId) {
      record("loginExistsFor", hrId);
      return false;
    },
    async openAndAnnounceNewHireMailboxes(input) {
      record("openAndAnnounceNewHireMailboxes", input);
      return { announced: 1, opened: 1, recipients: 1, skipped: 0, warnings: [] };
    },
    async provisionNewHireAccess(input) {
      record("provisionNewHireAccess", input);
      return { created: 1, failed: 0, results: [{ hrId: "B-900", message: "created", status: "created" }], skipped: 0 } as never;
    },
    async readOffer(offerId) {
      record("readOffer", offerId);
      return { employeeHrId: null, status: "sent" };
    },
    async recordHireFromCandidate(input) {
      record("recordHireFromCandidate", input);
      return { candidate: "hired", requisitionsClosed: 1 } as never;
    },
    async recordHireFromOfferLetter(input) {
      record("recordHireFromOfferLetter", input);
      return { candidate: "hired", letterLinked: true } as never;
    },
    async stampOfferAcceptedByJoiningForm(offerId, hire) {
      record("stampOfferAcceptedByJoiningForm", { hire, offerId });
      return {};
    },
    ...overrides,
  };
  return { calls, deps };
}

const heldLease = (): HireHandoffLease & { claimed: number; released: number } => {
  const lease = {
    claimed: 0,
    released: 0,
    async claim() {
      lease.claimed += 1;
      return true;
    },
    async release() {
      lease.released += 1;
    },
  };
  return lease;
};

function code(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}

function flat(file: string): string {
  return code(file).replace(/\s+/g, " ");
}

function statusOf(store: FakeStore, hrId: string, step: HireHandoffStep): HireHandoffStatus | undefined {
  return store.rows.get(`${hrId.toLowerCase()}|${step}`)?.status;
}

export async function runHireHandoffStepsTests(): Promise<void> {
  try {
    await trackerTests();
    await retryTests();
    await reconcilerRunTests();
    doorTests();
    boardTests();
    reconciliationTests();
    wiringTests();
  } finally {
    setHireHandoffStoreForTests(null);
  }
}

// ── 1 · The ledger never changes a door's answer, and records every outcome ─────────────────────

async function trackerTests(): Promise<void> {
  const store = fakeStore();
  setHireHandoffStoreForTests(store);

  // A step that returns: pending, then done; the very same object comes back.
  const answer = { candidate: "hired", letterLinked: true };
  const tracker = startHireHandoff("B-900", "add_employee");
  const got = await tracker.run("offer_link", { offerId: "offer-1" }, async () => answer);
  await tracker.flush();
  assert.equal(got, answer, "the step's own result is returned unchanged — the door's reply cannot change");
  assert.deepEqual(store.writes.map((write) => write.status), ["pending", "done"], "pending is written first, then done");
  assert.equal(statusOf(store, "B-900", "offer_link"), "done");

  // A step that throws: the SAME error is re-thrown, after the failure is recorded.
  const boom = new Error("login service unreachable");
  await assert.rejects(
    () => tracker.run("login", { actorRole: "HR Operations" }, async () => {
      throw boom;
    }),
    (error) => error === boom,
    "a step that failed the request before still fails it, with its own error",
  );
  await tracker.flush();
  const login = store.rows.get("b-900|login");
  assert.equal(login?.status, "failed", "RED a thrown step leaves a FAILED row — a visible, retryable item");
  assert.equal(login?.lastError, "login service unreachable");
  assert.equal(login?.attempts, 1, "the door's own run is attempt 1");

  // A step that reports failure in its RESULT: recorded failed, result untouched.
  const mailbox = { announced: 0, opened: 0, recipients: 0, skipped: 0, warnings: ["queue missing"] };
  const back = await tracker.run("mailbox_task", {}, async () => mailbox, {
    failureOf: (result) => (result.opened > 0 ? null : result.warnings.join(" ")),
  });
  await tracker.flush();
  assert.equal(back, mailbox, "a returned failure is still returned as it was");
  assert.equal(statusOf(store, "B-900", "mailbox_task"), "failed", "RED a result that says it failed is a FAILED row");

  // A dead ledger never breaks the hire.
  store.failWrites = true;
  const stillAnswered = await tracker.run("cv", {}, async () => "attached");
  await tracker.flush();
  assert.equal(stillAnswered, "attached", "a ledger that cannot be written never changes or fails the step");
  store.failWrites = false;

  // `record: false` — a step with nothing to hand off writes nothing.
  const before = store.writes.length;
  await tracker.run("cv", {}, async () => null, { record: false });
  await tracker.flush();
  assert.equal(store.writes.length, before, "a hire with no CV given leaves no CV row");

  // No HR id (an edit, not a hire): nothing is recorded.
  const edit = startHireHandoff(null, "add_employee");
  await edit.run("login", {}, async () => "ok");
  await edit.flush();
  assert.equal(store.writes.length, before, "an edit has no hire to hand off");

  // Never a password, token, salary or national id in the ledger.
  const clean = sanitizeHandoffContext({
    nationalId: "29001011234567",
    netSalary: 12000,
    offerId: "offer-1",
    password: "hunter2",
    seated: true,
    token: "abc",
  });
  assert.deepEqual(clean, { offerId: "offer-1", seated: true }, "only the whitelisted ids survive");

  // The login's "already exists" answer is DONE, not a failure.
  assert.equal(
    loginProvisioningFailure({ results: [{ message: "An account already exists for this HR ID.", status: "failed" }] }),
    null,
    "a login that already exists is what the step was for",
  );
  assert.ok(loginProvisioningFailure({ results: [{ message: "rank refused", status: "failed" }] }), "any other failed login is a failure");

  // Every step has a plain-English sentence for the board.
  for (const step of hireHandoffSteps) assert.ok(hireHandoffStepProblems[step].length > 10, `${step} says what went wrong in words`);
}

// ── 2 · Each step's retry is idempotent, and gives up visibly ───────────────────────────────────

async function retryTests(): Promise<void> {
  // Backoff: 15 min, 30 min, 1 h, 2 h, then capped at 6 h.
  assert.equal(hireHandoffBackoffMs(1), 15 * 60_000);
  assert.equal(hireHandoffBackoffMs(2), 30 * 60_000);
  assert.equal(hireHandoffBackoffMs(4), 2 * 3_600_000);
  assert.equal(hireHandoffBackoffMs(9), 6 * 3_600_000, "never more than six hours between attempts");

  const now = new Date("2026-11-13T12:00:00.000Z");
  const row = (status: HireHandoffStatus, attempts: number, minutesAgo: number): HireHandoffRow => ({
    attempts,
    context: {},
    createdAt: "",
    employeeHrId: "B-1",
    lastError: null,
    source: "add_employee",
    status,
    step: "login",
    updatedAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
  });
  assert.equal(isHireHandoffDue(row("failed", 1, 10), now), false, "a fresh failure waits its backoff");
  assert.equal(isHireHandoffDue(row("failed", 1, 16), now), true);
  assert.equal(isHireHandoffDue(row("pending", 1, 5), now), false, "a pending step may still be running in its door");
  assert.equal(isHireHandoffDue(row("pending", 1, HIRE_HANDOFF_STALE_PENDING_MS / 60_000 + 1), now), true, "RED a door that crashed mid-way is picked up");
  assert.equal(isHireHandoffDue(row("gave_up", 5, 999), now), false, "a given-up step is the board's, not the job's");
  assert.equal(isHireHandoffDue(row("done", 1, 999), now), false);

  const retryOne = async (
    seed: Partial<HireHandoffRow> & { step: HireHandoffStep },
    overrides: Partial<HireHandoffRetryDeps> = {},
  ) => {
    const store = fakeStore();
    setHireHandoffStoreForTests(store);
    store.seed({ employeeHrId: "B-900", ...seed });
    const { calls, deps } = fakeDeps(overrides);
    const result = await retryHireHandoffNow({ actor: null, hrId: "B-900", step: seed.step }, deps);
    return { calls, result, store };
  };

  // login — already there is DONE without creating anything.
  {
    const { calls, store } = await retryOne({ step: "login", context: { actorRole: "HR Operations" } }, {
      loginExistsFor: async () => true,
    });
    assert.equal(statusOf(store, "B-900", "login"), "done", "a login that exists is done");
    assert.equal(calls.provisionNewHireAccess, undefined, "RED and no second login is ever attempted");
  }
  // login — the create-only door answering "already exists" is DONE.
  {
    const { store } = await retryOne({ step: "login", context: { actorRole: "HR Operations" } }, {
      provisionNewHireAccess: (async () => ({
        created: 0,
        failed: 1,
        results: [{ hrId: "B-900", message: "An account already exists for this HR ID.", status: "failed" }],
        skipped: 0,
      })) as never,
    });
    assert.equal(statusOf(store, "B-900", "login"), "done");
  }
  // login — the retry replays the door's own authority, and the presser's when pressed.
  {
    const store = fakeStore();
    setHireHandoffStoreForTests(store);
    store.seed({ context: { actorRole: "HR Operations" }, employeeHrId: "B-900", step: "login" });
    const { calls, deps } = fakeDeps();
    await retryHireHandoffNow({ actor: { loginId: "omar", role: "Super Admin" }, hrId: "B-900", step: "login" }, deps);
    assert.deepEqual((calls.provisionNewHireAccess?.[0] as { actor: unknown }).actor, { loginId: "omar", role: "Super Admin" }, "the retry route uses the presser's seat");
  }
  // login — a failure counts an attempt; the fifth gives up.
  {
    const failing = { provisionNewHireAccess: (async () => { throw new Error("auth down"); }) as never };
    const { store } = await retryOne({ attempts: 2, step: "login" }, failing);
    const after = store.rows.get("b-900|login");
    assert.equal(after?.status, "failed");
    assert.equal(after?.attempts, 3, "every attempt is counted");
    assert.equal(after?.lastError, "auth down");
    const last = await retryOne({ attempts: HIRE_HANDOFF_MAX_ATTEMPTS - 1, step: "login" }, failing);
    assert.equal(statusOf(last.store, "B-900", "login"), "gave_up", "RED the fifth failure gives up — visibly, on the board");
  }

  // offer_link / candidate_hired — the same idempotent sync; "error" is a failure.
  {
    const { calls, store } = await retryOne({ context: { offerId: "offer-7" }, step: "offer_link" });
    assert.equal(statusOf(store, "B-900", "offer_link"), "done");
    assert.deepEqual(calls.recordHireFromOfferLetter?.[0], { actorHrId: null, hrId: "B-900", offerId: "offer-7" });
    const bad = await retryOne({ context: { offerId: "offer-7" }, step: "offer_link" }, {
      recordHireFromOfferLetter: (async () => ({ candidate: "error", letterLinked: false })) as never,
    });
    assert.equal(statusOf(bad.store, "B-900", "offer_link"), "failed");
    const none = await retryOne({ context: {}, step: "candidate_hired" });
    assert.equal(statusOf(none.store, "B-900", "candidate_hired"), "gave_up", "nothing recorded to retry with is given up at once");
    const hired = await retryOne({ context: { candidateId: "cand-1" }, step: "candidate_hired" });
    assert.equal(statusOf(hired.store, "B-900", "candidate_hired"), "done");
  }

  // cv — never overwrites; a cleared staged file gives up and says so.
  {
    const has = await retryOne({ context: { cvDraftId: "draft-1" }, step: "cv" }, { employeeHasCv: async () => true });
    assert.equal(statusOf(has.store, "B-900", "cv"), "done");
    assert.equal(has.calls.attachEmployeeCvOnCreate, undefined, "RED a CV on the record is never replaced by a retry");
    const gone = await retryOne({ context: { cvDraftId: "draft-1" }, step: "cv" }, {
      attachEmployeeCvOnCreate: (async () => ({
        attached: false,
        fileName: null,
        source: null,
        warnings: ["The chosen CV could not be found when the employee was saved, so nothing was attached."],
      })) as never,
    });
    assert.equal(statusOf(gone.store, "B-900", "cv"), "gave_up");
    assert.match(String(gone.store.rows.get("b-900|cv")?.lastError), /cleared after a day/);
  }

  // mailbox_task — the same open, named as the reconciler; nothing opened is a failure.
  {
    const { calls, store } = await retryOne({ context: { mailboxSource: "manual_add" }, step: "mailbox_task" });
    assert.equal(statusOf(store, "B-900", "mailbox_task"), "done");
    assert.deepEqual(calls.openAndAnnounceNewHireMailboxes?.[0], { actorId: "hire-handoff", hrIds: ["B-900"], source: "manual_add" });
  }

  // offer_stamp — never overwrites a letter that names somebody else, or that moved on.
  {
    const other = await retryOne({ context: { offerId: "offer-7" }, source: "joining_form", step: "offer_stamp" }, {
      readOffer: async () => ({ employeeHrId: "B-123", status: "accepted" }),
    });
    assert.equal(statusOf(other.store, "B-900", "offer_stamp"), "gave_up", "RED a letter naming another employee is left alone");
    assert.equal(other.calls.stampOfferAcceptedByJoiningForm, undefined);
    const declined = await retryOne({ context: { offerId: "offer-7" }, source: "joining_form", step: "offer_stamp" }, {
      readOffer: async () => ({ employeeHrId: null, status: "declined" }),
    });
    assert.equal(statusOf(declined.store, "B-900", "offer_stamp"), "gave_up");
    const already = await retryOne({ context: { offerId: "offer-7" }, source: "joining_form", step: "offer_stamp" }, {
      readOffer: async () => ({ employeeHrId: "b-900", status: "accepted" }),
    });
    assert.equal(statusOf(already.store, "B-900", "offer_stamp"), "done", "a letter already naming him is done");
    assert.equal(already.calls.stampOfferAcceptedByJoiningForm, undefined, "and is not stamped twice");
    const open = await retryOne({ context: { offerId: "offer-7", seated: true, workEmail: "a.b@satopharma.com" }, source: "joining_form", step: "offer_stamp" });
    assert.equal(open.calls.stampOfferAcceptedByJoiningForm?.length, 1, "an unlinked sent letter is stamped once");
    assert.equal(statusOf(open.store, "B-900", "offer_link"), "done", "and the letter link the door runs next is run and recorded too");
  }

  // acceptance_audit — written once, never twice.
  {
    const exists = await retryOne({ context: { offerId: "offer-7" }, source: "joining_form", step: "acceptance_audit" }, {
      acceptanceAuditExists: async () => true,
    });
    assert.equal(statusOf(exists.store, "B-900", "acceptance_audit"), "done");
    assert.equal(exists.calls.insertAcceptanceAudit, undefined, "RED an audit row that exists is not written again");
    const missing = await retryOne({ context: { idPhotosFiled: true, offerId: "offer-7" }, source: "joining_form", step: "acceptance_audit" });
    assert.deepEqual(missing.calls.insertAcceptanceAudit, [{ employeeHrId: "B-900", idPhotosFiled: true, offerId: "offer-7" }]);
  }

  // The retry route's answers: nothing to retry, or already done.
  {
    const store = fakeStore();
    setHireHandoffStoreForTests(store);
    const { deps } = fakeDeps();
    assert.deepEqual(await retryHireHandoffNow({ actor: null, hrId: "B-1", step: "login" }, deps), { found: false });
    store.seed({ employeeHrId: "B-1", status: "done", step: "login" });
    assert.deepEqual(await retryHireHandoffNow({ actor: null, hrId: "B-1", step: "login" }, deps), { alreadyDone: true, found: true });
  }

  // runHandoffStep flushes before it returns.
  {
    const store = fakeStore();
    setHireHandoffStoreForTests(store);
    await runHandoffStep("B-2", "joining_form", "offer_link", {}, async () => ({ candidate: "none" }));
    assert.equal(statusOf(store, "B-2", "offer_link"), "done");
  }
}

// ── 3 · The hourly run: leased, bounded, due rows only ──────────────────────────────────────────

async function reconcilerRunTests(): Promise<void> {
  const now = new Date("2026-11-13T12:00:00.000Z");
  const longAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();

  // Another run holds the lease: nothing is touched.
  {
    const store = fakeStore();
    setHireHandoffStoreForTests(store);
    store.seed({ employeeHrId: "B-1", step: "login", updatedAt: longAgo });
    const { calls, deps } = fakeDeps();
    const result = await runHireHandoffReconciler({
      deps,
      lease: { claim: async () => false, release: async () => undefined },
      now: () => now,
    });
    assert.equal(result.ran, false, "a held lease means this run does nothing");
    assert.equal(Object.keys(calls).length, 0);
  }

  // Bounded per run, due rows only, and the lease is released.
  {
    const store = fakeStore();
    setHireHandoffStoreForTests(store);
    for (let index = 0; index < 5; index += 1) {
      store.seed({ context: { mailboxSource: "manual_add" }, employeeHrId: `B-${index}`, step: "mailbox_task", updatedAt: longAgo });
    }
    store.seed({ employeeHrId: "B-fresh", step: "login", updatedAt: new Date(now.getTime() - 60_000).toISOString() });
    store.seed({ employeeHrId: "B-given", status: "gave_up", step: "login", updatedAt: longAgo });
    const lease = heldLease();
    const { calls, deps } = fakeDeps();
    const result = await runHireHandoffReconciler({ deps, lease, limit: 3, now: () => now });
    assert.equal(result.ran, true);
    assert.equal(result.due, 3, "at most `limit` steps a run");
    assert.equal(result.done, 3);
    assert.equal(calls.openAndAnnounceNewHireMailboxes?.length, 3);
    assert.equal(calls.provisionNewHireAccess, undefined, "a step inside its backoff and a given-up step are not retried");
    assert.equal(lease.released, 1, "the lease is given back");
  }

  // A failed ledger read throws (the cron answers 500), and the lease is still released.
  {
    const store = fakeStore();
    store.listByStatus = async () => {
      throw new Error("ledger unreadable");
    };
    setHireHandoffStoreForTests(store);
    const lease = heldLease();
    await assert.rejects(() => runHireHandoffReconciler({ deps: fakeDeps().deps, lease, now: () => now }), /ledger unreadable/);
    assert.equal(lease.released, 1);
  }
}

// ── 4 · Both doors wrap every step, and keep their old reply ────────────────────────────────────

function doorTests(): void {
  const hr = flat("app/api/employees/route.ts");
  assert.match(hr, /const handoff = startHireHandoff\(isNewEmployee \? newEmployeeHrId : null, "add_employee"\);/, "Add Employee starts a ledger for a NEW hire only");
  const hrWraps: Array<[HireHandoffStep, string]> = [
    ["offer_link", "recordHireFromOfferLetter("],
    ["candidate_hired", "recordHireFromCandidate("],
    ["login", "provisionNewHireAccess("],
    ["cv", "attachEmployeeCvOnCreate("],
    ["mailbox_task", "openAndAnnounceNewHireMailboxes("],
  ];
  for (const [step, call] of hrWraps) {
    const at = hr.indexOf(`handoff.run( "${step}"`) >= 0 ? hr.indexOf(`handoff.run( "${step}"`) : hr.indexOf(`handoff.run("${step}"`);
    assert.ok(at >= 0, `RED Add Employee records the ${step} step in the ledger`);
    const callAt = hr.indexOf(call, at);
    assert.ok(callAt > at && callAt - at < 400, `RED Add Employee's ${step} step runs ${call} inside its ledger wrap`);
  }
  assert.ok(
    !/handoff\.run\("login"[^;]*\.catch\(/.test(hr),
    "the login still fails the save exactly as before — the ledger never swallows it",
  );
  assert.match(
    hr,
    /afterResponse\("employee_notice:new_hire_followups", async \(\) => \{ await handoff\.run\("mailbox_task"[\s\S]*?await handoff\.flush\(\); \}\);/,
    "the mailbox step and the ledger flush run AFTER the reply",
  );
  assert.match(hr, /record: cvGiven,/, "a hire with no CV given leaves no CV row");

  const join = flat("src/lib/offers/joining-form-service.ts");
  assert.match(join, /const handoff = startHireHandoff\(hrId, "joining_form"\);/);
  const joinWraps: Array<[HireHandoffStep, string]> = [
    ["offer_stamp", "stampOfferAcceptedByJoiningForm("],
    ["acceptance_audit", 'db.from("offer_acceptances").insert('],
    ["login", "provisionNewHireAccess("],
    ["mailbox_task", "openAndAnnounceNewHireMailboxes("],
  ];
  for (const [step, call] of joinWraps) {
    const at = join.indexOf(`handoff.run("${step}"`);
    assert.ok(at >= 0, `RED the joining form records the ${step} step in the ledger`);
    const callAt = join.indexOf(call, at);
    assert.ok(callAt > at && callAt - at < 400, `RED the joining form's ${step} step runs ${call} inside its ledger wrap`);
  }
  assert.match(join, /if \(auditError\) throw new Error\(auditError\.message\);/, "RED the audit insert's own error is READ now — it was dropped unread");
  for (const event of ["offer_joining_form_stamp_failed", "offer_joining_form_audit_failed", "offer_joining_form_access_failed"]) {
    assert.ok(join.includes(event), `the joining form still only LOGS ${event} — he is never shown it`);
  }
  assert.ok(join.indexOf("await handoff.flush();") < join.indexOf("return { hrId, offerId: offer.id, ok: true,"), "the ledger lands before he is answered");
  assert.ok(!/recruitment/.test(join), "the offers module still never imports recruitment");

  const route = flat("app/api/public/offer-acceptance/[token]/route.ts");
  assert.match(
    route,
    /await runHandoffStep\(result\.hrId, "joining_form", "offer_link", \{ offerId \}, \(\) => recordHireFromOfferLetter\(/,
    "RED the joining form's letter link is recorded too",
  );

  // The ledger module stays out of recruitment, so the offers module may import it.
  const ledger = code("src/lib/employees/hire-handoff.ts");
  assert.ok(!/@\/lib\/recruitment|candidate_id|ats_candidates/.test(ledger), "hire-handoff.ts never reaches recruitment");
}

// ── 5 · The board names the person, says the step in English, and links to the record ─────────

function boardTests(): void {
  assert.ok((needsYouSourceIds as readonly string[]).includes("hire-handoff-gaps"));
  assert.equal(needsYouSourceLabels["hire-handoff-gaps"], "New hires whose hand-off did not finish");
  assert.deepEqual(needsYouDestinations["hire-handoff-gaps"], { href: "/employees", screen: "Employee Master" });

  const now = new Date("2026-11-13T12:00:00.000Z");
  const items = hireHandoffItems(
    [
      { attempts: 5, createdAt: "2026-11-10T08:00:00.000Z", hrId: "B-900", lastError: "auth down", name: "Mona Adel", problem: hireHandoffStepProblems.login, status: "gave_up" },
      { attempts: 2, createdAt: "2026-11-10T08:00:01.000Z", hrId: "b-900", lastError: null, name: "Mona Adel", problem: hireHandoffStepProblems.mailbox_task, status: "failed" },
      { attempts: 1, createdAt: "2026-11-12T08:00:00.000Z", hrId: "B-901", lastError: null, name: null, problem: hireHandoffStepProblems.cv, status: "failed" },
    ],
    now,
    HIRE_HANDOFF_MAX_ATTEMPTS,
  );
  assert.equal(items.length, 2, "one row per PERSON, however many steps");
  const mona = items[0];
  assert.equal(mona.label, "Mona Adel: the portal login was not created and the company mailbox task was not opened");
  assert.deepEqual(mona.people, ["Mona Adel"]);
  assert.ok(!/B-90/.test(`${mona.label} ${mona.note} ${mona.people.join(" ")}`), "RED names, never an HR id, anywhere he reads");
  assert.equal(mona.href, "/employees?edit=B-900", "linked to that person's own record");
  assert.match(String(mona.note), /gave up .* after 5 attempts/);
  assert.match(String(mona.note), /still trying .*attempt 2 of 5/);
  assert.equal(mona.lane, "yours");
  assert.equal(mona.kind, "flag");
  assert.equal(mona.count, null);
  assert.equal(mona.ageDays, 3);
  assert.equal(items[1].label.startsWith("A new employee: "), true, "an unreadable name is never replaced by an id");
  assert.deepEqual(hireHandoffItems([], now, HIRE_HANDOFF_MAX_ATTEMPTS), [], "a clean ledger is a true zero");

  const sources = flat("src/lib/needs-you/sources.ts");
  const adapter = sources.slice(sources.indexOf('id: "hire-handoff-gaps"'), sources.indexOf("const vendorGithub"));
  assert.match(adapter, /await assertPermission\(access, "employees", "create"\);/, "gated on the right that makes a hire");
  assert.ok(!/cost:/.test(adapter), "the light lane — no `cost`");
  assert.ok(!/retryHireHandoff|provisionNewHireAccess|\.insert\(|\.update\(/.test(adapter), "RED the board never acts");
  assert.match(sources, /organogramSeatDrift, hireHandoffGaps,/, "and it is registered");
}

// ── 6 · The net under the ledger: a recent hire with no login and nothing retrying one ──────────

function reconciliationTests(): void {
  const base = { active: true, hireDate: "2026-11-01", name: "Hire" };
  const missing = findNewHiresWithoutLogin({
    employees: [
      { ...base, hrId: "B-1", name: "Has Login" },
      { ...base, hrId: "B-2", name: "Being Retried" },
      { ...base, hrId: "B-3", name: "Nobody Trying" },
      { ...base, active: false, hrId: "B-4", name: "Not Active" },
      { ...base, hireDate: "2026-08-01", hrId: "B-5", name: "Hired Long Ago" },
      { ...base, hireDate: "2026-12-01", hrId: "B-6", name: "Starts Next Month" },
      { ...base, hireDate: "unknown", hrId: "B-7", name: "No Date" },
    ],
    loginHrIds: ["b-1"],
    loginStepsInHand: [" B-2 "],
    today: "2026-11-13",
  });
  assert.deepEqual(
    missing.map((hire) => hire.name),
    ["Nobody Trying", "Starts Next Month"],
    "RED an active recent hire with no login and no login step in hand is flagged; an unreadable date is skipped, never guessed",
  );
  const check = flat("src/lib/reconciliation/checks/recruitment.ts");
  assert.match(check, /\.eq\("step", "login"\) \.in\("status", \["pending", "failed"\]\)/, "a login step that GAVE UP excuses nothing");
  assert.match(check, /id: "new-hires-without-login"/);
  assert.match(check, /recruitmentReconciliationChecks: ReconciliationCheck\[\] = \[acceptedOfferMustProduceAHire, newHiresHaveALogin\]/);
}

// ── 7 · The job, the route and the table are declared everywhere they must be ──────────────────

function wiringTests(): void {
  const cron = flat("app/api/cron/hire-handoff-reconcile/route.ts");
  assert.match(cron, /assertCronAuthorized\(request, "cron\/hire-handoff-reconcile"\)/);
  assert.match(cron, /withDeadMansSwitch\("phoenix-hire-handoff-reconcile", \(\) => runHireHandoffReconciler\(\)\)/);
  assert.match(flat("scripts/cronjob-sync.mjs"), /"hire-handoff-reconcile": \{ title: "Phoenix — hire hand-off reconciler", path: "\/api\/cron\/hire-handoff-reconcile", schedule: \{ hours: \[-1\], minutes: \[9\]/);
  assert.match(flat("src/lib/observability/job-schedule.ts"), /slug: "phoenix-hire-handoff-reconcile", kind: "cron", schedule: "9 \* \* \* \*"/);

  const registry = flat("src/lib/security/access-registry.ts");
  assert.match(registry, /tokenApi\(\{ authMode: "cron-secret", methods: \["GET", "POST"\], pattern: "\/api\/cron\/hire-handoff-reconcile"/);
  assert.match(registry, /methods: \["POST"\], pattern: "\/api\/employees\/hire-handoff\/retry", permission: \{ resource: "employees", action: "create" \}, csrfRequired: true/);

  const retry = flat("app/api/employees/hire-handoff/retry/route.ts");
  assert.match(retry, /assertSameOriginMutation\(request\)/);
  assert.match(retry, /await assertPermission\(access, "employees", "create"\);/, "RED the retry is permission-checked before it runs anything");
  assert.ok(retry.indexOf('assertPermission(access, "employees", "create")') < retry.indexOf("retryHireHandoffNow("));
  assert.ok(!/sendEmail|@\/lib\/email|resend/i.test(code("src/lib/employees/hire-handoff-reconciler.ts") + retry), "no retry sends an email of its own");

  const migration = code("supabase/migrations/20261113201756_hire_handoff_steps.sql");
  assert.match(migration, /constraint hire_handoff_steps_employee_step_key unique \(employee_hr_id, step\)/, "one row per employee and step — the upsert key");
  assert.match(migration, /references public\.employees \(hr_id\) on update cascade on delete cascade/);
  assert.match(migration, /enable row level security/);
  const columns = migration.slice(migration.indexOf("create table if not exists public.hire_handoff_steps"), migration.indexOf("comment on table"));
  assert.ok(columns.length > 100, "the table definition is found");
  assert.ok(!/national_id|salary|password|token/i.test(columns), "the table has no column for a secret or a salary");
}
