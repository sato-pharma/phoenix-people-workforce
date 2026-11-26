import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pickerSearchMatches, plannedTodayMatches } from "../src/lib/phoenix-crm/visit-picker-search.ts";

/**
 * Phoenix CRM — the Add visit picker's search (26 Nov 2026). محمد علي عبدالسلام was on Hagar Abu zeid's
 * plan for 24 Nov; she looked for him under Out of plan, which never offers today's plan, found nothing and
 * saved him a second time. The search now folds the spelling, and Out of plan shows a typed match from
 * today's plan above the list, opening as the planned visit.
 */

type Row = { customerId: string; name: string; speciality: string | null; listType: string; outside: boolean; plannedToday: boolean };

function row(overrides: Partial<Row>): Row {
  return { customerId: "c1", name: "محمد علي عبدالسلام", speciality: "Pediatrics", listType: "PM", outside: false, plannedToday: true, ...overrides };
}

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runPhoenixCrmVisitPickerSearchTests(): void {
  // ── The search folds the spelling ──────────────────────────────────────────────────────────────
  const doctor = row({});
  assert.equal(pickerSearchMatches("", doctor), true, "an empty search matches everyone");
  assert.equal(pickerSearchMatches("محمد على", doctor), true, "على (ى) finds علي (ي)");
  assert.equal(pickerSearchMatches("عبد السلام", doctor), true, "عبد السلام with a space finds عبدالسلام");
  assert.equal(pickerSearchMatches("عبدالسلام", row({ name: "محمد علي عبد السلام" })), true, "and the other way round");
  assert.equal(pickerSearchMatches("pedia", doctor), true, "the speciality is searched too");
  assert.equal(pickerSearchMatches("أحمد", doctor), false, "a name that is not there is not there");

  // ── Out of plan: today's plan surfaces only on a typed search ──────────────────────────────────
  const customers = [
    row({ customerId: "planned" }),
    row({ customerId: "not-planned", plannedToday: false }),
    row({ customerId: "pharmacy", listType: "Pharmacy" }),
    row({ customerId: "outside", outside: true }),
    row({ customerId: "other", name: "سارة حسن" }),
  ];
  assert.deepEqual(plannedTodayMatches(customers, ""), [], "nothing until she types");
  assert.deepEqual(plannedTodayMatches(customers, "   "), [], "spaces alone are not a search");
  assert.deepEqual(
    plannedTodayMatches(customers, "محمد على عبد السلام").map((customer) => customer.customerId),
    ["planned"],
    "only today's plan — never a customer off it, a pharmacy or one waiting outside the list",
  );
  assert.deepEqual(plannedTodayMatches(customers, "يوسف"), [], "a search that names nobody on the plan shows nothing");

  // ── The picker is wired to them ────────────────────────────────────────────────────────────────
  const picker = source("src/components/phoenix-crm/visit-customer-picker.tsx");
  assert.match(picker, /pickerSearchMatches\(query, customer\)/, "the picker's list searches through the fold");
  assert.doesNotMatch(picker, /customer\.name\.toLowerCase\(\)\.includes\(/, "no unfolded name search is left in the picker");
  assert.match(picker, /mode === "out_of_plan" && onPickPlanned/, "today's plan is offered under Out of plan only");
  assert.match(picker, /onClick=\{\(\) => onPickPlanned\(customer\.customerId\)\}/, "a plan match taps through to the planned door");
  const visits = source("src/components/phoenix-crm/visits-tab.tsx");
  assert.match(
    visits,
    /onPickPlanned=\{\(customerId\) => onStep\(\{ name: "form", customerId, visitType: "planned", reason: null, back: \{ name: "out_of_plan" \} \}\)\}/,
    "it opens as a planned visit — no reason and no approval",
  );
  // The List tab, the rep's list board and the manager's Reps List fold the spelling too.
  for (const path of ["src/lib/phoenix-crm/customer-list-grouping.ts", "src/components/phoenix-crm/list-tab.tsx", "src/components/crm/reps-list-tables.tsx"]) {
    assert.match(source(path), /return foldedWordsMatch\((needle|query), (\[|parts\))/, `${path} searches through the fold`);
  }
}
