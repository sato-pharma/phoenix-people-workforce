import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { formatPhoenixDateTime } from "../src/lib/i18n/format.ts";
import {
  enforcePhoenixCrmEmailBlock,
  PHOENIX_CRM_EMAIL_EVENT_TYPES,
  phoenixCrmChannels,
} from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { firstVisitDeliveries } from "../src/lib/phoenix-crm/server/notifications.ts";

/**
 * Phoenix CRM — a rep's FIRST visit tells three people (owner, 2026-10-03).
 *
 * His words: "every rep submits a visit on Phoenix CRM — only the first visit for each medical rep —
 * his district manager, his national sales manager and the SFE, goes to them an email, and Omar in the
 * BCC. Example: Aya Ibrahim submitted her first visit at the account and its name, and the time the
 * visit was submitted in."
 *
 * What this file pins:
 *   1. the three recipients, resolved from the organogram — the territory's reviewing manager (his
 *      district manager, and the seat above where a district is vacant), the NSM seat of his line, and
 *      the SFE Managers, who hold a ROLE with no seat;
 *   2. that the REP is never on it, even when he also sits on a manager seat (an acting district
 *      manager holds both) — Golden Rule #1: his app never tells him he is being watched begin;
 *   3. the words: the rep's name, the account's name, his territory, and the time the visit was
 *      submitted in Cairo local, off the SERVER's own stamp;
 *   4. ONE per rep ever — the idempotency key is the REP, not the visit, so a retried save or a second
 *      reading of "this is his first" reaches nobody twice;
 *   5. that it really does email: the event type is on the guard's allowlist and its policy row asks
 *      for email, which is the pair tests/phoenix-crm-email-block.test.ts holds to exactly five;
 *   6. the save-side gate — only a visit the REP HIMSELF submitted, never a repeat save, and a failed
 *      read answers NO, because an email announcing a first visit cannot be taken back.
 */

// ── The organogram the recipients are resolved from ──────────────────────────────────────────────

function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat {
  return {
    parentSeatId: overrides.path.length > 1 ? overrides.path[overrides.path.length - 2] : null,
    occupantHrId: null,
    lineCode: "pedia",
    lineName: "Pedia",
    areaName: null,
    regionName: null,
    seatLabel: null,
    ...overrides,
  };
}

const CEO = seat({ seatId: "SEAT-CEO", tier: "CEO", path: ["SEAT-CEO"], occupantHrId: "B-2", lineCode: null, lineName: null });
const NSM = seat({ seatId: "SEAT-PED-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-PED-NSM"], occupantHrId: "A-12" });
const DM1 = seat({ seatId: "SEAT-PED-DM-D1", tier: "DM", path: [...NSM.path, "SEAT-PED-DM-D1"], occupantHrId: "B-40", regionName: "Delta (1)" });
const REP1 = seat({ seatId: "SEAT-PED-REP-D11", tier: "REP", path: [...DM1.path, "SEAT-PED-REP-D11"], occupantHrId: "B-7", areaName: "Tanta", regionName: "Delta (1)" });
// A regional manager between the district and the national one, as Pedia's Upper Egypt really has.
const RSM = seat({ seatId: "SEAT-PED-RSM-UE", tier: "RSM", path: [...NSM.path, "SEAT-PED-RSM-UE"], occupantHrId: "B-60", regionName: "Upper Egypt" });
const DMU = seat({ seatId: "SEAT-PED-DM-UE1", tier: "DM", path: [...RSM.path, "SEAT-PED-DM-UE1"], occupantHrId: "B-61", regionName: "Upper Egypt 1" });
const REPU = seat({ seatId: "SEAT-PED-REP-UE11", tier: "REP", path: [...DMU.path, "SEAT-PED-REP-UE11"], occupantHrId: "B-62", areaName: "Minia 1", regionName: "Upper Egypt 1" });
// A vacant district — the shape Cairo Pedia's district seat has today, on purpose.
const DMV = seat({ seatId: "SEAT-PED-DM-GZ", tier: "DM", path: [...NSM.path, "SEAT-PED-DM-GZ"], occupantHrId: null, regionName: "Giza" });
const REPV = seat({ seatId: "SEAT-PED-REP-GZ11", tier: "REP", path: [...DMV.path, "SEAT-PED-REP-GZ11"], occupantHrId: "B-80", areaName: "Dokki", regionName: "Giza" });
// The acting district manager, as production holds one: his acting seat, and his own rep seat UNDER it.
const ADM = seat({ seatId: "SEAT-PED-ADM-D2", tier: "ACTING_DM", path: [...NSM.path, "SEAT-PED-ADM-D2"], occupantHrId: "B-1", regionName: "Delta (2)" });
const REPA = seat({ seatId: "SEAT-PED-REP-D21", tier: "REP", path: [...ADM.path, "SEAT-PED-REP-D21"], occupantHrId: "B-1", areaName: "Mansoura", regionName: "Delta (2)" });
// A line whose whole chain is vacant: the SFE Managers are then the only people told.
const CNS_NSM = seat({ seatId: "SEAT-CNS-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-CNS-NSM"], occupantHrId: null, lineCode: "cns", lineName: "CNS" });
const CNS_DM = seat({ seatId: "SEAT-CNS-DM-C1", tier: "DM", path: [...CNS_NSM.path, "SEAT-CNS-DM-C1"], occupantHrId: null, lineCode: "cns", lineName: "CNS" });
const REPC = seat({
  seatId: "SEAT-CNS-REP-K11",
  tier: "REP",
  path: [...CNS_DM.path, "SEAT-CNS-REP-K11"],
  occupantHrId: "B-121",
  lineCode: "cns",
  lineName: "CNS",
  areaName: "Heliopolis",
});

const org = buildOrgIndex([CEO, NSM, DM1, REP1, RSM, DMU, REPU, DMV, REPV, ADM, REPA, CNS_NSM, CNS_DM, REPC]);

const SFE = ["B-150", "B-151"];

const NAMES = new Map([
  ["B-7", "Aya Ibrahim"],
  ["B-62", "Mohamed Sami"],
  ["B-80", "Nour Hassan"],
  ["B-1", "Omar Sabry"],
  ["B-121", "Kareem Adel"],
]);

/** 19:42 Cairo (16:42Z) on Saturday 3 October 2026 — the day Delta (1) starts on the module. */
const CAPTURED_AT = "2026-10-03T16:42:11.000Z";

function notice(repSeat: OrgSeat, repHrId: string, customerName = "Dr Hani Farouk") {
  return {
    kind: "first_visit" as const,
    org,
    seat: repSeat,
    visitId: "8f1b2c3d-0000-4000-8000-00000000abcd",
    repHrId,
    customerName,
    capturedAt: CAPTURED_AT,
  };
}

export function runPhoenixCrmFirstVisitTests() {
  // ── 1 · the three recipients ──────────────────────────────────────────────────────────────────
  {
    const [delivery] = firstVisitDeliveries(notice(REP1, "B-7"), NAMES, SFE);
    assert.ok(delivery, "a rep with a district manager, a national manager and an SFE Manager tells somebody");
    assert.deepEqual(
      delivery.recipients,
      ["B-40", "A-12", "B-150", "B-151"],
      "his district manager, then his national sales manager, then the SFE Managers — the owner's three, in his order",
    );
    assert.equal(delivery.eventType, "first_visit_submitted");
    assert.equal(delivery.tab, "team", "it opens the Team tab, where a manager reads his people");
    assert.equal(delivery.subjectHrId, "B-7", "the notice is ABOUT the rep, which is what names him on the row");
  }

  {
    // A regional manager sits between: the DISTRICT manager is still the nearest, and the NSM is still
    // found above the RSM. The RSM himself is NOT told — the owner named three people, not four.
    const [delivery] = firstVisitDeliveries(notice(REPU, "B-62"), NAMES, SFE);
    assert.deepEqual(
      delivery.recipients,
      ["B-61", "A-12", "B-150", "B-151"],
      "the district manager and the national manager, never the regional manager in between",
    );
  }

  {
    // 🔴 A VACANT DISTRICT PASSES UPWARD, exactly as a grade request and a weekly plan do. The nearest
    // OCCUPIED manager is the national one, so he is the "district manager" of this notice and appears
    // once, not twice.
    const [delivery] = firstVisitDeliveries(notice(REPV, "B-80"), NAMES, SFE);
    assert.deepEqual(delivery.recipients, ["A-12", "B-150", "B-151"], "a vacant district leaves the national manager and SFE, and nobody doubled");
  }

  {
    // A whole vacant chain: the SFE Managers are the only people left, and the notice still goes.
    const [delivery] = firstVisitDeliveries(notice(REPC, "B-121"), NAMES, SFE);
    assert.deepEqual(delivery.recipients, ["B-150", "B-151"], "a line with no manager in a seat still tells SFE");
    assert.deepEqual(firstVisitDeliveries(notice(REPC, "B-121"), NAMES, []), [], "and with no SFE Manager either, it tells nobody rather than inventing a recipient");
  }

  // ── 2 · never the rep ─────────────────────────────────────────────────────────────────────────
  {
    // The acting district manager holds his own rep seat UNDER his acting seat, so the chain's nearest
    // manager IS him. He must not be told about his own first visit (Golden Rule #1).
    const [delivery] = firstVisitDeliveries(notice(REPA, "B-1"), NAMES, SFE);
    assert.deepEqual(delivery.recipients, ["A-12", "B-150", "B-151"], "the acting district manager is not told of his own first visit");
    assert.equal(delivery.recipients.includes("B-1"), false, "the one person the notice is about never reads it");
  }

  {
    // The same, from the other side: an SFE Manager who is also the rep is dropped, not addressed.
    const [delivery] = firstVisitDeliveries(notice(REP1, "B-7"), NAMES, ["B-7", "B-150"]);
    assert.deepEqual(delivery.recipients, ["B-40", "A-12", "B-150"], "a rep who holds the SFE role is still never told");
  }

  // ── 3 · the words ────────────────────────────────────────────────────────────────────────────
  {
    const [delivery] = firstVisitDeliveries(notice(REP1, "B-7", "Dr Hani Farouk"), NAMES, SFE);
    assert.equal(delivery.title, "First Phoenix CRM visit: Aya Ibrahim", "the title names the rep, as his example does");
    assert.match(delivery.message, /^Aya Ibrahim submitted a first visit on Phoenix CRM: Dr Hani Farouk, /, "the rep's name and the account's name");
    assert.match(delivery.message, /Tanta/, "and his territory");
    // The time the visit was submitted in — Cairo local, from the SERVER's stamp, never the phone's.
    assert.equal(formatPhoenixDateTime(CAPTURED_AT), "7:42 PM, Saturday, 3 October 2026");
    assert.match(delivery.message, /at 7:42 PM, Saturday, 3 October 2026 \(Cairo\)\./, "the time it was submitted in, in Cairo local");
    assert.match(delivery.message, /nothing waits on you\./, "and it says plainly that nobody has to act");
    assert.doesNotMatch(delivery.message, /\bB-7\b/, "names, never HR codes (owner rule)");
    assert.doesNotMatch(delivery.title, /\bB-7\b/);
    // A rep with no employee row still produces a sendable notice rather than an empty name.
    const [unnamed] = firstVisitDeliveries(notice(REP1, "B-7"), new Map(), SFE);
    assert.match(unnamed.title, /^First Phoenix CRM visit: A rep$/);
  }

  // ── 4 · ONE per rep, ever ────────────────────────────────────────────────────────────────────
  {
    const [first] = firstVisitDeliveries(notice(REP1, "B-7"), NAMES, SFE);
    assert.equal(first.idempotencyKey, "phoenix_crm:first_visit:B-7", "the key is the REP — not the visit, not the day, not the version");
    assert.equal(first.idempotencyKey.includes(first.recordId), false, "a second visit of his would reuse the same key, which is the whole point");
    // The same rep, written the way a phone or an older row might: the key does not move.
    const [again] = firstVisitDeliveries({ ...notice(REP1, "B-7"), repHrId: "b-7", visitId: "11111111-0000-4000-8000-000000000001" }, NAMES, SFE);
    assert.equal(again.idempotencyKey, "phoenix_crm:first_visit:B-7", "the key is normalised, so a lower-case hr id cannot send a second email");
    // And it is a DIFFERENT rep's key for a different rep.
    const [other] = firstVisitDeliveries(notice(REPU, "B-62"), NAMES, SFE);
    assert.notEqual(other.idempotencyKey, first.idempotencyKey);
  }

  // ── 5 · it really does email ─────────────────────────────────────────────────────────────────
  {
    assert.equal(PHOENIX_CRM_EMAIL_EVENT_TYPES.includes("first_visit_submitted"), true, "the guard's allowlist carries it — a Phoenix CRM notice is otherwise email-free");
    assert.deepEqual(phoenixCrmChannels("first_visit_submitted"), ["in_app", "email", "telegram", "push"]);
    assert.deepEqual(
      enforcePhoenixCrmEmailBlock(["in_app", "email", "telegram"], "phoenix_crm", "first_visit_submitted"),
      ["in_app", "email", "telegram"],
      "and the guard lets its email through, where it strips every other Phoenix CRM notice's",
    );
    const policy = resolveNotificationPolicy({ module: "phoenix_crm", eventType: "first_visit_submitted" });
    for (const channel of ["in_app", "email", "telegram", "push"] as const) {
      assert.equal(policy.channels.includes(channel), true, `the policy row asks for ${channel} — the row is the intent, the guard the enforcement`);
    }
    // 🔴 The owner's BCC is NOT wired here and must never be: `sendPhoenixEmail` puts the standing admin
    // on the BCC of EVERY email the system sends, so a copy added here would be a second one.
    const notify = stripComments(readFileSync("src/lib/phoenix-crm/server/notifications.ts", "utf8"));
    assert.doesNotMatch(notify, /bcc/i, "the notifier never builds a BCC of its own — the one send chokepoint owns that");
    const send = readFileSync("src/lib/email/send-phoenix-email.ts", "utf8");
    assert.match(send, /const alwaysBcc = ADMIN_STANDING_EMAIL;/, "and that chokepoint is where the owner's copy comes from");
  }

  // ── 6 · the save-side gate ───────────────────────────────────────────────────────────────────
  {
    const visits = readFileSync("src/lib/phoenix-crm/server/visits.ts", "utf8");
    const bare = stripComments(visits);
    assert.match(
      bare,
      /if \(enteredAs === "rep" && result\.duplicate !== true && \(await isFirstVisitSubmittedBy\(viewer\.hrId, visitId, isTest\)\)\)/,
      "only a visit the REP HIMSELF submitted, never a repeat save — a manager's double visit and the Super Admin's entry for a rep are not his submission",
    );
    const gate = bare.slice(bare.indexOf("async function isFirstVisitSubmittedBy("));
    const body = gate.slice(0, gate.indexOf("\n}\n") + 2);
    assert.match(body, /\.eq\("entered_by_hr_id", actor\)/, "it asks about the person who entered it");
    assert.match(body, /\.eq\("is_test", isTest\)/, "in one world — a Super Admin trying the form out cannot consume a real rep's one-and-only first visit");
    assert.match(body, /\.neq\("id", visitId\)/, "ignoring the visit just saved, which is already in the table");
    assert.match(body, /\.limit\(1\)/, "one row is enough: ANY other row of his own means this is not the first");
    assert.match(body, /const actor = personKey\(actorHrId\);/, "asked in the shape the database stores — phoenix_crm_save_visit upper-cases the actor");
    // 🔴 A FAILED READ ANSWERS NO. An email announcing a rep's first visit cannot be taken back.
    assert.match(body, /if \(!actor\) return false;/);
    assert.match(body, /if \(error\) return false;/, "a failed read must never be read as 'yes, this is his first'");
    // The index that makes the question cheap at the ~600 visits a working day this module is built for.
    const migration = readFileSync("supabase/migrations/20261003000705_phoenix_crm_visits_entered_by_idx.sql", "utf8");
    assert.match(
      migration,
      /create index if not exists phoenix_crm_visits_entered_by_idx\s+on public\.phoenix_crm_visits \(entered_by_hr_id, captured_at\);/,
      "and the read has an index — `entered_by_hr_id` was indexed nowhere before this",
    );
    // The notice carries the SERVER's own stamp. The phone's clock dates nothing in this module.
    assert.match(bare, /capturedAt: String\(result\.captured_at\),/, "the time reported is the server's, as the save returned it");
  }
}
