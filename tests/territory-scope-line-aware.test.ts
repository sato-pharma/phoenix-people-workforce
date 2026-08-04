import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { expandRegionCodesForOperationalMatch } from "../src/lib/territory-management/service.ts";

// Territory Management compares label-derived SoS region codes against the seat model's
// operational_region_code. The vocabularies agree except where the organogram splits a region
// per line (Upper Egypt → UE-1 / UE-2 for Anti Infective). A coarse "UE" scope that does not
// match the split children makes the whole Upper Egypt team disappear from a UE-scoped manager.

export function runTerritoryScopeLineAwareTests() {
  const known = ["AB", "CA", "D1", "D2", "GZ", "OT", "UE", "UE-1", "UE-2"];

  assert.deepEqual(
    [...expandRegionCodesForOperationalMatch(new Set(["UE"]), known)].sort(),
    ["UE", "UE-1", "UE-2"],
    "a coarse UE scope must also match its operational split children — otherwise every UE-1/UE-2 area vanishes",
  );
  assert.deepEqual(
    [...expandRegionCodesForOperationalMatch(new Set(["CA"]), known)].sort(),
    ["CA"],
    "an unsplit region expands to itself only — no accidental widening",
  );
  assert.deepEqual(
    [...expandRegionCodesForOperationalMatch(new Set(["ue"]), known)].sort(),
    ["UE", "UE-1", "UE-2"],
    "expansion is case-insensitive on the scope side",
  );
  assert.deepEqual(
    [...expandRegionCodesForOperationalMatch(new Set(["UE-1"]), known)].sort(),
    ["UE-1"],
    "an already-split code stays as-is — a UE-1 manager must not gain UE-2",
  );
  assert.deepEqual(
    [...expandRegionCodesForOperationalMatch(new Set(), known)].sort(),
    [],
    "an empty scope stays empty (fail-closed callers rely on this)",
  );

  // Everything beneath the scope's own prefix is included, at any depth — a manager scoped to UE
  // owns whatever sits under UE, however finely it is later subdivided. (Expansion is computed
  // from the original codes rather than the growing set; with a prefix rule the two agree, but
  // reading off a set you are writing to is fragile if the matching rule ever changes.)
  assert.deepEqual(
    [...expandRegionCodesForOperationalMatch(new Set(["UE"]), [...known, "UE-1-NORTH"])].sort(),
    ["UE", "UE-1", "UE-1-NORTH", "UE-2"],
    "a deeper subdivision under UE still belongs to the UE-scoped manager",
  );
  assert.deepEqual(
    [...expandRegionCodesForOperationalMatch(new Set(["UE-1"]), [...known, "UE-1-NORTH"])].sort(),
    ["UE-1", "UE-1-NORTH"],
    "a UE-1 manager gets UE-1's own subdivisions but still never UE-2",
  );

  // The RM subtree area fallback must include the MANAGER'S OWN area. isWithinManagerHierarchy
  // walks subordinates and excludes the viewer, so a manager who personally holds an area loses
  // it otherwise — live case: PD-0001 holds Alex East (AB1) and none of his three reports cover
  // it. Source-text guard (the resolver reads the directory + Supabase directly), same style as
  // reconcile-stale-vacancy-area-guard.test.ts; it fails fast if the self step is ever dropped.
  const portalSos = readFileSync(new URL("../src/lib/sales/portal-sos-dashboard.ts", import.meta.url), "utf8");
  const subtreeFn = portalSos.slice(portalSos.indexOf("export async function resolveRegionalManagerSubtreeAreaScope"));
  assert.ok(
    subtreeFn.length > 0,
    "resolveRegionalManagerSubtreeAreaScope must exist — it is the line-aware RM fallback",
  );
  assert.match(
    subtreeFn.slice(0, subtreeFn.indexOf("return { areaCodes, factRegionCodes }")),
    /const self = directory\.employees\.find[\s\S]*?if \(self\?\.areaId != null\) areaIds\.add\(self\.areaId\)/,
    "the RM's own areaId must be seeded into the area set before the subordinate walk — the walk excludes the viewer, so without this the manager loses their own territory",
  );
}
