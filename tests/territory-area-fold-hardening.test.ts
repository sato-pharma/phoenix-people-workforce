import assert from "node:assert/strict";

import {
  foldAreaOptionsForLine,
  scopeAndFoldAreaChildren,
} from "../src/lib/sales/closing-area-merges.ts";

// HARDENING FOLLOW-UP to PR #2795 (Pedia folds Fayoum GZ6 + Beni Suef UE9 into one area).
//
// The original `foldAreaOptionsForLine` filtered the merged code (UE9) OUT of a picker's option
// list and only renamed the survivor (GZ6) if GZ6 happened to be present. A viewer scoped to UE9
// ALONE — no live case today, since GZ6 and UE9 share one Pedia seat, but reachable by a future
// hire assigned Beni Suef alone via the sos-area crosswalk — therefore got an EMPTY option list:
// the territory drilldown skeleton yielded no areas, and the CRM coverage picker offered no Pedia
// area. A blank screen, not a wrong number.
//
// The fix must ALSO coordinate the skeleton's brick/block scoping. Simply re-keying UE9->GZ6 in the
// option list is not enough: the skeleton re-keys a brick's area with foldAreaCodeForLine (UE9->GZ6
// unconditionally) and filters on that folded code, so GZ6's OWN bricks (already GZ6) would reach a
// UE9-only viewer — a visibility leak the skeleton has no keepExec check to catch. The guard is
// `scopeAndFoldAreaChildren`, which filters on the viewer's REAL (pre-fold) codes first, then
// re-keys for display.
//
// Both halves are proven here for the three scope shapes: {GZ6, UE9} both present, GZ6 alone, and
// UE9 alone. Break either fix and the matching headline assertion below fires.
export function runTerritoryAreaFoldHardeningTests(): void {
  const MERGED = "Fayoum - Beni Suef";

  // ── foldAreaOptionsForLine: exactly one merged option, keyed to GZ6, whenever EITHER is present ──

  // Case 1 — both present: the survivor carries the combined name, the partner is folded away.
  const bothOptions = foldAreaOptionsForLine("pedia", [
    { areaCode: "GZ6", areaName: "Fayoum" },
    { areaCode: "UE9", areaName: "Beni Suef" },
    { areaCode: "CA3", areaName: "Cairo Centers" },
  ]);
  assert.deepEqual(
    bothOptions.map((a) => a.areaCode),
    ["GZ6", "CA3"],
    "both present: exactly one merged option keyed to GZ6; UE9 folded away; unrelated area kept",
  );
  assert.equal(
    bothOptions.find((a) => a.areaCode === "GZ6")?.areaName,
    MERGED,
    "both present: the survivor is relabelled with the combined name",
  );

  // Case 2 — GZ6 alone: still one option, still relabelled.
  const gz6Only = foldAreaOptionsForLine("pedia", [{ areaCode: "GZ6", areaName: "Fayoum" }]);
  assert.deepEqual(
    gz6Only.map((a) => ({ code: a.areaCode, name: a.areaName })),
    [{ code: "GZ6", name: MERGED }],
    "GZ6 alone: one option, keyed to GZ6, combined name",
  );

  // Case 3 — UE9 alone: THE FIX. The merged option must still appear, re-keyed to the survivor GZ6
  // and relabelled — never dropped to nothing (which was the blank-screen bug).
  const ue9Only = foldAreaOptionsForLine("pedia", [{ areaCode: "UE9", areaName: "Beni Suef" }]);
  assert.equal(
    ue9Only.length,
    1,
    "UE9 alone: the merged option is NOT dropped — an in-scope area never collapses to an empty list",
  );
  assert.deepEqual(
    ue9Only.map((a) => ({ code: a.areaCode, name: a.areaName })),
    [{ code: "GZ6", name: MERGED }],
    "UE9 alone: the option is re-keyed to the survivor GZ6 and carries the combined name",
  );
  assert.equal(
    ue9Only.some((a) => a.areaCode.toUpperCase() === "UE9"),
    false,
    "UE9 alone: the raw merged code never survives in the option list",
  );

  // A line with no merge rule leaves everything alone — Anti Infective keeps UE9 as its own option.
  assert.deepEqual(
    foldAreaOptionsForLine("anti_infective", [{ areaCode: "UE9", areaName: "Beni Suef" }]).map((a) => a.areaCode),
    ["UE9"],
    "no-rule line: UE9 stands on its own, never folded",
  );

  // ── scopeAndFoldAreaChildren: bricks scope by REAL code, then display under the survivor ─────────

  // Fixture: one Fayoum brick (GZ6), one Beni Suef brick (UE9), one unrelated brick (CA3).
  const bricks = [
    { brickId: "b-fayoum", areaCode: "GZ6" },
    { brickId: "b-benisuef", areaCode: "UE9" },
    { brickId: "b-cairo", areaCode: "CA3" },
  ];
  const byId = (rows: { brickId: string; areaCode: string }[]) =>
    Object.fromEntries(rows.map((r) => [r.brickId, r.areaCode]));

  // Both codes in scope (the live shape): both bricks kept, both displayed under GZ6.
  assert.deepEqual(
    byId(scopeAndFoldAreaChildren("pedia", ["GZ6", "UE9"], bricks)),
    { "b-fayoum": "GZ6", "b-benisuef": "GZ6" },
    "both in scope: both bricks kept and displayed under the survivor GZ6; the unrelated brick is out of scope",
  );

  // GZ6 alone: only Fayoum's brick — a rep scoped to Fayoum must NOT see Beni Suef's bricks.
  assert.deepEqual(
    byId(scopeAndFoldAreaChildren("pedia", ["GZ6"], bricks)),
    { "b-fayoum": "GZ6" },
    "GZ6 alone: only the Fayoum brick, displayed as GZ6; the Beni Suef (UE9) brick is out of scope",
  );

  // UE9 alone: THE LEAK GUARD. Only Beni Suef's brick, re-keyed to GZ6 for display — and crucially
  // Fayoum's (GZ6) brick must NOT appear, even though both display under GZ6.
  const ue9Bricks = scopeAndFoldAreaChildren("pedia", ["UE9"], bricks);
  assert.deepEqual(
    byId(ue9Bricks),
    { "b-benisuef": "GZ6" },
    "UE9 alone: Beni Suef's brick is kept and re-keyed to GZ6; Fayoum's GZ6 brick does NOT leak in",
  );
  assert.equal(
    ue9Bricks.some((b) => b.brickId === "b-fayoum"),
    false,
    "UE9 alone: a viewer scoped only to Beni Suef never sees Fayoum's bricks (the leak the fix closes)",
  );

  // A line with no merge rule scopes the rows but never re-keys them.
  assert.deepEqual(
    byId(scopeAndFoldAreaChildren("anti_infective", ["UE9"], bricks)),
    { "b-benisuef": "UE9" },
    "no-rule line: the in-scope brick keeps its own area code, never re-keyed to GZ6",
  );

  // Original casing is preserved for a non-merged code; input casing does not affect scoping.
  assert.deepEqual(
    scopeAndFoldAreaChildren("pedia", ["ca3"], [{ brickId: "b", areaCode: "Ca3" }]).map((b) => b.areaCode),
    ["Ca3"],
    "a non-merged code keeps its original casing, and scope matching is case-insensitive",
  );
}
