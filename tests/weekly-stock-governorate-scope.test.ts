import { strict as assert } from "node:assert";

import {
  isKibarOmalaBranch,
  narrowStockRowsToGovernorate,
  resolveBranchGovernorates,
  viewerGovernorates,
  type BranchGovernorateScope,
} from "../src/lib/sales/weekly/branch-governorate-scope.ts";
import { GOVERNORATE_KEYS, type GovernorateKey } from "../src/lib/sales/weekly/governorates.ts";
import type { WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";

// Governorate scope for Weekly Stock (owner, 2026-09-23): a territory viewer sees only the depots in
// his OWN governorate, not his whole region — with two deliberate exceptions the owner named. Kibar
// Omala (key-account) depots stay visible to everyone, and a depot whose name states no governorate
// keeps its region-level visibility. Visibility only: this never moves attribution.

const GOV_KEY_SET = new Set<string>(GOVERNORATE_KEYS);

function govs(scope: BranchGovernorateScope): GovernorateKey[] {
  assert.ok(scope !== "ALL" && scope !== "FLOOR", "expected a governorate set, not a skip rule");
  return [...scope];
}

function territoryScope(input: {
  areas?: string[] | null;
  regions?: string[] | null;
  lines?: string[] | null;
}): WeeklyAccessScope {
  return {
    tier: "territory",
    allowedLineNames: input.lines ? new Set(input.lines) : null,
    allowedRegionCodes: input.regions ? new Set(input.regions) : null,
    allowedAreaCodes: input.areas ? new Set(input.areas) : null,
    canViewHeadOffice: false,
  };
}

export function runWeeklyStockGovernorateScopeTests() {
  // ── Kibar Omala detection: the tokens, never the "_ك" overseas mirror ─────────────────────────
  assert.equal(isKibarOmalaBranch("ك.عملاء المنوفية"), true, "ك.عملاء is a key-account depot");
  assert.equal(isKibarOmalaBranch("ك.ع.م.نصر وهليوبليس"), true, "ك.ع prefix is a key-account depot");
  assert.equal(isKibarOmalaBranch("كبار عملاء القاهرة"), true, "كبار عملاء is a key-account depot");
  assert.equal(isKibarOmalaBranch("Key Acc. W Assiut"), true, "Key Acc is a key-account depot");
  assert.equal(isKibarOmalaBranch("Super KA Alex"), true, "Super KA is a key-account depot");
  assert.equal(isKibarOmalaBranch("الغربية 1_ك"), false, "the _ك overseas mirror is NOT key-account");
  assert.equal(isKibarOmalaBranch("قنا_ك"), false, "the _ك overseas mirror is NOT key-account");
  assert.equal(isKibarOmalaBranch("Cairo Main Warehouse"), false, "a warehouse is not key-account");
  assert.equal(isKibarOmalaBranch("شرق القاهرة"), false, "a plain city depot is not key-account");

  // ── one depot into its governorate(s) ─────────────────────────────────────────────────────────
  assert.equal(resolveBranchGovernorates({ branchName: "ك.عملاء المنوفية", areaCode: null }), "ALL",
    "a Kibar Omala depot is visible to everyone");

  assert.deepEqual(govs(resolveBranchGovernorates({ branchName: "any name", areaCode: "D12" })), ["menoufia"],
    "a mapped area is authoritative — D12 is Menoufia");

  assert.deepEqual(govs(resolveBranchGovernorates({ branchName: "Cairo Main Warehouse", areaCode: null })), ["cairo"],
    "owner: Cairo Main Warehouse is shown to all of Cairo");

  assert.deepEqual(govs(resolveBranchGovernorates({ branchName: "الغربية 1_ك", areaCode: null })), ["gharbia"],
    "an overseas-mirror city depot narrows to its governorate, it is not visible to all");

  assert.equal(resolveBranchGovernorates({ branchName: "منطقة القناة_ك", areaCode: null }), "FLOOR",
    "Canal must NOT match Qena — it floors to region level");

  assert.equal(resolveBranchGovernorates({ branchName: "Delta Main Warehouse", areaCode: null }), "FLOOR",
    "a name with no readable governorate stays region-level");

  assert.deepEqual(govs(resolveBranchGovernorates({ branchName: "جملة - مينا البصل", areaCode: null })), ["alexandria"],
    "Mina El Basal is Alexandria (override — placeMentions floors the glued name)");

  // Owner ruling: a chain serving Alex AND Delta is shown to both, and only both.
  const chain = new Set(govs(resolveBranchGovernorates({ branchName: "Chain - Alex & Delta_ك", areaCode: null })));
  assert.ok(chain.has("alexandria"), "Chain Alex & Delta reaches Alexandria");
  assert.ok(chain.has("dakahlia"), "Chain Alex & Delta reaches the Delta");
  assert.ok(chain.has("port said"), "Chain Alex & Delta reaches all of the Delta");
  assert.ok(!chain.has("cairo"), "Chain Alex & Delta does NOT reach Cairo");

  // An area with no governorate (Main Store, OT3) never fabricates one; it reads the name instead.
  assert.equal(resolveBranchGovernorates({ branchName: "Main Store", areaCode: "OTMS" }), "FLOOR",
    "an excluded area with an unreadable name floors, never invents a governorate");

  // ── every governorate this can emit is a real key ─────────────────────────────────────────────
  for (const gov of chain) assert.ok(GOV_KEY_SET.has(gov), `override governorate '${gov}' is a real key`);
  assert.ok(GOV_KEY_SET.has("kafr el-sheikh") && GOV_KEY_SET.has("beni suef"), "spellings match the shared table");

  // ── the viewer's own governorates ─────────────────────────────────────────────────────────────
  assert.deepEqual([...viewerGovernorates(territoryScope({ areas: ["D12"], lines: ["CNS"] }), new Set())], ["menoufia"],
    "a district manager bound to D12 sees Menoufia");

  assert.deepEqual([...viewerGovernorates(territoryScope({ areas: null, lines: ["Pedia"] }), new Set(["Pedia|D14"]))], ["gharbia"],
    "a medical rep's governorate comes from his own seat area D14 = Gharbia");

  assert.equal(viewerGovernorates({ tier: "full", canViewRestricted: true, canViewHeadOffice: true }, new Set()).size, 0,
    "a full-access viewer has no governorate bound — never narrowed");

  assert.equal(viewerGovernorates(territoryScope({ areas: null, regions: ["D1"], lines: ["CNS"] }), new Set()).size, 0,
    "a viewer with a region bound but no area bound (RM/NSM) is not narrowed to a governorate");

  assert.equal(viewerGovernorates(territoryScope({ areas: ["OTMS"], lines: ["CNS"] }), new Set()).size, 0,
    "an area with no governorate yields no bound — not narrowed");

  // ── the row filter ────────────────────────────────────────────────────────────────────────────
  const rows = [
    { branchName: "جملة - الشبين الكوم", areaCode: null }, // Menoufia (placeMentions)
    { branchName: "any", areaCode: "D14" }, // Gharbia (mapped) — same Delta (1) region, other governorate
    { branchName: "ك.عملاء المنوفية", areaCode: null }, // Kibar Omala — ALL
    { branchName: "Delta Main Warehouse", areaCode: null }, // FLOOR
  ];
  const menoufiaViewer = new Set<GovernorateKey>(["menoufia"]);
  const kept = narrowStockRowsToGovernorate(rows, menoufiaViewer).map((row) => row.branchName);
  assert.deepEqual(
    kept,
    ["جملة - الشبين الكوم", "ك.عملاء المنوفية", "Delta Main Warehouse"],
    "a Menoufia viewer keeps his own governorate + Kibar Omala + unreadable, and loses the Gharbia depot",
  );

  assert.equal(narrowStockRowsToGovernorate(rows, new Set()).length, rows.length,
    "no governorate bound narrows nothing — the region scope upstream still bounds the viewer");
}
