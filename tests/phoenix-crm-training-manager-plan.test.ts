import assert from "node:assert/strict";

import {
  findManagerPlanScope,
  isManagerPlannerKind,
  isSeatlessPlannerKind,
  managerPlannerTitle,
  managerPlanScopes,
  managerPlanWriterOf,
  managerScopeKey,
  managerScopeTerritories,
  managerSlotKinds,
  managerSlotScopeError,
  parseManagerSlotDraft,
  TRAINING_MANAGER_PLAN_ROLES,
} from "../src/lib/phoenix-crm/manager-plan-rules.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { managerHalfDayText, managerHalfLegacyType } from "../src/lib/phoenix-crm/server/manager-plan-readers.ts";

/**
 * The Training Manager plans a weekly plan in Phoenix CRM (owner, 2026-10-24: "he neevr choose dr he choose
 * the region then the area/rep only"; her half-days, confirmed in chat: a rep, an area, or Admin/Office).
 * She holds no organogram seat: her week is filed on none, she picks a REGION across every line, and each
 * half-day is With a rep (the rep only, never a customer), An area (one area of that region), or Admin.
 */

function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat {
  return {
    parentSeatId: overrides.path.length > 1 ? overrides.path[overrides.path.length - 2] : null,
    occupantHrId: null,
    lineCode: "anti_infective",
    lineName: "Anti Infective",
    areaName: null,
    regionName: null,
    seatLabel: null,
    ...overrides,
  };
}

const CEO = seat({ seatId: "SEAT-CEO", tier: "CEO", path: ["SEAT-CEO"], occupantHrId: "B-2", lineCode: null, lineName: null });
const AIF_DM = seat({ seatId: "AIF-DM-CA", tier: "DM", path: ["SEAT-CEO", "AIF-DM-CA"], occupantHrId: "B-12", regionCode: "CA", regionName: "Cairo" });
const PED_DM = seat({ seatId: "PED-DM-CA", tier: "DM", path: ["SEAT-CEO", "PED-DM-CA"], occupantHrId: "PD-40", lineCode: "pedia", lineName: "Pedia", regionCode: "CA", regionName: "Cairo" });
const GZ_DM = seat({ seatId: "AIF-DM-GZ", tier: "DM", path: ["SEAT-CEO", "AIF-DM-GZ"], occupantHrId: "B-13", regionCode: "GZ", regionName: "Giza" });
const OTHERS = seat({ seatId: "AIF-OTHERS", tier: "DM", path: ["SEAT-CEO", "AIF-OTHERS"], isOtherPseudoDm: true, regionCode: "HO", regionName: "Head Office" });
const rep = (seatId: string, parent: OrgSeat, occupantHrId: string | null, areaName: string) =>
  seat({ seatId, tier: "REP", path: [...parent.path, seatId], occupantHrId, lineCode: parent.lineCode, lineName: parent.lineName, regionCode: parent.regionCode, regionName: parent.regionName, areaName });
const CA_AIF_1 = rep("AIF-CA-1", AIF_DM, "R-1", "Nasr City");
const CA_AIF_VACANT = rep("AIF-CA-2", AIF_DM, null, "Heliopolis");
const CA_PED_1 = rep("PED-CA-1", PED_DM, "R-2", "Maadi");
const GZ_AIF_1 = rep("AIF-GZ-1", GZ_DM, "R-3", "Dokki");
const OTHERS_REP = rep("AIF-HO-1", OTHERS, "R-4", "Head Office");

const ORG = buildOrgIndex([CEO, AIF_DM, PED_DM, GZ_DM, OTHERS, CA_AIF_1, CA_AIF_VACANT, CA_PED_1, GZ_AIF_1, OTHERS_REP]);
const SALMA = "B-300";

export async function runPhoenixCrmTrainingManagerPlanTests(): Promise<void> {
  // ── 1. Who she is ───────────────────────────────────────────────────────────────────────────────
  assert.deepEqual([...TRAINING_MANAGER_PLAN_ROLES], ["Training Manager"], "the Training Manager's app role, read by role and never by name");
  assert.equal(isManagerPlannerKind("tm"), true);
  assert.equal(isSeatlessPlannerKind("tm"), true, "her week sits on no organogram seat");
  assert.equal(isSeatlessPlannerKind("pm"), true);
  assert.equal(isSeatlessPlannerKind("dm"), false);
  assert.equal(managerPlannerTitle("tm"), "Training manager");

  assert.equal(managerPlanWriterOf(ORG, SALMA, { productManager: false }), null, "without her role she plans nothing");
  const writer = managerPlanWriterOf(ORG, SALMA, { productManager: false, trainingManager: true });
  assert.ok(writer, "the Training Manager plans a week");
  assert.equal(writer.kind, "tm");
  assert.equal(writer.seat, null);
  assert.deepEqual(writer.lineCodes, ["anti_infective", "pedia"], "she spans every line that has a territory");
  const dmWriter = managerPlanWriterOf(ORG, "B-12", { productManager: false, trainingManager: true });
  assert.equal(dmWriter?.kind, "dm", "a seat comes first: a district manager plans as one whatever role he holds");

  // ── 2. Her half-day kinds: a rep, an area, or Admin — never a district manager, a single visit or a ride-along
  assert.deepEqual(managerSlotKinds("tm").map((entry) => entry.key), ["with_rep", "with_area", "admin"]);
  for (const kind of ["dm", "rsm", "nsm", "pm"] as const) {
    assert.ok(!managerSlotKinds(kind).some((entry) => entry.key === "with_area"), `An area is hers alone, never a ${kind}'s`);
  }

  // ── 3. She picks a region first, across every line ──────────────────────────────────────────────
  const scopes = managerPlanScopes(ORG, writer);
  assert.deepEqual(
    scopes.map((scope) => [scope.key, scope.regionName, scope.dmSeatId, scope.lineCode]),
    [
      ["region:CA", "Cairo", null, ""],
      ["region:GZ", "Giza", null, ""],
    ],
    "every region holding a filled rep seat, by name — never the Others bucket",
  );
  assert.equal(managerScopeKey(null, "", "CA"), "region:CA");
  assert.equal(managerScopeKey("AIF-DM-CA", "anti_infective"), "dm:AIF-DM-CA", "a district keeps its own key");
  assert.equal(managerScopeKey(null, "pedia"), "line:pedia");
  assert.equal(findManagerPlanScope(scopes, { dmSeatId: null, lineCode: null, regionCode: "GZ" })?.regionName, "Giza");
  assert.equal(findManagerPlanScope(scopes, { dmSeatId: null, lineCode: null, regionCode: "HO" }), null, "a region she was not offered is refused");
  assert.equal(findManagerPlanScope(scopes, { dmSeatId: "AIF-DM-CA", lineCode: "anti_infective" }), null, "a district is never one of her scopes");

  const cairo = scopes[0];
  assert.deepEqual(
    managerScopeTerritories(ORG, cairo, SALMA).map((territory) => territory.seatId).sort(),
    ["AIF-CA-1", "AIF-CA-2", "PED-CA-1"],
    "a region's territories come from every line in it, the vacant one included",
  );

  // ── 4. Her drafts, read strictly ─────────────────────────────────────────────────────────────────
  const UUID_A = "11111111-1111-4111-8111-111111111111";
  const withRep = parseManagerSlotDraft({ date: "2026-10-31", half: "AM", kind: "with_rep", repSeatId: "AIF-CA-1", scopeRegionCode: "CA" });
  assert.ok(withRep.ok, "With a rep in a region names the rep and nothing else");
  if (withRep.ok) {
    assert.equal(withRep.value.scopeRegionCode, "CA");
    assert.equal(withRep.value.repSeatId, "AIF-CA-1");
    assert.deepEqual(withRep.value.customers, [], "she never chooses a doctor");
    assert.equal(withRep.value.scopeDmSeatId, null);
  }
  assert.equal(parseManagerSlotDraft({ date: "2026-10-31", half: "AM", kind: "with_rep", scopeRegionCode: "CA" }).ok, false, "With a rep names the rep");
  assert.equal(
    parseManagerSlotDraft({ date: "2026-10-31", half: "AM", kind: "with_rep", repSeatId: "AIF-CA-1", scopeRegionCode: "CA", customers: [{ customerId: UUID_A }] }).ok,
    false,
    "a customer is never part of her With a rep",
  );
  assert.equal(
    parseManagerSlotDraft({ date: "2026-10-31", half: "AM", kind: "with_rep", repSeatId: "AIF-CA-1", scopeRegionCode: "CA", scopeDmSeatId: "AIF-DM-CA", scopeLineCode: "anti_infective" }).ok,
    false,
    "a region is never named beside a district",
  );

  const area = parseManagerSlotDraft({ date: "2026-10-31", half: "PM", kind: "with_area", areaSeatId: "PED-CA-1", scopeRegionCode: "CA" });
  assert.ok(area.ok, "An area names one area of the region");
  if (area.ok) {
    assert.equal(area.value.areaSeatId, "PED-CA-1");
    assert.equal(area.value.scopeRegionCode, "CA");
    assert.deepEqual(area.value.customers, []);
  }
  assert.equal(parseManagerSlotDraft({ date: "2026-10-31", half: "PM", kind: "with_area", scopeRegionCode: "CA" }).ok, false, "An area names the area");
  assert.equal(parseManagerSlotDraft({ date: "2026-10-31", half: "PM", kind: "with_area", areaSeatId: "PED-CA-1" }).ok, false, "An area names the region first");
  assert.equal(
    parseManagerSlotDraft({ date: "2026-10-31", half: "PM", kind: "single_visit", areaSeatId: "PED-CA-1", scopeRegionCode: "CA", customers: [{ customerId: UUID_A }] }).ok,
    false,
    "only With a rep and An area are planned in a region",
  );

  // ── 5. The scope check against who plans ─────────────────────────────────────────────────────────
  const scopeOf = (draft: Parameters<typeof managerSlotScopeError>[1]) => managerSlotScopeError("tm", draft, scopes);
  assert.equal(scopeOf({ kind: "with_rep", activityType: null, scopeDmSeatId: null, scopeLineCode: null, scopeRegionCode: "CA" }), null);
  assert.equal(scopeOf({ kind: "with_area", activityType: null, scopeDmSeatId: null, scopeLineCode: null, scopeRegionCode: "GZ" }), null);
  assert.equal(scopeOf({ kind: "admin", activityType: "office", scopeDmSeatId: null, scopeLineCode: null }), null, "Office is one of her Admin half-days");
  assert.match(scopeOf({ kind: "with_rep", activityType: null, scopeDmSeatId: null, scopeLineCode: null, scopeRegionCode: "HO" }) ?? "", /regions shown/, "a region she was not offered is refused");
  assert.match(scopeOf({ kind: "with_rep", activityType: null, scopeDmSeatId: null, scopeLineCode: null }) ?? "", /region first/, "her With a rep always names a region");
  assert.match(scopeOf({ kind: "single_visit", activityType: null, scopeDmSeatId: null, scopeLineCode: null }) ?? "", /With a rep, An area or Admin/);
  assert.match(scopeOf({ kind: "with_dm", activityType: null, scopeDmSeatId: "AIF-DM-CA", scopeLineCode: "anti_infective" }) ?? "", /With a rep, An area or Admin/);
  for (const kind of ["dm", "rsm", "nsm", "pm"] as const) {
    assert.match(
      managerSlotScopeError(kind, { kind: "with_area", activityType: null, scopeDmSeatId: null, scopeLineCode: null, scopeRegionCode: "CA" }, scopes) ?? "",
      /Training Manager's half-days/,
      `a ${kind} never plans a region or An area`,
    );
  }

  // ── 6. The calendars read her half-days ──────────────────────────────────────────────────────────
  assert.equal(managerHalfLegacyType("with_area", null), "Field", "An area is a field half-day on the legacy calendars");
  assert.equal(managerHalfDayText({ kind: "with_area", activityLabel: null, areaName: "Maadi" }, null), "An area · Maadi");
  assert.equal(managerHalfDayText({ kind: "with_area", activityLabel: null, areaName: null }, null), "An area · an area of the region");
  assert.equal(managerHalfDayText({ kind: "with_rep", activityLabel: null, areaName: null }, "Ahmed Ali"), "With Ahmed Ali");
}
