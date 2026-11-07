import assert from "node:assert/strict";
import { join } from "node:path";

import {
  anchorYear,
  cairoDay,
  judgeTrainTicket,
  normalizeTicketScan,
  TICKET_SCAN_GUIDANCE,
  TICKET_SCAN_NEEDS,
  TICKET_SCAN_PROBLEMS,
  ticketRefusalMessage,
  ticketScanApplies,
  type TicketDateContext,
  type TicketScanRead,
} from "../src/lib/outstation/ticket-scan-rules.ts";
import {
  checkTrainTicketsOnServer,
  readSignedTicketScan,
  signTicketScan,
  TrainTicketRefusedError,
} from "../src/lib/outstation/ticket-scan.ts";
import { stripComments } from "./support/comment-strip.ts";
import { cachedReadFile } from "./support/source-corpus.ts";

// A TRAIN TICKET IS READ WHEN IT IS ATTACHED, AND ITS DATE MUST MATCH THE TRIP'S PHOTOS (owner, 2026-11-07:
// "if someone choose that travel is train, when he capture or upload the ticket the ticket is scanned and
// date is checked in arrival or departure photo; if cannot read, not accept the ticket and tell them why" —
// and "tell him zoom in or out, centre the ticket; the system tells them what he really needs").
//
// The date rules are proved behaviourally against the pure judge; the signed note of a read is proved
// against real bytes, a real secret and a real clock; the wiring (read before anything is stored, the
// phone sending the exact bytes it read, the offline replay never lost to a refusal) is read from source.

const ROOT = process.cwd();
const RULES = "src/lib/outstation/ticket-scan-rules.ts";
const SERVER = "src/lib/outstation/ticket-scan.ts";
const SCAN_ROUTE = "app/api/outstation/ticket-scan/route.ts";
const SUBMIT_ROUTE = "app/api/outstation/submit/route.ts";
const SYNC_ROUTE = "app/api/outstation/sync-offline/route.ts";
const TICKET_ROUTE = "app/api/outstation/[id]/ticket/route.ts";
const SERVICE = "src/lib/outstation/service.ts";
const WIZARD = "src/components/outstation/mobile-outstation-wizard.tsx";
const CARD = "src/components/outstation/missing-ticket-card.tsx";
const CLIENT = "src/components/outstation/train-ticket-scan.tsx";

function code(relative: string): string {
  return stripComments(cachedReadFile(join(ROOT, relative)));
}

function functionSlice(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist - this test is pinned to it by name`);
  const next = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, next === -1 ? undefined : next);
}

const read = (travelDate: string): TicketScanRead => ({
  fromStation: "Cairo",
  status: "read",
  toStation: "Assiut",
  trainNumber: "980",
  travelDate,
});

// November: Cairo is UTC+2 (summer time ended on the last Thursday of October).
const TRIP: TicketDateContext = {
  // 00:30 Cairo on Fri 6 Nov — the arrival photo of a night train.
  arrivalAt: "2026-11-05T22:30:00.000Z",
  departureAt: null,
  tripEndDate: "2026-11-08",
  tripStartDate: "2026-11-06",
};

function dateRules() {
  assert.equal(cairoDay("2026-11-05T22:30:00.000Z"), "2026-11-06", "an arrival photo is dated by its CAIRO day, not its UTC day");
  assert.equal(cairoDay("2026-11-06"), "2026-11-06");
  assert.equal(cairoDay(""), null);

  const sameDay = judgeTrainTicket(read("2026-11-06"), TRIP);
  assert.equal(sameDay.accepted, true, "HEADLINE: a ticket dated the arrival photo's day is accepted");
  assert.equal(sameDay.accepted && sameDay.matchedTo, "arrival");
  assert.match(sameDay.accepted ? sameDay.line : "", /matches your arrival photo/);
  assert.match(sameDay.accepted ? sameDay.line : "", /Cairo to Assiut/, "the line says what was read");

  const nightTrain = judgeTrainTicket(read("2026-11-05"), TRIP);
  assert.equal(nightTrain.accepted, true, "a night train dated the day before the arrival photo is accepted");

  const tooEarly = judgeTrainTicket(read("2026-11-04"), TRIP);
  assert.equal(tooEarly.accepted, false, "HEADLINE: a ticket two days before the arrival photo is refused");
  assert.match(!tooEarly.accepted ? tooEarly.reason : "", /dated Wed, 4 Nov 2026/, "the refusal names the ticket's own date");
  assert.match(!tooEarly.accepted ? tooEarly.reason : "", /your arrival photo/, "and the photo it was checked against");

  const returnLeg = judgeTrainTicket(read("2026-11-08"), TRIP);
  assert.equal(returnLeg.accepted && returnLeg.matchedTo, "departure", "before the departure photo, the trip's last day stands in for it");
  assert.match(returnLeg.accepted ? returnLeg.line : "", /the trip's last day/);

  const withDeparture = { ...TRIP, departureAt: "2026-11-09T06:00:00.000Z" };
  assert.equal(judgeTrainTicket(read("2026-11-09"), withDeparture).accepted, true, "the departure photo's own day is the return day");
  assert.equal(judgeTrainTicket(read("2026-11-08"), withDeparture).accepted, false, "and once it exists, the planned last day no longer stands in");
  assert.equal(judgeTrainTicket(read("2026-11-07"), withDeparture).accepted, false, "and a mid-trip day no longer stands in either");

  // Claim 338 (owner, 2026-11-07: "the second photo is 3/11, which is the departure date"): arrival on Mon
  // 2 Nov, no departure photo yet, the trip ends Wed 4 Nov, and the onward ticket is dated Tue 3 Nov.
  const claim338 = { arrivalAt: "2026-11-02T19:52:00.000Z", departureAt: null, tripEndDate: "2026-11-04", tripStartDate: "2026-11-02" };
  const onward = judgeTrainTicket(read("2026-11-03"), claim338);
  assert.equal(onward.accepted && onward.matchedTo, "departure", "HEADLINE: before the departure photo, any day of the trip is a departure day");
  assert.match(onward.accepted ? onward.line : "", /a day of this trip, before the trip's last day/);
  assert.equal(judgeTrainTicket(read("2026-11-05"), claim338).accepted, false, "a day after the trip's last day is still refused");
  const late = judgeTrainTicket(read("2026-11-06"), claim338);
  assert.match(!late.accepted ? late.reason : "", /any day from Tue, 3 Nov 2026 to Wed, 4 Nov 2026/, "the refusal names the whole window");

  const noPhoto = { ...TRIP, arrivalAt: null };
  const firstDay = judgeTrainTicket(read("2026-11-06"), noPhoto);
  assert.equal(firstDay.accepted, true, "with no arrival photo, the trip's first day stands in for it");
  assert.match(firstDay.accepted ? firstDay.line : "", /the trip's first day/);

  const unreadable = judgeTrainTicket({ problems: ["too_far", "cut_off"], status: "unreadable" }, TRIP);
  assert.equal(unreadable.accepted, false, "HEADLINE: a ticket whose date cannot be read is refused");
  assert.match(!unreadable.accepted ? unreadable.reason : "", /could not read the travel date/, "and says why");
  assert.deepEqual(
    !unreadable.accepted ? unreadable.guidance : [],
    [TICKET_SCAN_GUIDANCE.too_far, TICKET_SCAN_GUIDANCE.cut_off],
    "HEADLINE: it says what to change in the photo, one instruction per problem, in order",
  );
  assert.match(TICKET_SCAN_GUIDANCE.too_far, /Zoom in/);
  assert.match(TICKET_SCAN_GUIDANCE.too_close, /Zoom out/);
  assert.match(TICKET_SCAN_GUIDANCE.cut_off, /Centre the ticket/);
  for (const problem of TICKET_SCAN_PROBLEMS) assert.ok(TICKET_SCAN_GUIDANCE[problem], `${problem} has its instruction`);

  const notTicket = judgeTrainTicket({ problems: ["not_a_ticket"], status: "unreadable" }, TRIP);
  assert.match(!notTicket.accepted ? notTicket.reason : "", /not a ticket the system can read/);

  const outage = judgeTrainTicket({ status: "unavailable" }, TRIP);
  assert.equal(outage.accepted, true, "an employee is never refused for the reader's own outage");
  assert.equal(outage.accepted && outage.matchedTo, "not_read", "the ticket is kept, marked not read");

  assert.ok(!unreadable.accepted);
  const message = ticketRefusalMessage(unreadable);
  assert.ok(message.startsWith("Not accepted:"), "the refusal starts with why");
  assert.ok(message.includes(TICKET_SCAN_GUIDANCE.too_far) && message.endsWith(TICKET_SCAN_NEEDS), "then what to do, then what the system needs");
  assert.match(TICKET_SCAN_NEEDS, /travel date/);

  assert.equal(ticketScanApplies("train"), true);
  assert.equal(ticketScanApplies("Train"), true);
  assert.equal(ticketScanApplies("bus"), true, "a bus ticket is read too — the owner chose \"Read every ticket\" (2026-11-07)");
  assert.equal(ticketScanApplies("no_ticket"), false, "a No-ticket trip carries no ticket — it is paid the fixed fare");
  assert.equal(ticketScanApplies("car"), false);
}

function normalizing() {
  assert.deepEqual(
    normalizeTicketScan({ from_station: "Cairo", is_train_ticket: true, problems: [], to_station: "", train_number: null, travel_date: "2026-11-06" }),
    { fromStation: "Cairo", status: "read", toStation: null, trainNumber: null, travelDate: "2026-11-06" },
  );
  assert.equal(normalizeTicketScan({ is_train_ticket: true, problems: [], travel_date: "2026-02-30" }).status, "unreadable", "an impossible date is never a read");
  assert.equal(normalizeTicketScan({ is_train_ticket: true, problems: [], travel_date: "6/11/2026" }).status, "unreadable", "only YYYY-MM-DD is a date");
  assert.deepEqual(
    normalizeTicketScan({ is_train_ticket: true, problems: ["blurry", "made_up", "blurry"], travel_date: null }),
    { problems: ["blurry"], status: "unreadable" },
    "problems come only from the known list, once each",
  );
  assert.deepEqual(
    normalizeTicketScan({ is_train_ticket: true, problems: [], travel_date: null }),
    { problems: ["date_hidden"], status: "unreadable" },
    "an unread date always names a problem",
  );
  assert.deepEqual(
    normalizeTicketScan({ is_train_ticket: false, problems: ["dark"], travel_date: "2026-11-06" }),
    { problems: ["not_a_ticket", "dark"], status: "unreadable" },
    "what is not a train ticket is never read as one, whatever date is printed on it",
  );

  // A booking app's "Monday 27 July" prints no year (the 2026-11-07 sweep: real bus bookings refused for it).
  const yearless = normalizeTicketScan({ is_train_ticket: true, problems: [], travel_date: "2000-07-27", year_printed: false });
  assert.equal(yearless.status === "read" && yearless.yearPrinted, false, "a yearless read says so");
  assert.equal(
    "yearPrinted" in normalizeTicketScan({ is_train_ticket: true, problems: [], travel_date: "2026-07-27", year_printed: true }),
    false,
    "a printed year carries no flag",
  );
  const nightBus = judgeTrainTicket(yearless, { arrivalAt: null, departureAt: null, tripEndDate: "2026-07-29", tripStartDate: "2026-07-28" });
  assert.ok(nightBus.accepted && nightBus.travelDate === "2026-07-27", "HEADLINE: a yearless ticket takes the trip's year, then is judged like any other");
  assert.equal(anchorYear("2000-12-31", "2027-01-01"), "2026-12-31", "a late-December ticket on an early-January trip is last year's");
  assert.equal(anchorYear("2000-01-01", "2026-12-31"), "2027-01-01");
  assert.equal(anchorYear("2000-02-29", "2028-03-01"), "2028-02-29", "29 Feb lands only in a year that has one");
  assert.equal(anchorYear("2000-02-29", "2026-03-01"), "2000-02-29", "with no 29 Feb within a year of the trip, the date is left unanchored and so never matches");
  const printed = normalizeTicketScan({ is_train_ticket: true, problems: [], travel_date: "2025-07-27", year_printed: true });
  assert.equal(
    judgeTrainTicket(printed, { arrivalAt: null, departureAt: null, tripEndDate: "2026-07-29", tripStartDate: "2026-07-28" }).accepted,
    false,
    "a PRINTED year is never moved — last year's ticket stays last year's",
  );
}

const ENV_NAMES = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_PROVIDER", "PHOENIX_AUTH_SECRET"] as const;

async function signedNote() {
  const saved = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  process.env.PHOENIX_AUTH_SECRET = "test-secret-for-the-train-ticket-note";
  // No AI key: a file with no note is read as unavailable, which proves the server falls back to its own read.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AI_PROVIDER;
  try {
    const bytes = Buffer.from("the exact bytes of one ticket photo");
    const scan = read("2026-11-06");
    const now = 1_800_000_000;
    const token = signTicketScan({ bytes, hrId: "B-10", nowSeconds: now, scan });
    assert.ok(token?.startsWith("ts1."), "a read comes back as a signed note");

    assert.deepEqual(readSignedTicketScan(token, { bytes, hrId: "b-10", nowSeconds: now + 60 }), scan, "the note carries the read for its own bytes and employee");
    assert.equal(readSignedTicketScan(token, { bytes: Buffer.from("other bytes"), hrId: "B-10", nowSeconds: now }), null, "HEADLINE: a note is refused for any other file");
    assert.equal(readSignedTicketScan(token, { bytes, hrId: "B-11", nowSeconds: now }), null, "HEADLINE: and for any other employee");
    assert.equal(readSignedTicketScan(token, { bytes, hrId: "B-10", nowSeconds: now + 24 * 60 * 60 + 1 }), null, "a note expires after a day");
    const [prefix, body, signature] = String(token).split(".");
    const edited = { ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), scan: read("2026-01-01") };
    const forged = Buffer.from(JSON.stringify(edited)).toString("base64url");
    assert.equal(readSignedTicketScan(`${prefix}.${forged}.${signature}`, { bytes, hrId: "B-10", nowSeconds: now }), null, "HEADLINE: a note whose read was edited on the phone is refused");
    assert.equal(readSignedTicketScan("not a note", { bytes, hrId: "B-10" }), null);

    const wrongDay = signTicketScan({ bytes, hrId: "B-10", scan: read("2026-11-04") }) ?? undefined;
    const rightDay = signTicketScan({ bytes, hrId: "B-10", scan }) ?? undefined;
    const ticket = (scanToken: string | undefined, fileBytes = bytes) => ({ bytes: fileBytes, contentType: "image/jpeg", fileName: "t.jpg", scanToken, size: fileBytes.length });

    await assert.rejects(
      () => checkTrainTicketsOnServer({ context: TRIP, hrId: "B-10", tickets: [ticket(wrongDay)] }),
      (error: unknown) => error instanceof TrainTicketRefusedError && /dated Wed, 4 Nov 2026/.test(error.message),
      "HEADLINE: the server judges the date itself and refuses the wrong day, with the reason",
    );
    await assert.rejects(
      () => checkTrainTicketsOnServer({ context: TRIP, hrId: "B-10", tickets: [ticket(rightDay), ticket(wrongDay)] }),
      (error: unknown) => error instanceof TrainTicketRefusedError && error.message.startsWith("Ticket 2: "),
      "with several tickets the refusal says which one",
    );
    const records = await checkTrainTicketsOnServer({
      context: TRIP,
      hrId: "B-10",
      tickets: [ticket(rightDay), ticket(undefined, Buffer.from("a file with no note"))],
    });
    assert.equal(records[0]?.matchedTo, "arrival");
    assert.equal(records[0]?.travelDate, "2026-11-06", "the read is kept on the ticket for the approver");
    assert.equal(records[1]?.matchedTo, "not_read", "a file with no note is read again on the server, and an outage keeps it");

    delete process.env.PHOENIX_AUTH_SECRET;
    assert.equal(signTicketScan({ bytes, hrId: "B-10", scan }), null, "with no secret there is no note, so the server reads the file itself");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function wiring() {
  const server = code(SERVER);
  assert.match(server, /createOpenAiResponseText\(/, "the read goes through the one door");
  assert.match(server, /if \(!hasAiApiKey\(\)\) return \{ status: "unavailable" \}/);
  // What the 2026-11-07 sweep of the 96 tickets on file taught the reader.
  assert.match(server, /print the travel date twice/, "a railway ticket's two copies of the date: either clear copy is a read");
  assert.match(server, /Read whichever copy is clear/);
  assert.match(server, /'Issued' \(صادر\)[\s\S]{0,200}تاريخ إصدار الحجز/, "the issue or booking date is never the travel date");
  assert.match(server, /required: \[[^\]]*"year_printed"/, "every read says whether the year was printed");
  assert.match(
    server,
    /readSignedTicketScan\(ticket\.scanToken, \{ bytes: ticket\.bytes, hrId: input\.hrId \}\) \?\? \(await readTrainTicket\(ticket\)\)/,
    "HEADLINE: the phone is never trusted — with no valid note the server reads the file again",
  );

  const route = code(SCAN_ROUTE);
  assert.match(route, /assertSameOriginMutation\(request\)/);
  assert.match(route, /assertPermission\(access, "outstation", "create"\)/);
  assert.match(route, /normalizeHrIdForAccess\(claim\.employeeHrId\) !== hrId[\s\S]*status: 403/, "a late upload is judged only against the caller's OWN claim");
  assert.match(route, /departureAt: claim\.departureCapturedAt/);
  assert.doesNotMatch(route, /uploadOutstation|\.insert\(|\.update\(/, "the read route stores nothing");

  const service = code(SERVICE);
  const submit = functionSlice(service, "export async function submitOutstationRequest(");
  const check = submit.indexOf("checkTrainTicketsOnServer(");
  assert.ok(check !== -1, "HEADLINE: a submitted train ticket is checked on the server");
  assert.ok(check < submit.indexOf("assertOutstationExpenseWorkflowTransition("), "before the claim moves");
  assert.ok(check < submit.indexOf("uploadOutstationTicketAttachments("), "and before any file is stored");
  assert.match(submit, /ticketScanApplies\(calculation\.transportationType\)/, "train only, by the server's own transport");
  assert.match(submit, /options\.dropRefusedTrainTickets && error instanceof TrainTicketRefusedError/);
  assert.match(submit, /const ticketAttachmentInputs = receivedTicketAttachments;/, "a dropped ticket is never stored or counted");
  assert.match(
    functionSlice(service, "export async function syncOfflineOutstationRequest("),
    /\{ \.\.\.options, dropRefusedTrainTickets: true \}/,
    "HEADLINE: an offline replay is never lost to a refused ticket — the claim lands, held for its ticket",
  );
  const attach = functionSlice(service, "export async function attachMissingTicketsToOwnOutstationRequest(");
  assert.match(attach, /departureAt: existing\.departureCapturedAt/, "a late ticket is checked against the departure photo too");
  assert.ok(attach.indexOf("checkTrainTicketsOnServer(") < attach.indexOf("uploadOutstationTicketAttachments("));

  for (const file of [SUBMIT_ROUTE, SYNC_ROUTE, TICKET_ROUTE]) {
    assert.match(code(file), /scanToken: typeof entry\.scanToken === "string" \? entry\.scanToken : undefined/, `${file} passes the note on`);
  }
  for (const file of [SUBMIT_ROUTE, TICKET_ROUTE]) {
    assert.match(code(file), /error instanceof TrainTicketRefusedError( \|\| error instanceof NoTicketFareUnavailableError)?\)\s*(\{\s*)?return 400/, `${file} answers a refusal 400 with its reason`);
  }

  const wizard = code(WIZARD);
  assert.match(wizard, /if \(isTrainTicketScan\) void readTrainTickets\(accepted\)/, "HEADLINE: the wizard reads a train ticket the moment it is picked");
  assert.match(wizard, /arrivalAt: carEvidence\?\.capturedAt \?\? null,/, "and judges it against the arrival photo");
  assert.match(wizard, /\[carEvidence\?\.capturedAt, trainTicketPicks, tripEndDate, tripStartDate\]/, "again whenever the photo or the days change");
  assert.match(wizard, /const ticketFiles = isTrainTicketScan \? trainTicketJudgement\.acceptedFiles : pickedTicketFiles;/, "only accepted train tickets count");
  assert.match(wizard, /trainTicketJudgement\.accepted\.map\(\(\{ ticket \}\) => \(\{\s*dataUrl: ticket\.dataUrl,/, "and the exact bytes that were read are sent");
  assert.match(wizard, /scanToken: ticket\.scanToken/);
  assert.match(wizard, /if \(isReadingTickets\) \{\s*setMessage\("The ticket is still being read/, "no submit while a read is running");
  assert.match(
    wizard,
    /<TicketScanNotices accepted=\{trainTicketJudgement\.accepted\} refused=\{trainTicketJudgement\.refused\} \/>/,
    "the reason and the guidance are on the screen",
  );

  const card = code(CARD);
  assert.match(card, /scanTrainTicket\(ticket, \{ requestId: request\.id \}\)/, "the late upload reads against the claim's own photos");
  assert.match(card, /acceptedTickets\.map\(\(\{ ticket \}\) => \(\{ dataUrl: ticket\.dataUrl, name: ticket\.name, scanToken:/);
  assert.match(card, /<TicketScanNotices accepted=\{acceptedTickets\} refused=\{refusedTickets\} \/>/);

  const client = code(CLIENT);
  assert.match(client, /verdict\.guidance\.map/, "every instruction is shown");
  assert.match(client, /\{TICKET_SCAN_NEEDS\}/, "and what the system needs");

  for (const file of [RULES, CLIENT, CARD]) {
    const strings = code(file).match(/"[^"\n]*"|`[^`]*`|>[^<>{}\n]+</g) ?? [];
    for (const text of strings) {
      assert.doesNotMatch(text, /\b(AI|GPT|OpenAI|ChatGPT)\b/, `${file}: the employee never reads that the ticket is read by a model — ${text}`);
    }
  }
}

export async function runOutstationTrainTicketScanTests() {
  dateRules();
  normalizing();
  await signedNote();
  wiring();
}
