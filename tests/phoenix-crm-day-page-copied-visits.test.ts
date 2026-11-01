import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dayDetailCounts } from "../src/lib/phoenix-crm/day-detail.ts";
import type { PlanVsActualRow } from "../src/lib/phoenix-crm/manager-day-plan.ts";
import { managerDayFigures, type ManagerDayVisit } from "../src/lib/phoenix-crm/manager-visit-detail.ts";
import { planActualRowHasHalf } from "../src/lib/phoenix-crm/manager-visit-table.ts";
import { archiveHistoryNote, customerCountsAsValidated, visitIsArchiveHistory } from "../src/lib/phoenix-crm/unplanned-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// THE DAY PAGE: PHARMACIES AND COPIED VISITS (owner, 2026-11-01).
//
// Read on screen on production that morning: Yassin Khalifa's 30 April held 15 pharmacy visits and read
// Pharmacies 0, "15 visits saved, waiting for their customers to be validated", although a pharmacy needs
// no validation. Copied visits to customers in the Archive read the same sentence, and nobody validates a
// customer in the Archive. And every copied visit printed a time read from a midnight nobody saw.
// Account: docs/phoenix-crm-ireports360-history-import.md, "On a day page".
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const source = (relativePath: string): string =>
  stripComments(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));

const count = (text: string, needle: string): number => text.split(needle).length - 1;

export function runPhoenixCrmDayPageCopiedVisitsTests() {
  // 🔴 A PHARMACY NEEDS NO VALIDATION, SO THE RAW-TABLE READER ASKS WHAT THE VIEW ASKS. Asking `validated_at` alone read
  //    every pharmacy visit at Pharmacies 0, "waiting for its customer", under a calendar cell that counted it.
  assert.equal(customerCountsAsValidated({ listType: "Pharmacy", validatedAt: null }), true, "a pharmacy counts with no validation date");
  assert.equal(customerCountsAsValidated({ listType: "PM", validatedAt: null }), false, "a doctor still needs one");
  assert.equal(customerCountsAsValidated({ listType: "AM", validatedAt: "2026-10-01T09:00:00Z" }), true);
  assert.equal(customerCountsAsValidated({ listType: undefined, validatedAt: null }), false, "a missing customer is false, as in the view");

  const visits = source("src/lib/phoenix-crm/server/visits.ts");
  assert.ok(visits.includes("customer:phoenix_crm_customers!customer_id(name, status, validated_at, list_type)"), "the day's read asks for the customer's list");
  assert.match(visits, /const customerValidated = customerCountsAsValidated\(\{/, "and the row's flag is the view's own question");

  // 🔴 THE ARCHIVE WAITS FOR NOBODY; A PENDING CUSTOMER REALLY IS WAITING. Only a copied visit, only unvalidated.
  const archived = { customerStatus: "dropped", customerValidated: false, importedAt: "2026-10-30T14:42:00Z" };
  assert.equal(visitIsArchiveHistory(archived), true);
  assert.equal(visitIsArchiveHistory({ ...archived, customerStatus: "pending" }), false, "a pending customer can still be validated");
  assert.equal(visitIsArchiveHistory({ ...archived, customerValidated: true }), false, "a copied pharmacy in the Archive counts, so it is no exception");
  assert.equal(visitIsArchiveHistory({ ...archived, importedAt: null }), false, "a real visit keeps its own words");
  assert.equal(archiveHistoryNote(0), null);
  assert.match(archiveHistoryNote(1) ?? "", /^1 visit copied from the old system, to a customer in the Archive\./);
  assert.match(archiveHistoryNote(2) ?? "", /^2 visits copied from the old system, to customers in the Archive\./);
  assert.doesNotMatch(archiveHistoryNote(2) ?? "", /waiting/, "the sentence never says waiting");

  const midnight = "2026-04-29T21:00:00.000Z";
  const day = dayDetailCounts([
    { capturedAt: midnight, copiedFromOldSystem: true, countsInKpi: true, customerId: "1", customerName: "El Ezaby", customerValidated: true, listType: "Pharmacy", pharmacyName: "El Ezaby" },
    { archiveHistory: true, capturedAt: midnight, copiedFromOldSystem: true, countsInKpi: false, customerId: "2", customerName: "In the Archive", customerValidated: false, listType: "PM", pharmacyName: null },
    { capturedAt: midnight, copiedFromOldSystem: true, countsInKpi: false, customerId: "3", customerName: "Still pending", customerValidated: false, listType: "AM", pharmacyName: null },
  ]);
  assert.deepEqual(day.counts, { am: 0, pharmacies: 1, pm: 0 }, "the copied pharmacy reaches its figure, and nothing else does");
  assert.equal(day.archiveHistory, 1, "the Archive visit is said apart");
  assert.equal(day.awaitingValidation, 1, "only the pending customer is waiting");
  assert.equal(day.pharmacies[0]?.firstCapturedAt, "", "a copied pharmacy prints no clock");

  const row = (fields: Partial<ManagerDayVisit>) =>
    ({ awaitingValidation: true, kind: "double", listType: "PM", pharmacyName: null, source: "rep", ...fields }) as unknown as ManagerDayVisit;
  const figures = managerDayFigures([row({ archiveHistory: true }), row({})]);
  assert.equal(figures.archiveHistory, 1, "a manager's day says it apart too");
  assert.equal(figures.awaitingValidation, 1);
  assert.equal(figures.pm, 0, "and neither is counted");

  // 🔴 NO CLOCK, NO HALF. Every copied visit is stamped midnight, which files a pharmacy under PM on the strength of nothing.
  const planRow = (fields: Partial<ManagerDayVisit>) => ({ actual: fields, plan: null }) as unknown as PlanVsActualRow;
  assert.equal(planActualRowHasHalf(planRow({ bucket: "Pharmacy", loggedHalf: null })), false, "a copied pharmacy has no half");
  assert.equal(planActualRowHasHalf(planRow({ bucket: "Pharmacy", loggedHalf: "AM" })), true, "a real pharmacy keeps the half it was logged in");
  assert.equal(planActualRowHasHalf(planRow({ bucket: "PM", loggedHalf: null })), true, "a doctor's half is his list");

  const details = source("src/lib/phoenix-crm/server/manager-visit-details.ts");
  assert.match(details, /const loggedAt = importedAt \? null : /, "a copied row has no logged time");
  assert.match(details, /archiveHistory: visitIsArchiveHistory\(\{/, "and the table's row carries the Archive mark");
  assert.ok(details.includes('lat, customer_validated, imported_from_ireports360_at"'), "the row reads its own copy mark");
  assert.ok(details.includes('.select("id, seat_id, list_type, name, speciality, grade, status")'), "and its customer's status");

  const table = source("src/components/phoenix-crm/manager-plan-actual-table.tsx");
  assert.equal(count(table, "planActualRowHasHalf(row)"), 2, "both places that print a half ask first");
  assert.match(table, /visit\.archiveHistory \? ARCHIVE_HISTORY_LABEL : "Not scored yet"/);
  assert.match(table, /<Muted>\{COPIED_VISIT_NO_TIME\}<\/Muted>/);

  const page = source("src/components/phoenix-crm/day-detail-view.tsx");
  assert.match(page, /visit\.copiedFromOldSystem \? COPIED_VISIT_NO_TIME : cairoClock\(visit\.capturedAt\)/, "the card prints no midnight");
  assert.match(page, /pharmacy\.firstCapturedAt \? /, "nor does the pharmacy line");
  assert.match(page, /archiveHistoryNote\(archiveHistory\)/, "the page says why these are in no figure");
  assert.match(page, /visit\.outOfList && !visit\.archiveHistory/, "with one mark, not two");
  assert.match(page, /!visit\.customerValidated && !visit\.outOfList && !visit\.archiveHistory/);

  assert.match(source("src/components/phoenix-crm/manager-day-view.tsx"), /archiveHistoryNote\(figures\.archiveHistory\)/, "a manager's day page says it too");
}
