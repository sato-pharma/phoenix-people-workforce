import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { buildParticipantHrIdOrFilter, visitPartnerHrIds } from "../src/lib/crm/reads.ts";
import { perDoubleVisitorRows, visitLogPerDoubleVisitor } from "../src/lib/double-visit-analytics/chain-visitors.ts";
import { countsAsManagersDoubleVisit } from "../src/lib/phoenix-crm/double-visit-plan-rules.ts";
import { countsAsPlannersVisitWithRep } from "../src/lib/phoenix-crm/manager-plan-rules.ts";
import { buildOrgIndex, resolveVisitParticipants, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { companyToStorage, type CompanyOffer } from "../src/lib/phoenix-crm/visit-company.ts";

/**
 * Phoenix CRM — a visit carries ANY mix of the people offered to it, and every one of them is credited
 * (owner, 2026-10-27: "Everything is applicable").
 *
 * A rep goes out with his District Sales Manager, the Regional Sales Manager, the Product Manager, the
 * Group Product Manager or the Training Manager — several of them at once. Before, a chain carried a
 * second manager OR one product-side person, never both, and the door (`crm_visits_unified`) mapped two
 * partner slots, so the third person on a visit was credited nowhere. The truth now is the companions
 * table (`phoenix_crm_visit_companions`) and the door's `companion_hr_ids`; the fixed places stay filled
 * for the screens that read them.
 */

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");

const MIGRATION = "supabase/migrations/20261027185332_phoenix_crm_visit_any_companions.sql";

// Rep B-7 → District Sales Manager B-12 → Regional Sales Manager R-3 → National Sales Manager A-12.
const CEO: OrgSeat = {
  seatId: "SEAT-ROOT-CEO",
  parentSeatId: null,
  tier: "CEO",
  path: ["SEAT-ROOT-CEO"],
  occupantHrId: "C-1",
  lineCode: null,
  lineName: null,
  areaName: null,
  regionName: null,
  seatLabel: "CEO",
};
const NSM: OrgSeat = { ...CEO, seatId: "SEAT-PED-NSM", parentSeatId: CEO.seatId, tier: "NSM", path: [CEO.seatId, "SEAT-PED-NSM"], occupantHrId: "A-12", lineCode: "pedia", lineName: "Pedia", seatLabel: "Pedia NSM" };
const RSM: OrgSeat = { ...NSM, seatId: "SEAT-PED-RSM", parentSeatId: NSM.seatId, tier: "RSM", path: [...NSM.path, "SEAT-PED-RSM"], occupantHrId: "R-3", seatLabel: "Pedia RSM" };
const DM: OrgSeat = { ...RSM, seatId: "SEAT-PED-DM", parentSeatId: RSM.seatId, tier: "DM", path: [...RSM.path, "SEAT-PED-DM"], occupantHrId: "B-12", seatLabel: "Pedia DM" };
const REP: OrgSeat = { ...DM, seatId: "SEAT-PED-REP", parentSeatId: DM.seatId, tier: "REP", path: [...DM.path, "SEAT-PED-REP"], occupantHrId: "B-7", areaName: "Giza 1", seatLabel: "Pedia rep" };
const org = buildOrgIndex([CEO, NSM, RSM, DM, REP]);

/** The line's product side as the server reads it: Product Manager, Group Product Manager, Training Manager. */
const PRODUCT_SIDE = [{ hrId: "PM-1" }, { hrId: "GPM-1" }, { hrId: "TM-1" }];

const OFFERS: CompanyOffer[] = [
  { hrId: "B-12", role: "manager", position: 1 },
  { hrId: "R-3", role: "manager", position: 2 },
  { hrId: "A-12", role: "manager", position: 3 },
  { hrId: "PM-1", role: "product_manager", position: null },
  { hrId: "GPM-1", role: "product_manager", position: null },
  { hrId: "TM-1", role: "product_manager", position: null },
];

function runPickerTests() {
  // Ticked in a muddled order; the managers come back nearest first, the product side as ticked.
  const five = companyToStorage({ choice: "chain", picked: ["TM-1", "R-3", "PM-1", "B-12", "GPM-1"], offers: OFFERS });
  assert.equal(five.ok, true, five.ok ? "" : five.error);
  if (!five.ok) return;
  assert.deepEqual(
    five.value,
    {
      kind: "chain",
      managerHrId: "B-12",
      seniorHrId: "R-3",
      productManagerHrId: "TM-1",
      companions: [
        { hrId: "B-12", side: "manager" },
        { hrId: "R-3", side: "manager" },
        { hrId: "TM-1", side: "product" },
        { hrId: "PM-1", side: "product" },
        { hrId: "GPM-1", side: "product" },
      ],
    },
    "two managers AND three of the product side on one chain — nobody trimmed away",
  );

  const productOnly = companyToStorage({ choice: "chain", picked: ["PM-1", "TM-1"], offers: OFFERS });
  assert.equal(productOnly.ok && productOnly.value.kind, "product_manager", "the product side alone is never a double or a chain — no manager came");
  assert.equal(productOnly.ok && productOnly.value.companions.length, 2, "and both of them are on it");

  const managerAndTraining = companyToStorage({ choice: "chain", picked: ["B-12", "TM-1"], offers: OFFERS });
  assert.equal(managerAndTraining.ok && managerAndTraining.value.kind, "chain", "his District Sales Manager and the Training Manager make a chain");
}

function runServerCheckTests() {
  const base = { index: org, territorySeatId: REP.seatId, actorHrId: "B-7", enteredAs: "rep", productManagers: PRODUCT_SIDE } as const;
  const everyone = resolveVisitParticipants({
    ...base,
    kind: "chain",
    managerHrId: "B-12",
    seniorHrId: "R-3",
    productManagerHrId: "PM-1",
    companions: [
      { hrId: "B-12", side: "manager" },
      { hrId: "R-3", side: "manager" },
      { hrId: "A-12", side: "manager" },
      { hrId: "PM-1", side: "product" },
      { hrId: "TM-1", side: "product" },
    ],
  });
  assert.equal(everyone.ok, true, everyone.ok ? "" : everyone.error);
  assert.deepEqual(
    everyone.ok ? everyone.value.companions.map((entry) => entry.hrId) : [],
    ["B-12", "R-3", "A-12", "PM-1", "TM-1"],
    "the server keeps every companion the form sent — three managers and two of the product side",
  );

  const outsider = resolveVisitParticipants({
    ...base,
    kind: "chain",
    managerHrId: "B-12",
    seniorHrId: null,
    productManagerHrId: "PM-1",
    companions: [{ hrId: "X-99", side: "product" }],
  });
  assert.equal(outsider.ok, false, "someone outside the line's product side is still refused");

  const productAlone = resolveVisitParticipants({
    ...base,
    kind: "product_manager",
    managerHrId: null,
    seniorHrId: null,
    productManagerHrId: "GPM-1",
    companions: [{ hrId: "TM-1", side: "product" }],
  });
  assert.deepEqual(
    productAlone.ok ? productAlone.value.companions.map((entry) => entry.hrId) : [],
    ["GPM-1", "TM-1"],
    "the Group Product Manager and the Training Manager together on a product-manager visit",
  );
}

function runCreditTests() {
  // The door row of a five-person chain: the two slots hold the first two, the array holds everyone.
  const row = { companion_hr_ids: ["B-12", "R-3", "PM-1", "TM-1"], double_hr_id: "B-12", double2_hr_id: "R-3" };
  assert.deepEqual(visitPartnerHrIds(row), ["B-12", "R-3", "PM-1", "TM-1"], "every companion is a partner, the third and fourth included");
  assert.deepEqual(visitPartnerHrIds({ double_hr_id: "b-12 ", double2_hr_id: null }), ["B-12"], "a vendor row with no array still answers from its slots");

  const filter = buildParticipantHrIdOrFilter(["TM-1"]) ?? "";
  assert.match(filter, /companion_hr_ids\.ov\.\{/, "finding a person's visits reaches the companions array, or the Training Manager's chain visits are lost");

  // Double-visit analytics: one entry per person on the visit, the third included.
  const views = perDoubleVisitorRows([
    {
      double_visitor_hr_id: "B-12",
      double_visitor_name: "District",
      double_visitor2_hr_id: "R-3",
      double_visitor2_name: "Regional",
      double_visitor_more: [{ hr_id: "TM-1", name: "Training" }],
    },
  ]);
  assert.deepEqual(
    views.map((view) => view.double_visitor_hr_id),
    ["B-12", "R-3", "TM-1"],
    "each of the three is credited with the visit as his own",
  );
  const log = visitLogPerDoubleVisitor([
    { doubleVisitorHrId: "B-12", doubleVisitorName: "District", doubleVisitor2HrId: "PM-1", doubleVisitor2Name: "Product", doubleVisitorMore: [{ hrId: "TM-1", name: "Training" }] },
  ]);
  assert.deepEqual(log.map((entry) => entry.doubleVisitorHrId), ["B-12", "PM-1", "TM-1"], "the visit log fans out to the third person too");

  // A planner's "with a rep" half-day is answered by a visit that lists him past the fixed places: the
  // Training Manager beside the Group Product Manager (only the plan rule's own line credits a
  // product-side visit), and the Regional Sales Manager third on a chain (the double-visit rule's list arm).
  const productSide = { kind: "product_manager", managerHrId: null, seniorHrId: null, productManagerHrId: "GPM-1", companionHrIds: ["GPM-1", "TM-1"] };
  assert.equal(countsAsPlannersVisitWithRep(productSide, "TM-1"), true, "the Training Manager's plan is met by the visit she went on beside the Group Product Manager");
  assert.equal(countsAsPlannersVisitWithRep({ ...productSide, companionHrIds: undefined }, "TM-1"), false, "a visit that never named her does not meet it");
  const chain = { kind: "chain", managerHrId: "B-12", seniorHrId: null, productManagerHrId: "PM-1", companionHrIds: ["B-12", "R-3", "PM-1"] };
  assert.equal(countsAsManagersDoubleVisit(chain, "R-3"), true, "the Regional Sales Manager third on a chain is on its double visit — his plan, the reviewer and the team calendar read this");
}

function runDatabaseTests() {
  const latest = readdirSync(new URL("supabase/migrations/", ROOT)).filter((file) => file.endsWith(".sql")).sort();
  const sql = stripSqlComments(read(MIGRATION));
  const flat = sql.replace(/\s+/g, " ");

  assert.match(flat, /create table if not exists public\.phoenix_crm_visit_companions \(/, "the companions table is the truth about who went");
  assert.match(
    flat,
    /kind = 'chain' and rep_hr_id is not null and manager_hr_id is not null and \(senior_hr_id is not null or product_manager_hr_id is not null\)/,
    "a chain takes the manager above AND a product-side person",
  );
  assert.equal(/\(senior_hr_id is not null\) <> \(product_manager_hr_id is not null\)/.test(flat), false, "the one-or-the-other refusal is gone");
  for (const fn of ["phoenix_crm_save_visit", "phoenix_crm_admin_edit_visit", "phoenix_crm_admin_enter_visit"]) {
    const start = flat.indexOf(`create or replace function public.${fn}(p jsonb)`);
    assert.notEqual(start, -1, `${fn} is rewritten here`);
    const next = flat.indexOf("create or replace function", start + 1);
    const body = flat.slice(start, next === -1 ? undefined : next);
    assert.match(body, /phoenix_crm_set_visit_companions\(/, `${fn} writes the companions list`);
  }

  // The door: the Phoenix branch reads the table, the vendor branch is null, and no later file redefines it
  // without the column.
  const door = flat.slice(flat.indexOf("create or replace view public.crm_visits_unified"));
  assert.match(
    door,
    /from public\.phoenix_crm_visit_companions c where c\.visit_id = p\.id/,
    "the door's Phoenix branch lists every companion from the table, beside the fixed places (no backfill)",
  );
  assert.match(door, /null::text\[\] as companion_hr_ids/, "a vendor row carries no list");
  const doorFiles = latest.filter((file) => /create\s+or\s+replace\s+view\s+public\.crm_visits_unified/i.test(stripSqlComments(read(`supabase/migrations/${file}`))));
  const newestDoor = doorFiles.at(-1) ?? "";
  assert.match(stripSqlComments(read(`supabase/migrations/${newestDoor}`)), /companion_hr_ids/, `the newest door (${newestDoor}) still exposes companion_hr_ids`);
}

function runFieldActivityTests() {
  const report = stripComments(read("src/lib/field-activity/report.ts"));
  const model = stripComments(read("src/lib/field-activity/model.ts"));
  assert.match(report, /companion_hr_ids/, "the field-activity day reads the companions list");
  assert.match(model, /\(visit\.companions \?\? \[\]\)\.some\(/, "a companion past the two slots is ON the visit, so his day counts it");
  assert.match(model, /\.\.\.\(visit\.companions \?\? \[\]\)/, "and he is named among the partners");
}

function runTitleTests() {
  // "I don't have a title called Senior Manager" (owner, 2026-10-27) — every visible string names the real title.
  const dir = new URL("src/components/phoenix-crm/", ROOT);
  const offenders = readdirSync(dir)
    .filter((file) => file.endsWith(".tsx"))
    .filter((file) => /senior manager/i.test(stripComments(readFileSync(new URL(file, dir), "utf8"))));
  assert.deepEqual(offenders, [], "no Phoenix CRM screen says \"senior manager\"");
}

export async function runPhoenixCrmVisitAnyCompanionsTests() {
  runPickerTests();
  runServerCheckTests();
  runCreditTests();
  runDatabaseTests();
  runFieldActivityTests();
  runTitleTests();
}
