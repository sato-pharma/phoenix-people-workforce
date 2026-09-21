import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { planOnlyCrmRegionId } from "@/lib/crm/region-brick";

// The Region Mapping tab lists PLAN-ONLY localities too — places known only from reps' plans and doctor
// lists, which no visit has reached. Before this it scanned the visits alone, so a locality a rep had
// only planned (13 on production on 2026-09-21, "Salah Eldin" the largest at 20 customers) could never
// be mapped, and every customer later added there stayed brick-pending.
//
// The vendor sends those two feeds with the locality NAME and never its id, so the tab keys each one on
// a stand-in id made from the name. The contact master's region-from-name step then carries a mapping
// made under that id onto every contact with the name — no SQL change needed. The id is pinned on
// behaviour (it is pure); the loaders are IO, so their shape is pinned on the source.

/** The body of a top-level function from its declaration to its close. */
function block(source: string, declaration: string, close = "\n}\n"): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must exist`);
  const end = source.indexOf(close, start);
  assert.ok(end > start, `${declaration} must be closed`);
  return source.slice(start, end);
}

export function runCrmRegionMappingPlanOnlyTests() {
  // P1 · the stand-in id: negative (no vendor id ever is), an int4 (the resolutions table's key), and
  // keyed exactly as the contact master matches a name — lower(btrim(name)).
  const salah = planOnlyCrmRegionId("Salah Eldin");
  assert.ok(Number.isSafeInteger(salah) && salah < 0 && salah >= -2147483647, "P1: a stand-in id is a negative int4");
  assert.equal(planOnlyCrmRegionId("  salah ELDIN "), salah, "P1: the id ignores case and surrounding spaces, like the master's name match");
  assert.notEqual(planOnlyCrmRegionId("Khalifa Mamoun"), salah, "P1: two localities get two ids");

  // P2 · STABLE FOREVER. A stored decision is keyed on this number; a changed hash would orphan every
  // plan-only mapping already saved and list those localities as unmapped again.
  assert.equal(salah, -395066280, "P2: the stand-in id for a name never changes");
  assert.equal(planOnlyCrmRegionId("Rabi'a Al Adawia"), -470039619, "P2: the stand-in id for a name never changes");

  // P3 · no two of the production plan-only localities share an id.
  const names = [
    "Salah Eldin", "Khalifa Mamoun", "Mostafa el Nahas", "Saft El Laban", "Demro", "Mahalet Hasan", "El Osirat",
    "El sabteya", "Hasan Maamoon Street", "Imbaba Zones", "Mahkama", "Rabi'a Al Adawia", "Tamia",
  ];
  assert.equal(new Set(names.map(planOnlyCrmRegionId)).size, names.length, "P3: every plan-only locality has its own id");

  const service = readFileSync(new URL("../src/lib/crm/region-brick.ts", import.meta.url), "utf8");

  // P4 · both readers build on ONE universe that adds the plan-only localities, so the tab and the
  // template can never disagree about what exists.
  const universe = block(service, "async function loadRegionUniverse(");
  assert.ok(universe.includes("loadPlanOnlyRegions("), "P4: the region universe adds the plan-only localities");
  for (const reader of ["export async function getUnmappedCrmRegions(", "export async function getAllCrmRegionsForTemplate("]) {
    assert.ok(block(service, reader).includes("loadRegionUniverse()"), `P4: ${reader} builds on the full universe`);
    assert.doesNotMatch(block(service, reader), /scanAllCrmRegions\(\)/, `P4: ${reader} never reads the visits alone`);
  }

  // P5 · the plan-only half reads the contact master (Phoenix's own table, not a vendor mirror) for the
  // customers with no vendor region id, and keys each by the stand-in.
  const planOnly = block(service, "async function loadPlanOnlyRegions(");
  assert.ok(planOnly.includes(".from(CRM_CONTACT_MASTER_TABLE)"), "P5: plan-only localities come from the contact master");
  assert.ok(planOnly.includes("crm_region_id.is.null"), "P5: only customers the vendor gave no region id");
  assert.ok(planOnly.includes("planOnlyCrmRegionId(name)"), "P5: each plan-only locality is keyed by its stand-in id");

  // P6 · a stand-in id is only ever written for the name it was made from — by hand or by upload.
  assert.ok(
    block(service, "export async function setCrmRegionBrickResolution(").includes("standInIdProblem(input.crmRegionId, input.crmRegionName)"),
    "P6: a single save checks a stand-in id against its name",
  );
  assert.ok(
    block(service, "export async function bulkImportCrmRegionBrickMappings(").includes("standInIdProblem(row.crmRegionId, row.crmRegionName)"),
    "P6: an uploaded row checks a stand-in id against its name",
  );

  // P7 · the save route lets a negative id through to that check instead of refusing it.
  const route = readFileSync(new URL("../app/api/admin/crm/resolve-region/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /crmRegionId < 0/, "P7: the resolve route accepts a plan-only locality's negative id");

  // P8 · the screen never offers "View in Visits" for a locality with no visits.
  const panel = readFileSync(new URL("../src/components/crm/crm-region-mapping-panel.tsx", import.meta.url), "utf8");
  assert.ok(panel.includes("isPlanOnly(region) ? null"), "P8: the card hides View in Visits for a plan-only locality");
  assert.ok(panel.includes("No visits to open"), "P8: the table hides View in Visits for a plan-only locality");
}
