import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import {
  CHOOSE_A_DAY,
  CHOOSE_A_PERSON,
  DAY_NOT_OFFERED,
  DOUBLE_VISIT_MAX_DAYS,
  DOUBLE_VISIT_QUESTION,
  PERSON_NOT_OFFERED,
  TOO_MANY_DAYS,
  doubleVisitDayChoices,
  doubleVisitPersonStatusText,
  doubleVisitSavedNote,
  doubleVisitTally,
  isDoubleVisitRequestable,
  parseDoubleVisitAnswer,
  resolveDoubleVisitDays,
  resolveDoubleVisitPeople,
  toggleDoubleVisitDay,
  toggleDoubleVisitPerson,
} from "../src/lib/phoenix-crm/double-visit-request-rules.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { doubleVisitReportAudience } from "../src/lib/phoenix-crm/server/access.ts";
import { doubleVisitRequestDeliveries } from "../src/lib/phoenix-crm/server/notifications.ts";
import { canAnswerDoubleVisit } from "../src/lib/phoenix-crm/server/double-visit-requests.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the rep's request for a double visit, asked by the LAST question of his visit.
 *
 * Owner, 2026-10-16: "the last question while rep logging a visit to an am or pm account must be: do
 * you need a double visit with this dr/account? If yes show him manager and rsm if applicable and nsm
 * and pm and gpm if applicable, and then make him able to choose up to 3 timings, make him then able
 * to edit the timing but never cancel his request. After that a new sidebar report is generated for
 * managers which pumps notifications when they receive this request, and all managers must have access
 * on this report as per their scope up to the CEO." His answers the same day: any number of the people
 * offered may be ticked, a timing is a DAY only, and a person asked accepts one day or declines.
 *
 * What this pins, in the order a break would hurt:
 *   1. NO CANCEL anywhere — no route, no function, no button, no notice step.
 *   2. The rules: one to three distinct field days, only people the rep was offered, strict parsing.
 *   3. Who is told, what, and under which key — and that no email is possible.
 *   4. Who answers, and who opens the report (every manager in his scope, up to the CEO).
 *   5. The question is the LAST thing on the form, defaults to No, and No asks nothing more.
 *   6. The sidebar row is wired everywhere a portal route must be declared.
 */
function read(path: string): string {
  return stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

function readSql(path: string): string {
  return stripSqlComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

// 17 October 2026 is a Saturday; 23 October is the Friday after it.
const TODAY = "2026-10-17";
const NO_HOLIDAYS: ReadonlyMap<string, string> = new Map();

const OFFERS = [
  { hrId: "B-158", role: "manager" as const, position: 1 },
  { hrId: "B-159", role: "manager" as const, position: 2 },
  { hrId: "B-170", role: "product_manager" as const, position: null },
];

const SEAT: OrgSeat = {
  seatId: "seat-delta-1",
  parentSeatId: null,
  tier: "DM",
  path: ["seat-delta-1"],
  occupantHrId: "B-158",
  lineCode: "pedia",
  lineName: "Pedia",
  areaName: "Delta (1)",
  regionName: null,
  seatLabel: null,
};

const NAMES = new Map([
  ["B-7", "Aya Ibrahim"],
  ["B-158", "Dina Hamdy"],
  ["B-159", "Hany Saad"],
]);

function viewer(over: Record<string, unknown>): never {
  return { basis: "line", managerSeats: [], role: "Medical Representative", isSuperAdmin: false, isTestPersona: false, hrId: "B-1", ...over } as never;
}

export function runPhoenixCrmDoubleVisitRequestsTests(): void {
  // ── 2. The days: one to three, distinct, field days, within four weeks ─────────────────────────
  assert.equal(DOUBLE_VISIT_MAX_DAYS, 3, "his words: up to 3 timings");
  assert.equal(DOUBLE_VISIT_QUESTION, "Do you need a double visit with this customer?", "the question uses the word customer, never account or doctor");
  assert.equal(isDoubleVisitRequestable("AM"), true);
  assert.equal(isDoubleVisitRequestable("PM"), true);
  assert.equal(isDoubleVisitRequestable("Pharmacy"), false, "his words: a visit to an am or pm account — a pharmacy is never asked about");
  assert.equal(isDoubleVisitRequestable(null), false);

  const choices = doubleVisitDayChoices(TODAY, NO_HOLIDAYS);
  assert.equal(choices[0], TODAY, "today is offered");
  assert.equal(choices.includes("2026-10-23"), false, "never a Friday");
  assert.equal(choices.includes("2026-11-12"), true, "the last field day inside four weeks is offered (13 November is a Friday)");
  assert.equal(choices.includes("2026-11-14"), false, "a day past the four weeks is not");

  const ok = resolveDoubleVisitDays({ days: ["2026-10-19", "2026-10-18", "2026-10-19"], cairoToday: TODAY, holidays: NO_HOLIDAYS });
  assert.deepEqual(ok, { ok: true, days: ["2026-10-18", "2026-10-19"] }, "a day tapped twice is one day, and the list comes back earliest first");
  assert.deepEqual(
    resolveDoubleVisitDays({ days: ["2026-10-17", "2026-10-18", "2026-10-19"], cairoToday: TODAY, holidays: NO_HOLIDAYS }),
    { ok: true, days: ["2026-10-17", "2026-10-18", "2026-10-19"] },
    "three days are allowed",
  );
  assert.deepEqual(
    resolveDoubleVisitDays({ days: ["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"], cairoToday: TODAY, holidays: NO_HOLIDAYS }),
    { ok: false, error: TOO_MANY_DAYS },
    "a fourth distinct day is refused",
  );
  for (const days of [undefined, null, "2026-10-18", []]) {
    assert.deepEqual(resolveDoubleVisitDays({ days, cairoToday: TODAY, holidays: NO_HOLIDAYS }), { ok: false, error: CHOOSE_A_DAY }, "no day at all is refused");
  }
  for (const day of ["2026-10-16", "2026-10-23", "2026-11-14", "not a day", 5]) {
    assert.deepEqual(
      resolveDoubleVisitDays({ days: [day], cairoToday: TODAY, holidays: NO_HOLIDAYS }),
      { ok: false, error: DAY_NOT_OFFERED },
      `${String(day)} is not a day the rep was offered`,
    );
  }
  assert.deepEqual(
    resolveDoubleVisitDays({ days: ["2026-10-19"], cairoToday: TODAY, holidays: new Map([["2026-10-19", "A public holiday"]]) }),
    { ok: false, error: DAY_NOT_OFFERED },
    "a confirmed public holiday is never a day",
  );

  assert.deepEqual(toggleDoubleVisitDay([], "2026-10-18"), ["2026-10-18"]);
  assert.deepEqual(toggleDoubleVisitDay(["2026-10-18", "2026-10-19"], "2026-10-18"), ["2026-10-19"], "ticking a ticked day un-ticks it");
  assert.deepEqual(
    toggleDoubleVisitDay(["2026-10-18", "2026-10-19", "2026-10-20"], "2026-10-21"),
    ["2026-10-18", "2026-10-19", "2026-10-20"],
    "a fourth tap changes nothing",
  );

  // ── 2. The people: only those offered, any number, none twice ──────────────────────────────────
  assert.deepEqual(resolveDoubleVisitPeople({ picked: ["B-158", "B-170"], offers: OFFERS }), {
    ok: true,
    people: [
      { hrId: "B-158", role: "manager" },
      { hrId: "B-170", role: "product_manager" },
    ],
  }, "his answer: any number he ticks, the role read from the offer and not from the phone");
  const allThree = resolveDoubleVisitPeople({ picked: ["B-158", "B-159", "B-170"], offers: OFFERS });
  assert.equal(allThree.ok && allThree.people.length, 3, "all of them may be ticked");
  const twice = resolveDoubleVisitPeople({ picked: ["B-158", "b-158"], offers: OFFERS });
  assert.equal(twice.ok && twice.people.length, 1, "the same person in two spellings is one person");
  assert.deepEqual(resolveDoubleVisitPeople({ picked: [], offers: OFFERS }), { ok: false, error: CHOOSE_A_PERSON });
  assert.deepEqual(resolveDoubleVisitPeople({ picked: undefined, offers: OFFERS }), { ok: false, error: CHOOSE_A_PERSON });
  assert.deepEqual(resolveDoubleVisitPeople({ picked: ["B-999"], offers: OFFERS }), { ok: false, error: PERSON_NOT_OFFERED }, "someone the list never offered is refused");
  assert.deepEqual(resolveDoubleVisitPeople({ picked: [7], offers: OFFERS }), { ok: false, error: PERSON_NOT_OFFERED });
  assert.deepEqual(toggleDoubleVisitPerson(["B-158"], "B-159"), ["B-158", "B-159"]);
  assert.deepEqual(toggleDoubleVisitPerson(["B-158", "B-159"], "b-158"), ["B-159"]);

  // Only a literal `wanted: true` asks for anything; every other body is "No".
  assert.deepEqual(parseDoubleVisitAnswer(undefined), { wanted: false });
  assert.deepEqual(parseDoubleVisitAnswer({ wanted: "yes", hrIds: ["B-158"], days: [TODAY] }), { wanted: false }, "a truthy string is not a yes");
  assert.deepEqual(parseDoubleVisitAnswer({ wanted: false, hrIds: ["B-158"], days: [TODAY] }), { wanted: false }, "No reads nothing else");
  assert.deepEqual(parseDoubleVisitAnswer({ wanted: true, hrIds: ["B-158"], days: [TODAY] }), { wanted: true, hrIds: ["B-158"], days: [TODAY] });

  // ── How it reads ───────────────────────────────────────────────────────────────────────────────
  assert.equal(doubleVisitPersonStatusText({ status: "waiting", name: "Dina Hamdy", visitOnText: null }), "Waiting for Dina Hamdy");
  assert.equal(doubleVisitPersonStatusText({ status: "accepted", name: "Dina Hamdy", visitOnText: "Tue 20 Oct" }), "Dina Hamdy: accepted, Tue 20 Oct");
  assert.equal(doubleVisitPersonStatusText({ status: "declined", name: "Dina Hamdy", visitOnText: null }), "Dina Hamdy: declined");
  assert.deepEqual(doubleVisitTally([{ status: "waiting" }, { status: "accepted" }, { status: "declined" }, { status: "accepted" }]), { waiting: 1, accepted: 2, declined: 1 });
  assert.equal(doubleVisitSavedNote(null), null);
  assert.match(doubleVisitSavedNote({ created: true, names: ["Dina Hamdy", "Hany Saad"] }) ?? "", /^Dina Hamdy and Hany Saad are asked for a double visit/);

  // ── 3. Who is told, what, and under which key ──────────────────────────────────────────────────
  const raised = doubleVisitRequestDeliveries(
    { kind: "double_visit_request", seat: SEAT, requestId: "req-1", step: "raised", repHrId: "B-7", askedHrIds: ["B-158", "B-159"], customerName: "Mona Adel", listType: "PM", days: ["2026-10-18", "2026-10-19"], visitOn: null, version: 0 },
    NAMES,
  );
  assert.deepEqual(raised.map((delivery) => delivery.recipients), [["B-158"], ["B-159"]], "each person asked is told on his own");
  assert.equal(raised.every((delivery) => delivery.eventType === "double_visit_waiting"), true);
  assert.equal(new Set(raised.map((delivery) => delivery.idempotencyKey)).size, 2, "and each notice has a key of its own");
  assert.match(raised[0].message, /Aya Ibrahim asks for a double visit with you/);

  const changed = doubleVisitRequestDeliveries(
    { kind: "double_visit_request", seat: SEAT, requestId: "req-1", step: "days_changed", repHrId: "B-7", askedHrIds: ["B-159"], customerName: "Mona Adel", listType: "PM", days: ["2026-10-20"], visitOn: null, version: 1 },
    NAMES,
  );
  assert.equal(changed[0].eventType, "double_visit_days_changed");
  assert.notEqual(changed[0].idempotencyKey, raised[1].idempotencyKey, "an edit is a second notice, not swallowed by the first's key");
  const changedAgain = doubleVisitRequestDeliveries(
    { kind: "double_visit_request", seat: SEAT, requestId: "req-1", step: "days_changed", repHrId: "B-7", askedHrIds: ["B-159"], customerName: "Mona Adel", listType: "PM", days: ["2026-10-21"], visitOn: null, version: 2 },
    NAMES,
  );
  assert.notEqual(changedAgain[0].idempotencyKey, changed[0].idempotencyKey, "and a second edit is a third");

  const accepted = doubleVisitRequestDeliveries(
    { kind: "double_visit_request", seat: SEAT, requestId: "req-1", step: "accepted", repHrId: "B-7", askedHrIds: ["B-158"], customerName: "Mona Adel", listType: "PM", days: ["2026-10-18"], visitOn: "2026-10-18", version: 0 },
    NAMES,
  );
  assert.deepEqual(accepted.map((delivery) => delivery.recipients), [["B-7"]], "an answer goes to the rep alone");
  assert.equal(accepted[0].eventType, "double_visit_accepted");
  assert.match(accepted[0].message, /Dina Hamdy accepted your double visit/);
  const declined = doubleVisitRequestDeliveries(
    { kind: "double_visit_request", seat: SEAT, requestId: "req-1", step: "declined", repHrId: "B-7", askedHrIds: ["B-158"], customerName: "Mona Adel", listType: "PM", days: ["2026-10-18"], visitOn: null, version: 0 },
    NAMES,
  );
  assert.equal(declined[0].eventType, "double_visit_declined");
  assert.match(declined[0].message, /Dina Hamdy declined your double visit/);

  for (const eventType of ["double_visit_waiting", "double_visit_days_changed", "double_visit_accepted", "double_visit_declined"]) {
    const policy = resolveNotificationPolicy({ module: "phoenix_crm", eventType });
    assert.equal(policy.channels.includes("email"), false, `${eventType} asks for no email — Phoenix CRM sends none`);
    for (const channel of ["in_app", "telegram", "push"] as const) assert.equal(policy.channels.includes(channel), true, `${eventType} reaches ${channel}`);
  }

  const notify = read("src/lib/phoenix-crm/server/notifications.ts");
  assert.match(notify, /export const DOUBLE_VISIT_REQUESTS_PATH = "\/employee-portals\/double-visit-requests"/, "a notice opens the report");
  assert.doesNotMatch(
    notify.slice(notify.indexOf("kind: \"double_visit_request\";"), notify.indexOf("kind: \"double_visit_request\";") + 900),
    /"cancel/,
    "the notice has no cancel step",
  );

  // ── 4. Who answers, and who opens the report ───────────────────────────────────────────────────
  assert.equal(canAnswerDoubleVisit(viewer({ hrId: "B-158" }), { askedHrId: "B-158", isTest: false }), true, "the person asked answers");
  assert.equal(canAnswerDoubleVisit(viewer({ hrId: "b-158" }), { askedHrId: "B-158", isTest: false }), true, "compared as a person, never as a raw id");
  assert.equal(canAnswerDoubleVisit(viewer({ hrId: "B-159" }), { askedHrId: "B-158", isTest: false }), false, "another manager of the same team does not");
  assert.equal(canAnswerDoubleVisit(viewer({ hrId: "B-158", isSuperAdmin: true }), { askedHrId: "B-158", isTest: false }), false, "the Super Admin decides no real entry");
  assert.equal(canAnswerDoubleVisit(viewer({ hrId: "B-158", isTestPersona: true }), { askedHrId: "B-158", isTest: false }), false, "a test login never answers a real request");

  assert.equal(doubleVisitReportAudience(viewer({ basis: "all", role: "CEO" })), "scope", "the CEO reads every territory");
  assert.equal(doubleVisitReportAudience(viewer({ basis: "all", role: "SFE Manager" })), "scope");
  assert.equal(doubleVisitReportAudience(viewer({ managerSeats: [SEAT], role: "District Manager" })), "scope", "every manager reads his scope downward");
  assert.equal(doubleVisitReportAudience(viewer({ role: "Product Manager" })), "own", "a product manager reads what is addressed to him");
  assert.equal(doubleVisitReportAudience(viewer({ role: "Group Product Manager" })), "own");
  assert.equal(doubleVisitReportAudience(viewer({ role: "Marketing Manager" })), "own");
  assert.equal(doubleVisitReportAudience(viewer({ role: "Medical Representative" })), null, "a rep reads his own on the customer's page, never the report");

  // ── 1. NO CANCEL anywhere ──────────────────────────────────────────────────────────────────────
  const routeDir = "app/api/phoenix-crm/double-visit-requests";
  assert.deepEqual(readdirSync(routeDir).sort(), ["answer", "edit", "report", "route.ts"], "the request has four doors, and none of them cancels");
  const sqlPath = readdirSync("supabase/migrations").find((name) => name.endsWith("_phoenix_crm_double_visit_requests.sql"));
  assert.ok(sqlPath, "the migration exists");
  const sql = readSql(`supabase/migrations/${sqlPath}`);
  assert.doesNotMatch(sql, /create (or replace )?function [^(]*cancel/i, "no cancel function in the database");
  assert.doesNotMatch(sql, /'cancelled'|"cancelled"/i, "and no cancelled state a person could be put into");
  for (const fn of ["phoenix_crm_raise_double_visit_request", "phoenix_crm_edit_double_visit_request_days", "phoenix_crm_answer_double_visit_request"]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(p jsonb\\)`), `${fn} exists`);
    assert.match(sql, new RegExp(`revoke execute on function public\\.${fn}\\(jsonb\\) from public, anon, authenticated;\\s*grant execute on function public\\.${fn}\\(jsonb\\) to service_role;`), `${fn} is the service role's alone`);
  }
  for (const table of ["phoenix_crm_double_visit_requests", "phoenix_crm_double_visit_request_people"]) {
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;\\s*grant all on table public\\.${table} to service_role;`), `${table} is closed to the browser roles`);
  }

  const requests = read("src/components/phoenix-crm/double-visit-requests.tsx");
  assert.doesNotMatch(requests, /cancel|withdraw|take back|delete/i, "no button on the rep's page cancels, withdraws or deletes the request");
  assert.match(requests, /Change the days/, "the rep can change the days");
  const service = read("src/lib/phoenix-crm/server/double-visit-requests.ts");
  assert.doesNotMatch(service, /cancel/i, "the service has no cancel path");
  assert.match(requests, /\/api\/phoenix-crm\/double-visit-requests\/edit/, "the change goes through the edit door");

  // ── 5. The last question: LAST, defaults to No, and No asks nothing more ───────────────────────
  const question = read("src/components/phoenix-crm/double-visit-question.tsx");
  assert.match(question, /export const NO_DOUBLE_VISIT: DoubleVisitAnswerDraft = \{ wanted: false, hrIds: \[\], days: \[\] \}/, "it starts on No");
  assert.match(question, /next === "yes" \? \{ \.\.\.value, wanted: true \} : NO_DOUBLE_VISIT/, "going back to No clears the picks");
  assert.match(question, /value\.wanted \? \(/, "the people and the days are drawn only after Yes");
  assert.match(question, /id="phoenix-crm-visit-double"/);

  const form = read("src/components/phoenix-crm/visit-log-form.tsx");
  assert.match(form, /const STEP_DOUBLE = "phoenix-crm-visit-double"/);
  assert.match(form, /useState<DoubleVisitAnswerDraft>\(NO_DOUBLE_VISIT\)/, "the form opens with No");
  assert.match(
    form,
    /const asksDoubleVisit = form\.enteredAs === "rep" && !atPharmacy && isDoubleVisitCustomer\(customer\)/,
    "asked of the rep's own visit to an AM or PM customer only",
  );
  const jump = /const openStep = ([\s\S]*?);\n/.exec(form)?.[1]?.replace(/\s+/g, " ") ?? "";
  assert.ok(jump.endsWith("!commentDone ? STEP_COMMENT : !doubleVisitDone ? STEP_DOUBLE : null"), "the bar reaches the question after the comment and not before");
  assert.match(form, /doubleVisit: asksDoubleVisit && doubleVisit\.wanted \? \{ wanted: true, hrIds: doubleVisit\.hrIds, days: doubleVisit\.days \} : null/, "No sends nothing");
  assert.ok(form.indexOf("<DoubleVisitQuestion") > form.indexOf('title="7 · What you took away"'), "the question comes after the last numbered block");
  assert.doesNotMatch(form.slice(form.indexOf("<DoubleVisitQuestion") - 400, form.indexOf("<DoubleVisitQuestion")), /title="\d ·/, "and it is an unnumbered block, so no step number moved");

  // ── The save: prepared BEFORE the visit is written, raised AFTER ───────────────────────────────
  const visits = read("src/lib/phoenix-crm/server/visits.ts");
  assert.match(visits, /prepareDoubleVisitRequest\(viewer, \{/, "a bad pick refuses the save before anything is written");
  assert.ok(visits.indexOf("prepareDoubleVisitRequest(viewer, {") < visits.indexOf("raiseDoubleVisitRequestFromVisit(viewer, {"), "prepared first, raised after the visit exists");
  assert.match(visits, /doubleVisitNote: doubleVisitSavedNote\(doubleVisit\)/, "the saved visit says who was asked");

  // ── 4. Gates in the routes ─────────────────────────────────────────────────────────────────────
  const registry = read("src/lib/security/access-registry.ts");
  for (const pattern of ["", "/edit", "/answer", "/report"]) {
    assert.ok(registry.includes(`pattern: "/api/phoenix-crm/double-visit-requests${pattern}"`), `the registry declares ${pattern || "the read door"}`);
  }
  assert.match(registry, /methods: \["POST"\], pattern: "\/api\/phoenix-crm\/double-visit-requests\/edit", permission: \{ resource: "phoenix_crm", action: "create" \}/, "the rep edits under the create right he records visits with");

  // ── 6. The sidebar row and its companions ──────────────────────────────────────────────────────
  const layout = read("src/components/employee-portal/employee-portal-layout.tsx");
  assert.match(layout, /showDoubleVisitRequestsTab \? \[\{ href: "\/employee-portals\/double-visit-requests", label: "Double visit requests"/);
  const registryNav = read("src/components/employee-portal/employee-portal-nav-registry.ts");
  assert.match(registryNav, /href: "\/employee-portals\/double-visit-requests", icon: UsersRound, flags: \["showDoubleVisitRequestsTab"\]/);
  assert.match(read("src/lib/employee-portal/native-module-directory.ts"), /"\/employee-portals\/double-visit-requests": \{ icon: "people-outline", section: "Phoenix CRM" \}/);
  assert.match(read("src/lib/employee-portal/navigation.ts"), /showDoubleVisitRequestsTab: hasDoubleVisitRequests === true/);
  assert.match(read("src/lib/phoenix-crm/server/page.ts"), /doubleVisitRequests: doubleVisitReportAudience\(viewer\) !== null/, "the row asks the same function the page and the routes ask");
  assert.ok(existsSync("app/employee-portals/double-visit-requests/loading.tsx"), "the portal route has its skeleton");
  assert.ok(existsSync("app/employee-portals/double-visit-requests/page.tsx"));
  assert.ok(existsSync("app/(admin)/admin/phoenix-crm/double-visit-requests/page.tsx"), "the Super Admin, the CEO and the SFE Manager read it on the admin shell");
  for (const file of ["app/employee-portals/double-visit-requests/page.tsx", "app/(admin)/admin/phoenix-crm/double-visit-requests/page.tsx"]) {
    const page = read(file);
    assert.match(page, /doubleVisitReportAudience\(viewer\) === null\) redirect\(/, `${file} turns away anyone the audience refuses`);
  }
  const catalog = read("src/config/system-navigation.ts");
  assert.ok(catalog.includes('href: "/admin/phoenix-crm/double-visit-requests"'), "the admin shell lists the report");

  // The rep finds the answers where he looks for the customer.
  assert.match(read("src/components/phoenix-crm/list-customer.tsx"), /<CustomerDoubleVisitRequests/, "his requests and every answer sit on the customer's page");

  // Customer-facing words: the banned vocabulary never reaches a screen.
  for (const file of ["src/components/phoenix-crm/double-visit-requests.tsx", "src/components/phoenix-crm/double-visit-question.tsx"]) {
    const source = read(file);
    const strings = [...source.matchAll(/(?:"([^"\n]{3,})"|>([^<>{}\n]{3,})<)/g)].map((match) => match[1] ?? match[2] ?? "");
    for (const text of strings) assert.doesNotMatch(text, /\b(accounts?|doctors?)\b/i, `${file}: "${text}" uses a banned word — say customer`);
  }
}
