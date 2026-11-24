import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { clearSignedOutDrafts, ownerScopedStorageKey, VISIT_OUTBOX_KEY_BASE } from "../src/lib/browser-storage/owner-scoped.ts";
import {
  drainVisitOutbox,
  findHeldVisit,
  forgetQueuedVisit,
  keepQueuedVisit,
  readQueuedVisits,
  waitingCustomerIds,
  type OutboxDeps,
} from "../src/lib/phoenix-crm/visit-outbox.ts";
import { MANAGER_SINGLE_VISIT, VISIT_OUTBOX_MAX_ENTRIES, VISIT_RESEND_GAP_MS, type QueuedVisit } from "../src/lib/phoenix-crm/visit-resend-rules.ts";
import { pressedWithNoLocation } from "../src/lib/phoenix-crm/late-visit-rules.ts";
import { markVisitsCanBeHeld, visitsCanBeHeldNow } from "../src/components/phoenix-crm/visit-hold-signal.ts";

/**
 * Phoenix CRM — the phone's list of held visits and the one pass that sends them (owner, 3 Nov 2026).
 *
 * Fakes only: `.env.local` is production, so no real visit is ever saved to prove this. Every story below is one a
 * rep will live: no signal, a refusal that arrives late, a visit that had landed after all, a wait past two hours,
 * the 02:00 close, signing out, and a second person on the same phone.
 */

class FakeStorage {
  readonly store = new Map<string, string>();
  failWrites = false;
  get length(): number {
    return this.store.size;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

const ME = "MR-0412";
const SOMEONE_ELSE = "MR-0977";
const START = 2_000_000_000_000;
const SERVER_NOON = Date.parse("2026-11-03T10:00:00.000Z");

function entry(overrides: Partial<QueuedVisit> = {}): QueuedVisit {
  const visitId = overrides.visitId ?? "visit-1";
  return {
    visitId,
    ownerHrId: ME,
    seatId: "seat-1",
    customerId: `customer-of-${visitId}`,
    customerName: "A clinic",
    pressedDay: "2026-11-03",
    pressedAtMs: START,
    sendingUntilMs: 0,
    attempts: 1,
    status: "waiting",
    refusalCode: null,
    refusalMessage: null,
    // A real press carries the reading; one without it is the no-location press, filed at once (24 Nov 2026).
    body: { id: visitId, comment: "Saw the doctor", lat: 30.0444, lon: 31.2357 },
    ...overrides,
  };
}

type Harness = {
  deps: OutboxDeps;
  storage: FakeStorage;
  sent: Array<Record<string, unknown>>;
  /** What each send was handed beside its body: the entry, whose kind names the route. */
  sentEntries: QueuedVisit[];
  reports: Array<{ visitId: string; outcome: string; queuedSeconds: number | null }>;
  reportedCodes: Array<string | null>;
  sleeps: number[];
  statusReads: string[][];
  changes: () => number;
  held: () => QueuedVisit[];
};

function harness(options: {
  entries?: QueuedVisit[];
  nowMs?: number;
  enabled?: boolean;
  savedVisitIds?: string[];
  serverNowMs?: number;
  personHrId?: string;
  statusFails?: boolean | (() => boolean);
  send?: OutboxDeps["send"];
  /** Files a late visit; absent, the phone has no filing (as before 24 Nov 2026). */
  fileLate?: OutboxDeps["fileLate"];
} = {}): Harness {
  const storage = new FakeStorage();
  for (const held of options.entries ?? []) keepQueuedVisit(storage, ME, held);
  const sent: Harness["sent"] = [];
  const sentEntries: QueuedVisit[] = [];
  const reports: Harness["reports"] = [];
  const reportedCodes: Harness["reportedCodes"] = [];
  const sleeps: number[] = [];
  const statusReads: string[][] = [];
  let changes = 0;
  const deps: OutboxDeps = {
    storage,
    ownerHrId: ME,
    now: () => options.nowMs ?? START + 10 * 60_000,
    readStatus: async (ids) => {
      statusReads.push(ids);
      const fails = typeof options.statusFails === "function" ? options.statusFails() : options.statusFails;
      if (fails) throw new Error("no signal");
      return { enabled: options.enabled ?? true, personHrId: options.personHrId ?? ME, savedVisitIds: options.savedVisitIds ?? [], serverNowMs: options.serverNowMs ?? SERVER_NOON };
    },
    send: async (body, held) => {
      sent.push(body);
      sentEntries.push(held);
      return options.send ? options.send(body, held) : { duplicate: false };
    },
    ...(options.fileLate ? { fileLate: options.fileLate } : {}),
    report: (held, outcome, queuedSeconds) => {
      reports.push({ visitId: held.visitId, outcome, queuedSeconds });
      reportedCodes.push(held.refusalCode);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    changed: () => {
      changes += 1;
    },
  };
  return { deps, storage, sent, sentEntries, reports, reportedCodes, sleeps, statusReads, changes: () => changes, held: () => readQueuedVisits(storage, ME) };
}

export async function runPhoenixCrmVisitOutboxTests(): Promise<void> {
  checkTheList();
  await checkNoSignal();
  await checkALateRefusal();
  await checkAlreadySaved();
  await checkPastItsTime();
  await checkTheSwitch();
  await checkTheVoiceNote();
  await checkTheOrder();
  checkSignOutAndAnotherPerson();
  checkTheFormKeepsThePressFirst();
  await checkAnotherPersonSignedIn();
  await checkTheCloseIsStrict();
  await checkAManagersOwnSingleVisit();
  await checkALateVisitIsFiled();
}

/**
 * A visit past its window is FILED whole for the Super Admin, never sent and never left for the person to remember
 * (owner, 24 Nov 2026: "never any visit to be lost", then "SUPER ADMIN APPROVE IT ONLY SUPER ADMIN").
 */
async function checkALateVisitIsFiled(): Promise<void> {
  const filedEntries: QueuedVisit[] = [];
  const late = harness({ entries: [entry()], nowMs: START + 121 * 60_000, fileLate: async (held) => void filedEntries.push(held) });
  assert.equal(await drainVisitOutbox(late.deps), 0);
  assert.equal(late.sent.length, 0, "🔴 a late visit is never SENT: it would be dated on arrival");
  assert.equal(filedEntries.length, 1, "🔴 it is filed for the Super Admin");
  assert.equal(filedEntries[0]?.body.comment, "Saw the doctor", "whole, the very body of the press");
  assert.equal(late.held()[0]?.status, "filed", "and the phone says it was sent for approval");
  assert.equal(late.reports[0]?.outcome, "timed_out");

  // Across 02:00 too.
  const crossed = harness({
    entries: [entry()],
    nowMs: START + 20 * 60_000,
    serverNowMs: Date.parse("2026-11-03T00:10:00.000Z"),
    fileLate: async () => undefined,
  });
  await drainVisitOutbox(crossed.deps);
  assert.equal(crossed.held()[0]?.status, "filed");

  // No signal while filing: nothing is decided, it waits for the next pass.
  const offline = harness({
    entries: [entry(), entry({ visitId: "visit-2", pressedAtMs: START + 60_000 })],
    nowMs: START + 125 * 60_000,
    fileLate: async () => {
      throw { code: "offline", message: "No connection." };
    },
  });
  assert.equal(await drainVisitOutbox(offline.deps), 2, "🔴 both still waiting: a dropped signal decides nothing");
  assert.equal(offline.reports.length, 0);

  // 🔴 A server error is not a refusal: the visit keeps waiting and is filed on a later pass, never left to be lost.
  const serverDown = harness({
    entries: [entry()],
    nowMs: START + 121 * 60_000,
    fileLate: async () => {
      throw { code: "failed", message: "Could not save this visit.", status: 503 };
    },
  });
  assert.equal(await drainVisitOutbox(serverDown.deps), 1, "🔴 a server error leaves it waiting");
  assert.equal(serverDown.held()[0]?.status, "waiting");

  // Refused (a test persona, the switch flipped between reads): the person logs it again, as before filing existed.
  const refused = harness({
    entries: [entry()],
    nowMs: START + 121 * 60_000,
    fileLate: async () => {
      throw { code: "late_visit_not_filed", message: "Not filed." };
    },
  });
  await drainVisitOutbox(refused.deps);
  assert.equal(refused.held()[0]?.status, "too_late");

  // Switched off: never filed, never sent.
  let filedWhileOff = 0;
  const off = harness({ entries: [entry()], enabled: false, fileLate: async () => void (filedWhileOff += 1) });
  await drainVisitOutbox(off.deps);
  assert.equal(filedWhileOff, 0, "switched off, nothing is filed either");
  assert.equal(off.held()[0]?.status, "too_late");

  // A filed visit is safe off the phone, so it gives up its place to a new press on a full phone.
  const full = new FakeStorage();
  for (let index = 0; index < VISIT_OUTBOX_MAX_ENTRIES; index += 1) {
    keepQueuedVisit(full, ME, entry({ visitId: `full-${index}`, status: index === 3 ? "filed" : "waiting", pressedAtMs: START + index }));
  }
  assert.equal(keepQueuedVisit(full, ME, entry({ visitId: "new-press" })), true, "🔴 a new press is kept on a full phone holding a filed visit");
  assert.equal(readQueuedVisits(full, ME).some((held) => held.visitId === "full-3"), false, "the filed one went");
  assert.equal(keepQueuedVisit(full, ME, entry({ visitId: "another-press" })), false, "with nothing filed left, a full phone still refuses");
  assert.equal(readQueuedVisits(full, ME).length, VISIT_OUTBOX_MAX_ENTRIES);

  // 🔴 A PRESS WITH NO READING IS FILED AT ONCE, never sent and never lost (owner, 24 Nov 2026: "build the three
  // follow-ups"). Sent, the server could only refuse it; filed, the Super Admin decides it.
  const noReadingFiled: QueuedVisit[] = [];
  const noReading = harness({
    entries: [entry({ body: { id: "visit-1", comment: "Saw the doctor" } })],
    nowMs: START + 60_000,
    fileLate: async (held) => void noReadingFiled.push(held),
  });
  assert.equal(await drainVisitOutbox(noReading.deps), 0);
  assert.equal(noReading.sent.length, 0, "🔴 a press with no reading is never sent as a visit");
  assert.equal(noReadingFiled.length, 1, "🔴 it is filed for the Super Admin, inside its window");
  assert.equal(noReading.held()[0]?.status, "filed", "and the phone says it was sent for approval");
  assert.equal(pressedWithNoLocation(undefined, { lat: 30, lon: 31 }), false, "a press with its reading is a visit");
  assert.equal(pressedWithNoLocation(undefined, { lat: Number.NaN, lon: 31 }), true, "a reading that is not a number is none");
  assert.equal(pressedWithNoLocation(MANAGER_SINGLE_VISIT, {}), false, "🔴 a manager's own single visit reads no location, so it is sent as ever");

  // With a reading, inside its window, it is sent as before.
  const withReading = harness({ entries: [entry()], nowMs: START + 60_000, fileLate: async () => assert.fail("never filed") });
  await drainVisitOutbox(withReading.deps);
  assert.equal(withReading.sent.length, 1, "a press with its reading is sent");

  // The form holds an empty press only when location is ALLOWED; switched off, the server's own sentence still asks for it.
  const form = stripComments(readFileSync("src/components/phoenix-crm/visit-log-form.tsx", "utf8"));
  const empty = form.slice(form.indexOf("const fix = await readFix();"), form.indexOf("const body = { ...next.payload, ...silentFixPayload(fix, savedAt)"));
  assert.ok(empty.includes("if (queueOwner !== null && (await silentFixAllowed())) {"), "🔴 only a phone that allows location files an empty press");
  assert.ok(empty.includes("holdVisitPress({"), "🔴 the empty press is kept on the phone before anything else");
  assert.ok(empty.indexOf("holdVisitPress({") < empty.indexOf("setProblem(NO_FIX_FOR_A_VISIT);"), "and the refusal is what is left when it cannot be kept");
  const reader = stripComments(readFileSync("src/components/phoenix-crm/use-silent-fix.ts", "utf8"));
  assert.ok(reader.includes('return answer.state === "granted";'), "🔴 allowed means granted, never a prompt still open");
}

/**
 * A manager's own single visit is held on his phone too (owner, 24 Nov 2026: "never any visit to be lost from either a
 * rep or from the manager"). It sends to its own route, and the territory screens never take it for one of theirs.
 */
async function checkAManagersOwnSingleVisit(): Promise<void> {
  const territory = entry({ visitId: "visit-1", customerId: "customer-1" });
  const single = entry({ visitId: "ref-1", customerId: "customer-1", kind: MANAGER_SINGLE_VISIT, body: { clientRef: "ref-1", customerId: "customer-1" } });

  const both = harness({ entries: [territory, single] });
  assert.equal(both.held().length, 2, "both are on the phone");
  assert.equal(findHeldVisit([single], { seatId: "seat-1", customerId: "customer-1", pressedDay: "2026-11-03" }), null, "🔴 a territory visit never reuses the id of his own single visit");
  assert.equal(findHeldVisit(both.held(), { seatId: "seat-1", customerId: "customer-1", pressedDay: "2026-11-03" })?.visitId, "visit-1");
  assert.equal(waitingCustomerIds([single], "seat-1").size, 0, "and the territory's list does not hide the customer for it");

  await drainVisitOutbox(both.deps);
  assert.equal(both.sentEntries.length, 2, "🔴 his own single visit is sent by the same pass");
  assert.equal(both.sentEntries.find((held) => held.visitId === "ref-1")?.kind, MANAGER_SINGLE_VISIT, "and the send is told what it is, so it goes to its own route");
  assert.equal(both.held().length, 0, "landed, both leave the phone");

  // Already on file under its client ref: settled with no second POST.
  const landed = harness({ entries: [single], savedVisitIds: ["ref-1"] });
  await drainVisitOutbox(landed.deps);
  assert.equal(landed.sent.length, 0, "a single visit that had landed is not sent again");
  assert.deepEqual(landed.reports.map((report) => report.outcome), ["already_saved"]);

  // A kind this code does not know is never read, so it can never be sent to the wrong route.
  const storage = new FakeStorage();
  storage.setItem(ownerScopedStorageKey(VISIT_OUTBOX_KEY_BASE, ME) ?? "", JSON.stringify([{ ...entry(), kind: "something_else" }]));
  assert.equal(readQueuedVisits(storage, ME).length, 0);

  const engine = stripComments(readFileSync("src/components/phoenix-crm/visit-outbox-engine.ts", "utf8"));
  assert.match(engine, /if \(isManagerSingleVisit\(entry\)\) \{[\s\S]*?crmPostWithin<unknown>\(MANAGER_SINGLE_VISIT_PATH, visit, "today", VISIT_SAVE_TIMEOUT_MS\)/, "🔴 it is sent to My single visits' own route");
  const status = stripComments(readFileSync("src/lib/phoenix-crm/server/visit-resend-log.ts", "utf8"));
  assert.ok(status.includes("loadManagerVisitClientRefsOnFile({ enteredByHrId: hrId, clientRefs: ids })"), "🔴 the status read answers his single visits by their client ref");
  const screen = stripComments(readFileSync("src/components/phoenix-crm/manager-single-visits.tsx", "utf8"));
  assert.ok(screen.includes("kind: MANAGER_SINGLE_VISIT,"), "🔴 My single visits keeps the press on the phone before the request goes");
  assert.ok(screen.indexOf("holdVisitPress({") < screen.indexOf("await crmPostWithin<ManagerTodayView>(VISITS, body"), "kept first, then sent");
  assert.match(screen, /if \(isRetryableFailure\(failure\)\) \{\s*leaveVisitWaiting\(queueOwnerHrId, logging\.clientRef\);/, "only no signal is held; a refusal is shown as before");
  assert.ok(screen.includes("<VisitOutboxNote"), "and what it holds is shown on his screen, with Log it again and Remove");
  const view = stripComments(readFileSync("src/lib/phoenix-crm/server/manager-visits.ts", "utf8"));
  assert.ok(view.includes("visitQueueOwnerHrId: !isTest && viewer.config.settings.visitResendEnabled ? viewer.hrId : null,"), "the same off switch, never a test login");
  const tab = stripComments(readFileSync("src/components/phoenix-crm/visits-tab.tsx", "utf8"));
  assert.ok(tab.includes("entry.seatId === seatId && !isManagerSingleVisit(entry)"), "🔴 a territory's Visits screen never shows his own single visit as one of its own");
}

async function checkAnotherPersonSignedIn(): Promise<void> {
  const elsewhere = harness({ entries: [entry()], personHrId: SOMEONE_ELSE });
  await drainVisitOutbox(elsewhere.deps);
  assert.equal(elsewhere.sent.length, 0, "🔴 a tab left open for one person never sends under another's sign-in");
  assert.equal(elsewhere.held()[0]?.status, "waiting", "and nothing is decided: it waits for its owner");
  assert.equal(elsewhere.reports.length, 0);

  const sameInOtherCase = harness({ entries: [entry()], personHrId: ME.toLowerCase() });
  await drainVisitOutbox(sameInOtherCase.deps);
  assert.equal(sameInOtherCase.sent.length, 1, "the same person in another case is the same person");
}

async function checkTheCloseIsStrict(): Promise<void> {
  // The server's clock is carried forward through the pass: the second visit is judged later than the read.
  const close = Date.parse("2026-11-03T00:00:00.000Z");
  const first = entry({ visitId: "visit-1", customerId: "customer-1" });
  const second = entry({ visitId: "visit-2", customerId: "customer-2", pressedAtMs: first.pressedAtMs + 1 });
  const moving = harness({ entries: [first, second], serverNowMs: close - 40_000 });
  let phone = first.pressedAtMs + 60_000;
  moving.deps.now = () => phone;
  moving.deps.send = async (body) => {
    moving.sent.push(body);
    phone += 15_000;
    return { duplicate: false };
  };
  await drainVisitOutbox(moving.deps);
  assert.equal(moving.sent.length, 1, "the first leaves 40 seconds before the close");
  assert.equal(moving.held().find((held) => held.visitId === "visit-2")?.status, "too_late", "🔴 the second would land after the close, so it waits for the rep");
  assert.equal(moving.reports.find((report) => report.visitId === "visit-2")?.outcome, "timed_out");

  const closeCall = harness({ entries: [first], nowMs: first.pressedAtMs + 60_000, serverNowMs: close - 20_000 });
  await drainVisitOutbox(closeCall.deps);
  assert.equal(closeCall.sent.length, 0, "a send that may take longer than the time left is not started");
}

function checkTheFormKeepsThePressFirst(): void {
  const form = stripComments(readFileSync("src/components/phoenix-crm/visit-log-form.tsx", "utf8"));
  const kept = form.indexOf("holdVisitPress({");
  const sent = form.indexOf("crmPostWithin<SavedVisit>(");
  assert.ok(kept !== -1 && sent > kept, "🔴 the press is on the phone before the request goes, or a reload loses it");
  const onlyNoSignal = form.indexOf("if (isRetryableFailure(error)) {", sent);
  const waiting = form.indexOf("leaveVisitWaiting(queueOwner, visitId);", sent);
  assert.ok(onlyNoSignal !== -1 && waiting > onlyNoSignal, "🔴 only no signal is held: a refusal on the first press is shown as it always was");
  assert.ok(form.indexOf("forgetHeldVisit(queueOwner, visitId);", sent) > sent, "a save that landed leaves the phone");
  assert.ok(form.includes('await crmPost<SavedVisit>("/api/phoenix-crm/visits", body, "visit")'), "not kept, the save behaves as it always did");
  const replaced = form.indexOf("if (retryOf && retryOf.visitId !== visitId) {", waiting);
  assert.ok(replaced !== -1 && form.indexOf("forgetHeldVisit(queueOwner, retryOf.visitId);", replaced) - replaced < 120, "a row logged again under a new id goes once the phone holds the new one, or it stays for ever");

  const tab = stripComments(readFileSync("src/components/phoenix-crm/visits-tab.tsx", "utf8"));
  const landing = tab.indexOf("if (waitingHere < waitingBefore.current) {");
  assert.ok(landing !== -1, "🔴 a held visit that lands while the rep is looking appears in the day, it does not just vanish");
  for (const read of ["reloadDay();", "reloadCommitments();", "reloadPrep();"]) {
    const at = tab.indexOf(read, landing);
    assert.ok(at !== -1 && at - landing < 120, `🔴 the landing reads again, or the panel keeps "No connection" under a visit that landed: ${read}`);
  }
  assert.ok(tab.includes("useEffect(() => (heldOwner ? markVisitsCanBeHeld() : undefined), [heldOwner]);"), "🔴 only the server's own answer lets the header say a visit can be kept, and it stops saying so when the screen goes");

  assert.equal(visitsCanBeHeldNow(), false, "no screen, nothing can be kept");
  const first = markVisitsCanBeHeld();
  const second = markVisitsCanBeHeld();
  first();
  assert.equal(visitsCanBeHeldNow(), true, "one screen left, it can still be kept");
  second();
  assert.equal(visitsCanBeHeldNow(), false, "the last screen gone, the header goes back to nothing will save");
  const signal = stripComments(readFileSync("src/components/phoenix-crm/visit-hold-signal.ts", "utf8"));
  assert.deepEqual(signal.match(/from "[^"]+"/g), ['from "react"'], "🔴 the shell imports this on every page, so it brings nothing with it");

  const row = stripComments(readFileSync("src/components/phoenix-crm/visit-outbox-note.tsx", "utf8"));
  assert.ok(row.includes("heldRefusalSentence(entry.refusalMessage)"), "the row draws the sentence through the filter");
  assert.ok(!row.includes("{entry.refusalMessage}"), "and never the server's sentence raw");

  const layout = stripComments(readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8"));
  const runnerAt = layout.indexOf("<VisitOutboxRunner");
  const gate = layout.indexOf("{appShell ? null : (");
  assert.ok(runnerAt !== -1 && layout.lastIndexOf("<VisitOutboxRunner") === runnerAt, "one sender in the portal");
  assert.ok(runnerAt < gate && gate - runnerAt < 200, "🔴 beside the top bar and never inside it: app mode has no top bar, and a held visit still has to send");

  const runner = stripComments(readFileSync("src/components/phoenix-crm/visit-outbox-runner.tsx", "utf8"));
  for (const moment of ['window.addEventListener("online", look)', 'window.addEventListener("pageshow", look)', 'document.addEventListener("visibilitychange", lookIfVisible)']) {
    assert.ok(runner.includes(moment), `🔴 the first load can fail on the press itself, so it looks again: ${moment}`);
  }
  for (const screen of ["src/components/phoenix-crm/visits-tab.tsx", "src/components/phoenix-crm/visit-log-form.tsx"]) {
    assert.ok(stripComments(readFileSync(screen, "utf8")).includes("preloadVisitOutboxEngine();"), `🔴 ${screen} fetches the sending code while there is signal`);
  }
  assert.ok(form.includes("forgetHeldVisit(retryOf.ownerHrId, retryOf.visitId);"), "a row logged again goes by its own owner, so the off switch cannot strand it");

  const report = stripComments(readFileSync("app/api/phoenix-crm/visit-resend-report/route.ts", "utf8"));
  assert.ok(report.indexOf("assertApiRateLimit(") !== -1 && report.indexOf("assertApiRateLimit(") < report.indexOf("recordVisitResend("), "one person cannot fill the log with random ids");
}

function checkTheList(): void {
  const storage = new FakeStorage();
  assert.equal(keepQueuedVisit(null, ME, entry()), false, "no storage: not kept, so the form behaves as it always did");
  assert.equal(keepQueuedVisit(storage, ME, entry({ ownerHrId: SOMEONE_ELSE })), false, "another person's entry is never written under this person");
  assert.equal(keepQueuedVisit(storage, null, entry()), false, "no person, no queue");

  storage.failWrites = true;
  assert.equal(keepQueuedVisit(storage, ME, entry()), false, "storage full is told as not kept, never as safe");
  storage.failWrites = false;

  assert.equal(keepQueuedVisit(storage, ME, entry()), true);
  assert.equal(keepQueuedVisit(storage, ME, entry({ attempts: 2 })), true, "the same id replaces, never a second row");
  assert.equal(readQueuedVisits(storage, ME).length, 1);
  assert.equal(readQueuedVisits(storage, ME)[0]?.attempts, 2);

  const full = new FakeStorage();
  for (let index = 0; index < VISIT_OUTBOX_MAX_ENTRIES; index += 1) {
    assert.equal(keepQueuedVisit(full, ME, entry({ visitId: `visit-${index}` })), true);
  }
  assert.equal(keepQueuedVisit(full, ME, entry({ visitId: "one-too-many" })), false, "past the limit it is not kept");
  assert.equal(keepQueuedVisit(full, ME, entry({ visitId: "visit-3", attempts: 9 })), true, "an entry already held can still be rewritten at the limit");

  const corrupt = new FakeStorage();
  corrupt.setItem(ownerScopedStorageKey(VISIT_OUTBOX_KEY_BASE, ME) as string, "not json");
  assert.deepEqual(readQueuedVisits(corrupt, ME), [], "a broken list reads as nothing held");
  assert.deepEqual(readQueuedVisits(null, ME), [], "blocked site data reads as nothing held");

  const held = readQueuedVisits(storage, ME);
  const where = { seatId: "seat-1", customerId: "customer-of-visit-1", pressedDay: "2026-11-03" };
  assert.equal(findHeldVisit(held, where)?.visitId, "visit-1", "a second press for this visit reuses the id");
  assert.equal(findHeldVisit(held, { ...where, pressedDay: "2026-11-04" }), null, "another day is another visit");
  assert.equal(findHeldVisit(held, { ...where, seatId: "seat-2" }), null, "another territory is another visit");
  assert.deepEqual([...waitingCustomerIds(held, "seat-1")], ["customer-of-visit-1"], "not offered again while it waits");
  assert.equal(waitingCustomerIds(held, "seat-2").size, 0, "only on its own territory");
  assert.equal(waitingCustomerIds([entry({ status: "refused" })], "seat-1").size, 0, "a refused visit is offered again, because he must log it");

  forgetQueuedVisit(storage, ME, "visit-1");
  assert.equal(storage.store.size, 0, "the last one gone leaves no key, so the runner goes back to doing nothing");
}

async function checkNoSignal(): Promise<void> {
  // The ask itself fails: nothing is decided, and nothing is posted.
  const silent = harness({ entries: [entry()], statusFails: true });
  assert.equal(await drainVisitOutbox(silent.deps), 1);
  assert.equal(silent.sent.length, 0, "with no signal to ask, nothing is sent");
  assert.equal(silent.reports.length, 0, "and nothing is filed");
  assert.equal(silent.held()[0]?.status, "waiting");

  // The ask works and the send fails: he keeps it, and the pass ends rather than failing each in turn.
  const dropped = harness({
    entries: [entry(), entry({ visitId: "visit-2", pressedAtMs: START + 1 })],
    send: async () => {
      throw { code: "offline", message: "No signal" };
    },
  });
  assert.equal(await drainVisitOutbox(dropped.deps), 2, "both still waiting");
  assert.equal(dropped.sent.length, 1, "the pass stops at the first send the signal stopped");
  assert.deepEqual(dropped.reports, [], "nothing has ended yet, so nothing is filed");
  assert.equal(dropped.held()[0]?.sendingUntilMs, 0, "free for the next pass");
  assert.equal(dropped.held()[0]?.attempts, 2, "and the attempt is counted");

  // A signed-out phone is the same: the visit waits for him to sign in.
  const signedOut = harness({
    entries: [entry()],
    send: async () => {
      throw { code: "signed_out", message: "Sign in" };
    },
  });
  assert.equal(await drainVisitOutbox(signedOut.deps), 1, "signing in again sends it");
  assert.equal(signedOut.held()[0]?.status, "waiting");

  // The good road.
  const landed = harness({ entries: [entry()] });
  assert.equal(await drainVisitOutbox(landed.deps), 0);
  assert.equal(landed.sent[0]?.queuedSeconds, 600, "the send carries how long the phone held it");
  assert.equal(landed.sent[0]?.id, "visit-1", "under the same id");
  assert.equal(landed.held().length, 0, "and it is gone from the phone");
  assert.deepEqual(landed.reports, [{ visitId: "visit-1", outcome: "landed_late", queuedSeconds: 600 }]);
}

async function checkALateRefusal(): Promise<void> {
  const refused = harness({
    entries: [entry()],
    send: async () => {
      throw { code: "phoenix_crm_outside_area", message: "This customer is not on your list." };
    },
  });
  await drainVisitOutbox(refused.deps);
  const stuck = refused.held()[0];
  assert.equal(stuck?.status, "refused");
  assert.equal(stuck?.refusalCode, "phoenix_crm_outside_area");
  assert.equal(stuck?.refusalMessage, "This customer is not on your list.", "the server's own sentence, as it came");
  assert.deepEqual(refused.statusReads, [["visit-1"], ["visit-1"]], "🔴 the id is read again before a refusal is shown");
  assert.equal(refused.reports[0]?.outcome, "refused");
  assert.equal(refused.reportedCodes[0], "phoenix_crm_outside_area", "the log carries the code, because the row may not say why");

  // Refused on the second press, but the first landed and only lost its reply.
  let reads = 0;
  const landedFirst = harness({
    entries: [entry()],
    send: async () => {
      throw { code: "phoenix_crm_outside_area", message: "Refused" };
    },
  });
  landedFirst.deps.readStatus = async () => {
    reads += 1;
    return { enabled: true, personHrId: ME, savedVisitIds: reads > 1 ? ["visit-1"] : [], serverNowMs: SERVER_NOON };
  };
  await drainVisitOutbox(landedFirst.deps);
  assert.equal(landedFirst.held().length, 0, "the visit is on file: removed in silence, with no refusal shown");
  assert.equal(landedFirst.reports[0]?.outcome, "already_saved");

  // The read after a refusal fails: nothing can be proved, so he is told nothing yet.
  let statusCalls = 0;
  const unproved = harness({
    entries: [entry()],
    statusFails: () => {
      statusCalls += 1;
      return statusCalls > 1;
    },
    send: async () => {
      throw { code: "phoenix_crm_outside_area", message: "Refused" };
    },
  });
  await drainVisitOutbox(unproved.deps);
  assert.equal(unproved.held()[0]?.status, "waiting", "a refusal he need not have seen is the worse mistake");
  assert.equal(unproved.reports.length, 0);
}

async function checkAlreadySaved(): Promise<void> {
  // The ask settles it with no POST at all.
  const onFile = harness({ entries: [entry()], savedVisitIds: ["visit-1"] });
  assert.equal(await drainVisitOutbox(onFile.deps), 0);
  assert.equal(onFile.sent.length, 0, "a visit already on file is never posted");
  assert.equal(onFile.reports[0]?.outcome, "already_saved");
  assert.equal(onFile.held().length, 0);
  assert.equal(onFile.changes(), 1, "the screen is told");

  // The server answers with the repeat.
  const repeat = harness({ entries: [entry()], send: async () => ({ duplicate: true }) });
  await drainVisitOutbox(repeat.deps);
  assert.equal(repeat.reports[0]?.outcome, "already_saved", "a repeated id is counted as already saved, not as a late landing");
  assert.equal(repeat.held().length, 0);
}

async function checkPastItsTime(): Promise<void> {
  // Over two hours.
  const late = harness({ entries: [entry()], nowMs: START + 121 * 60_000 });
  assert.equal(await drainVisitOutbox(late.deps), 0, "it no longer counts as waiting");
  assert.equal(late.sent.length, 0, "🔴 past two hours nothing sends by itself");
  assert.equal(late.held()[0]?.status, "too_late", "and it stays on the phone for him to log again");
  assert.equal(late.reports[0]?.outcome, "timed_out");

  // Over two hours, but it had landed: he has nothing to do.
  const lateButThere = harness({ entries: [entry()], nowMs: START + 121 * 60_000, savedVisitIds: ["visit-1"] });
  await drainVisitOutbox(lateButThere.deps);
  assert.equal(lateButThere.held().length, 0, "the id is checked first");
  assert.equal(lateButThere.reports[0]?.outcome, "already_saved");

  // Across 02:00: pressed 01:50 Cairo, the signal back at 02:10 Cairo, twenty minutes later.
  const crossed = harness({ entries: [entry()], nowMs: START + 20 * 60_000, serverNowMs: Date.parse("2026-11-03T00:10:00.000Z") });
  await drainVisitOutbox(crossed.deps);
  assert.equal(crossed.sent.length, 0, "🔴 across the close of the visit day nothing sends by itself");
  assert.equal(crossed.held()[0]?.status, "too_late");
  assert.equal(crossed.reports[0]?.outcome, "timed_out");
}

async function checkTheSwitch(): Promise<void> {
  const off = harness({ entries: [entry()], enabled: false });
  await drainVisitOutbox(off.deps);
  assert.equal(off.sent.length, 0, "switched off, nothing on a phone sends by itself");
  assert.equal(off.held()[0]?.status, "too_late", "and the visit tells him to log it again rather than vanishing");

  const offButThere = harness({ entries: [entry()], enabled: false, savedVisitIds: ["visit-1"] });
  await drainVisitOutbox(offButThere.deps);
  assert.equal(offButThere.held().length, 0, "a visit that had landed still clears");
}

async function checkTheVoiceNote(): Promise<void> {
  const withVoice = { id: "visit-1", comment: "Saw the doctor", voiceNotePath: "voice/a.webm", voiceNoteSeconds: 12, voiceNoteBytes: 900, lat: 30.0444, lon: 31.2357 };
  const typed = harness({
    entries: [entry({ body: withVoice })],
    send: async (body) => {
      if (body.voiceNotePath) throw { code: "phoenix_crm_voice_expired", message: "The recording expired" };
      return { duplicate: false };
    },
  });
  await drainVisitOutbox(typed.deps);
  assert.equal(typed.sent.length, 2, "once as pressed, once more without the note");
  assert.equal(typed.sent[1]?.voiceNotePath, null);
  assert.equal(typed.sent[1]?.id, "visit-1", "the same visit under the same id");
  assert.equal(typed.sent[1]?.comment, "Saw the doctor", "his typed comment stands");
  assert.equal(typed.held().length, 0);
  assert.equal(typed.reports[0]?.outcome, "landed_late");

  const refusedTwice = harness({
    entries: [entry({ body: withVoice })],
    send: async () => {
      throw { code: "phoenix_crm_voice_expired", message: "The recording expired" };
    },
  });
  await drainVisitOutbox(refusedTwice.deps);
  assert.equal(refusedTwice.sent.length, 2, "never more than twice");
  assert.equal(refusedTwice.held()[0]?.status, "refused", "and a refusal of the visit itself is his to read");
  assert.equal(refusedTwice.held()[0]?.body.voiceNotePath, null, "the note stays off the entry");

  const spoken = harness({
    entries: [entry({ body: { ...withVoice, comment: "" } })],
    send: async () => {
      throw { code: "phoenix_crm_voice_expired", message: "The recording expired" };
    },
  });
  await drainVisitOutbox(spoken.deps);
  assert.equal(spoken.sent.length, 1, "with only a spoken comment there is nothing to resend");
  assert.equal(spoken.held()[0]?.status, "refused", "so it is his to log again");
}

async function checkTheOrder(): Promise<void> {
  const queue = harness({
    entries: [entry({ visitId: "later", pressedAtMs: START + 60_000 }), entry({ visitId: "first", pressedAtMs: START }), entry({ visitId: "last", pressedAtMs: START + 120_000 })],
  });
  await drainVisitOutbox(queue.deps);
  assert.deepEqual(queue.sent.map((body) => body.id), ["first", "later", "last"], "oldest first, one at a time");
  assert.deepEqual(queue.sleeps, [VISIT_RESEND_GAP_MS, VISIT_RESEND_GAP_MS], "with a pause between sends, never before the first");

  const inFlight = harness({ entries: [entry({ sendingUntilMs: START + 11 * 60_000 })] });
  assert.equal(await drainVisitOutbox(inFlight.deps), 1);
  assert.equal(inFlight.statusReads.length, 0, "the form's own request is in flight, so the pass leaves it alone and asks nothing");
  assert.equal(inFlight.sent.length, 0);

  const nothing = harness();
  assert.equal(await drainVisitOutbox(nothing.deps), 0);
  assert.equal(nothing.statusReads.length, 0, "🔴 a phone with nothing held asks the server nothing");

  const stuck = harness({ entries: [entry({ status: "refused" })] });
  assert.equal(await drainVisitOutbox(stuck.deps), 0);
  assert.equal(stuck.sent.length, 0, "a refused visit is never retried by itself");
}

function checkSignOutAndAnotherPerson(): void {
  const storage = new FakeStorage();
  keepQueuedVisit(storage, ME, entry());
  clearSignedOutDrafts(storage);
  assert.equal(readQueuedVisits(storage, ME).length, 1, "🔴 sign-out leaves it: he was told it is safe");
  assert.equal(readQueuedVisits(storage, SOMEONE_ELSE).length, 0, "and the next person on this phone sees none of it");

  // A list planted under the wrong person's key, by whatever road: the owner on the entry still decides.
  const planted = new FakeStorage();
  planted.setItem(ownerScopedStorageKey(VISIT_OUTBOX_KEY_BASE, SOMEONE_ELSE) as string, JSON.stringify([entry()]));
  assert.equal(readQueuedVisits(planted, SOMEONE_ELSE).length, 0, "an entry that names another person is never read as this one's");
}
