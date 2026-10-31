import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  UNVALIDATED_CUSTOMER_VISIT_REFUSED,
  UNVALIDATED_VISIT_LIMIT,
  unvalidatedVisitRefused,
} from "../src/lib/phoenix-crm/entry-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Two visits to a customer nobody has validated yet are saved; the third is REFUSED (owner, 2026-10-28:
// "he can log a visit without validation and a second one but the third time if the customer/account is
// not validated do not accept or pass the visit").
//
// What this pins:
//   · the rule — a doctor or account with two earlier visits and no validation is refused, a validated
//     one never is, and a pharmacy is never counted (owner, 2026-10-03: a pharmacy needs no validation);
//   · the door — only the REP's own save asks it, before the recording is claimed and before anything is
//     written, and the visit being saved never counts against itself;
//   · the words — the rep reads about his own work and the way out.
// ─────────────────────────────────────────────────────────────────────────────

function read(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** The body of one exported function, from its signature to the closing brace at column zero. */
function functionBody(source: string, signature: RegExp): string {
  const start = source.search(signature);
  assert.ok(start >= 0, `the function ${signature} is still in the file`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `the function ${signature} still closes at column zero`);
  return source.slice(start, end);
}

export function runPhoenixCrmUnvalidatedVisitCapTests() {
  // ── 1 · The rule ──────────────────────────────────────────────────────────────────────────────
  assert.equal(UNVALIDATED_VISIT_LIMIT, 2, "two visits before validation, never more");
  for (const listType of ["AM", "PM"]) {
    assert.equal(unvalidatedVisitRefused({ listType, validated: false, earlierVisits: 0 }), false, `${listType}: the first visit saves`);
    assert.equal(unvalidatedVisitRefused({ listType, validated: false, earlierVisits: 1 }), false, `${listType}: the second visit saves`);
    assert.equal(unvalidatedVisitRefused({ listType, validated: false, earlierVisits: 2 }), true, `${listType}: 🔴 the third is refused`);
    assert.equal(unvalidatedVisitRefused({ listType, validated: false, earlierVisits: 10 }), true, `${listType}: and every one after it`);
    assert.equal(unvalidatedVisitRefused({ listType, validated: true, earlierVisits: 10 }), false, `${listType}: a validated customer is never refused`);
  }
  for (const listType of ["Pharmacy"]) {
    assert.equal(
      unvalidatedVisitRefused({ listType, validated: false, earlierVisits: 40 }),
      false,
      `🔴 a pharmacy (${listType}) needs no validation, so it is never counted`,
    );
  }
  assert.equal(unvalidatedVisitRefused({ listType: "AM", validated: false, earlierVisits: Number.NaN }), false, "a count that is not a number refuses nobody");

  // ── 2 · The words ─────────────────────────────────────────────────────────────────────────────
  assert.match(UNVALIDATED_CUSTOMER_VISIT_REFUSED, /Validate the customer first/, "the rep reads the way out");
  assert.doesNotMatch(UNVALIDATED_CUSTOMER_VISIT_REFUSED, /\bdoctor\b|\baccount\b/i, "one sentence for doctors and accounts alike");

  // ── 3 · The door ──────────────────────────────────────────────────────────────────────────────
  const visits = stripComments(read("src/lib/phoenix-crm/server/visits.ts"));
  const saveVisit = functionBody(visits, /export async function saveVisit\(/);
  const ruleAt = saveVisit.indexOf("unvalidatedVisitRefused(");
  assert.ok(ruleAt > 0, "saveVisit asks the rule");
  const guard = saveVisit.lastIndexOf('if (enteredAs === "rep" && unvalidatedCustomer && earlierVisits) {', ruleAt);
  assert.ok(guard > 0, "🔴 only the rep's own save is asked — a manager's visit and a missed-visit entry still save");
  const throwAt = saveVisit.indexOf("throw validationError(UNVALIDATED_CUSTOMER_VISIT_REFUSED)", ruleAt);
  assert.ok(throwAt > ruleAt, "and a refused visit reads the sentence");
  const claimAt = saveVisit.indexOf("claimRequiredRecording(");
  const saveRpcAt = saveVisit.indexOf('"phoenix_crm_save_visit"');
  assert.ok(claimAt > throwAt && saveRpcAt > throwAt, "🔴 refused before the recording is claimed and before anything is written");

  const countAt = saveVisit.indexOf('.from("phoenix_crm_visits")');
  assert.ok(countAt > 0 && countAt < guard, "the earlier visits are counted before the guard");
  const countRead = saveVisit.slice(countAt, saveVisit.indexOf(": Promise.resolve(null)", countAt));
  assert.match(countRead, /\.eq\("seat_id", seat\.seatId\)/, "the seat's own visits");
  assert.match(countRead, /\.eq\("customer_id", visit\.customerId\)/, "to this customer");
  assert.match(countRead, /\.eq\("is_test", isTest\)/, "in the same test world");
  assert.match(countRead, /\.is\("linked_from_visit_id", null\)/, "never a pharmacy row filed from a doctor's visit");
  assert.match(countRead, /\.neq\("id", visitId\)/, "🔴 and never the visit being saved, so a retried save is not refused by itself");
  assert.match(
    saveVisit,
    /\.from\("phoenix_crm_customers"\)\.select\("validated_at, list_type"\)\.eq\("id", visit\.customerId\)/,
    "the customer's own validation and list are read",
  );

  // ── 4 · Said BEFORE the visit is written, never after (System Audit, 31 Oct 2026) ─────────────
  // 21 refusals from 7 reps in one day, every one after a whole visit was filled in. Add visit now asks
  // the same question first — with the same count, or it warns about a visit the save would take, or
  // stays silent about one it would refuse.
  const counter = functionBody(visits, /async function loadUnvalidatedVisitCounts\(/);
  assert.match(counter, /\.from\("phoenix_crm_visits"\)/, "the form counts the same table");
  assert.match(counter, /\.in\("customer_id", ids\)/, "for every customer on the list at once");
  // Every filter the save's count carries, bar the customer and the visit being saved, the form's carries too.
  const saveFilters = [...countRead.matchAll(/\.(eq|is)\("([a-z_0-9]+)"/g)]
    .map(([, kind, column]) => `${kind}:${column}`)
    .filter((filter) => filter !== "eq:customer_id");
  assert.ok(saveFilters.length >= 4, `the save's filters are read from its own code (${saveFilters.join(", ")})`);
  for (const filter of saveFilters) {
    const [kind, column] = filter.split(":");
    assert.ok(counter.includes(`.${kind}("${column}"`), `🔴 the form's count carries the save's own .${kind}("${column}") — the two must count the same visits`);
  }
  assert.match(counter, /\.is\("imported_from_ireports360_at", null\)/, "never a visit copied from iReports360 history, as the save");
  assert.match(counter, /validated_at === null/, "only customers nobody has validated are counted");
  assert.match(counter, /!isPharmacyListType\(row\.list_type\)/, "a pharmacy is never asked about");

  const form = functionBody(visits, /export async function loadVisitForm\(/);
  assert.match(
    form,
    /const unvalidatedVisitsRead =\s*enteredAs === "rep"\s*\?\s*customersRead\.then/,
    "only the rep's own form counts — the save asks nobody else",
  );
  assert.match(
    form,
    /validateFirst:\s*enteredAs === "rep" &&\s*unvalidatedVisitRefused\(\{\s*listType: row\.list_type,\s*validated: row\.validated_at !== null && row\.validated_at !== undefined,\s*earlierVisits: unvalidatedVisits\.get\(customerId\) \?\? 0,/,
    "🔴 the save's own rule, with the save's own answers: the raw list, validated_at and the counted visits",
  );

  const picker = stripComments(read("src/components/phoenix-crm/visit-customer-picker.tsx"));
  assert.match(
    picker,
    /disabled=\{customer\.visitedToday \|\| blocked !== null \|\| customer\.validateFirst\}/,
    "🔴 the picker never offers the visit the save would refuse",
  );
  assert.match(picker, /\{customer\.validateFirst \? <CrmPill tone="warn">\{VALIDATE_FIRST_PILL\}<\/CrmPill> : null\}/, "the row says why");
  assert.match(picker, /\{customer\.validateFirst\s*\?\s*UNVALIDATED_CUSTOMER_VISIT_REFUSED/, "and the way out, in the save's own sentence");

  const tab = stripComments(read("src/components/phoenix-crm/visits-tab.tsx"));
  const openAt = tab.indexOf('if (step.name === "open") {');
  assert.ok(openAt > 0, "Add visit still opens a customer from a link or Today's stop");
  const openGuard = tab.indexOf("if (customer.validateFirst) return validateFirst(customer);", openAt);
  const routeAt = tab.indexOf("current = routeFor(customer);", openAt);
  assert.ok(openGuard > openAt && openGuard < routeAt, "🔴 a customer opened from a link reads the sentence before any step");
  const formAt = tab.indexOf("const formStep = current;");
  const formGuard = tab.indexOf("if (customer.validateFirst) return validateFirst(customer);", formAt);
  const logFormAt = tab.indexOf("<VisitLogForm", formAt);
  assert.ok(formAt > 0 && formGuard > formAt && formGuard < logFormAt, "🔴 and the visit form itself is never drawn for him");
  assert.match(
    tab,
    /const validateFirst = \(customer: VisitCustomerOption\) => \([\s\S]*?<CrmNote title=\{customer\.name\} tone="warn">\s*\{UNVALIDATED_CUSTOMER_VISIT_REFUSED\}/,
    "the panel names the customer and says the save's own sentence",
  );
}
