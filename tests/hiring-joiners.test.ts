import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HiringJoinerInputError,
  joinerPapersProgress,
  parseHiringJoinerUpdate,
  upcomingJoinerOffers,
} from "../src/lib/hiring-documents/joiners-logic.ts";
import type { HiringDocumentDefinition, HiringDocumentEmployeeRow } from "../src/lib/hiring-documents/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE JOINERS PANEL ON HIRING DOCUMENTS (owner, 2026-11-02: "Contact the joiner, confirm papers and
 * attendance time"). Who counts as arriving, what a save may hold, how far the papers have come, and
 * that the read carries no money, because the salary-blind seat reads it.
 */

const OFFER_ID = "11111111-1111-4111-8111-111111111111";
const TODAY = "2026-11-02";

function offer(id: string, startDate: string | null, overrides: Record<string, unknown> = {}) {
  return { employeeHrId: null, id, name: id, startDate, status: "accepted", ...overrides };
}

function testWhoCountsAsArriving() {
  const rows = [
    offer("letter-text-upcoming", "25 November 2026"),
    offer("letter-iso-today", TODAY),
    offer("letter-yesterday", "01 November 2026"),
    // No readable date and no record yet: kept, first, so a real joiner is never hidden.
    offer("no-date", null),
    offer("slash-date", "1/11/2026"),
    // No readable date but a record exists: that person has already joined the system, not listed.
    offer("no-date-with-record", null, { employeeHrId: "B-9003" }),
    offer("not-accepted", "25 November 2026", { status: "sent" }),
    // The record's hire date beats the letter, both ways.
    offer("moved-later", "01 October 2026", { employeeHrId: "B-9001" }),
    offer("moved-earlier", "30 November 2026", { employeeHrId: "B-9002" }),
  ];
  const upcoming = upcomingJoinerOffers(rows, {
    hireDateByHrId: new Map([
      // Keyed by canonicalHrIdKey, as the service builds it.
      ["b-9001", "2026-11-10"],
      ["b-9002", "2026-10-20"],
    ]),
    todayKey: TODAY,
  });
  assert.deepEqual(
    upcoming.map(({ offer: row, startKey }) => [row.id, startKey]),
    [
      ["no-date", ""],
      ["slash-date", ""],
      ["letter-iso-today", TODAY],
      ["moved-later", "2026-11-10"],
      ["letter-text-upcoming", "2026-11-25"],
    ],
    "accepted only, unreadable dates first, then from today on, nearest first, the record's date winning, free-text letter dates read",
  );
}

function refuses(payload: unknown, message: RegExp) {
  assert.throws(
    () => parseHiringJoinerUpdate(payload),
    (error: unknown) => error instanceof HiringJoinerInputError && message.test(error.message),
    `refused with ${message}`,
  );
}

function testWhatASaveMayHold() {
  const whole = { attendanceDate: "2026-11-10", attendanceTime: "09:30", notes: "  Bring originals  ", offerId: OFFER_ID, papersConfirmed: true };
  assert.deepEqual(
    parseHiringJoinerUpdate(whole),
    { attendanceDate: "2026-11-10", attendanceTime: "09:30", notes: "Bring originals", offerId: OFFER_ID, papersConfirmed: true },
    "a whole save passes, trimmed",
  );
  assert.deepEqual(
    parseHiringJoinerUpdate({ attendanceDate: null, attendanceTime: "", notes: null, offerId: OFFER_ID, papersConfirmed: false }),
    { attendanceDate: null, attendanceTime: null, notes: null, offerId: OFFER_ID, papersConfirmed: false },
    "null and empty clear a field",
  );

  refuses({ ...whole, offerId: "not-a-uuid" }, /joiner/);
  refuses({ ...whole, papersConfirmed: "yes" }, /papers/);
  refuses({ ...whole, attendanceDate: "10 November 2026" }, /real date/);
  refuses({ ...whole, attendanceDate: "2026-02-31" }, /real date/);
  refuses({ ...whole, attendanceTime: "25:00" }, /time of day/);
  refuses({ ...whole, attendanceTime: "9:30" }, /time of day/);
  refuses({ ...whole, notes: "x".repeat(1001) }, /note/i);

  // A field left out must never read as "clear it": the save replaces the row.
  for (const missing of ["attendanceDate", "attendanceTime", "notes"]) {
    const { [missing as keyof typeof whole]: _gone, ...rest } = whole;
    refuses(rest, /required/);
  }
}

function testHowFarThePapersHaveCome() {
  const definition = (id: string, isExitDocument = false) =>
    ({ documentGroup: "required", id, isExitDocument, name: id }) as unknown as HiringDocumentDefinition;
  const employee = {
    documents: {
      in: { status: "submitted" },
      missing: { status: "missing" },
    },
    employmentStatus: "active",
  } as unknown as HiringDocumentEmployeeRow;

  assert.deepEqual(
    joinerPapersProgress([definition("in"), definition("missing"), definition("untouched"), definition("exit", true)], employee),
    { firstOutstandingId: "missing", received: 1, total: 3 },
    "an exit document does not count against a joiner, and an untouched paper is outstanding",
  );
  assert.deepEqual(
    joinerPapersProgress([definition("in")], employee),
    { firstOutstandingId: null, received: 1, total: 1 },
    "nothing outstanding, nowhere to open",
  );
}

function testTheReadCarriesNoMoneyAndTheWriteIsGated() {
  const service = stripComments(readFileSync("src/lib/hiring-documents/joiners.ts", "utf8"));
  const selects = [...service.matchAll(/\.select\(([^)]*)\)/g)].map((match) => match[1]);
  assert.ok(selects.length >= 5, `only ${selects.length} reads found: the pattern stopped matching`);
  const columns = /const OFFER_COLUMNS =\s*"([^"]+)"/.exec(service)?.[1] ?? "";
  assert.ok(columns.includes("candidate_name"), "the offer columns were read");
  for (const text of [columns, ...selects]) {
    assert.ok(!text.includes("*"), `no read takes every column: ${text}`);
    for (const money of ["total_monthly", "cost_of_living", "template_snapshot"]) {
      assert.ok(!text.includes(money), `${money} must never reach this panel`);
    }
  }
  assert.ok(service.includes("writeRequiredAuditLog({"), "every save leaves an audit row");
  assert.ok(service.includes('offer.status !== "accepted"'), "a save only lands on an accepted offer");

  const route = stripComments(readFileSync("app/api/hiring-documents/joiners/route.ts", "utf8"));
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PATCH"));
  const patch = route.slice(route.indexOf("export async function PATCH"));
  assert.ok(
    get.indexOf('assertPermission(access, "employee_documents", "read")') < get.indexOf("getHiringJoiners()") &&
      get.includes('assertPermission(access, "employee_documents", "read")'),
    "the read is gated before anything is read",
  );
  assert.ok(patch.includes("assertSameOriginMutation(request)"), "the write checks its origin");
  assert.ok(
    patch.includes('assertPermission(access, "employee_documents", "update")') &&
      patch.indexOf('assertPermission(access, "employee_documents", "update")') < patch.indexOf("saveHiringJoinerContact("),
    "the write is gated before anything is written",
  );

  const migration = readFileSync("supabase/migrations/20261102120000_hiring_joiner_contacts.sql", "utf8");
  assert.ok(migration.includes("enable row level security"), "row level security is on");
  assert.ok(migration.includes("from public, anon, authenticated"), "nobody but the service role reads it");
  assert.ok(/attendance_time time without time zone/.test(migration), "an agreed time carries no zone that could move it");

  const panel = stripComments(readFileSync("src/components/hiring-documents/hiring-joiners-panel.tsx", "utf8"));
  assert.ok(panel.includes('className="w-full table-fixed'), "the table fits its width");
  assert.ok(panel.includes("The joiners list could not be read"), "a failed read says so");
  assert.ok(panel.includes("href={`tel:${joiner.mobile}`}"), "contact opens the viewer's own phone");
  const manager = readFileSync("src/components/hiring-documents/hiring-documents-manager.tsx", "utf8");
  assert.ok(manager.includes("<HiringJoinersPanel"), "the panel is on the screen");
}

export function runHiringJoinersTests() {
  testWhoCountsAsArriving();
  testWhatASaveMayHold();
  testHowFarThePapersHaveCome();
  testTheReadCarriesNoMoneyAndTheWriteIsGated();
}
