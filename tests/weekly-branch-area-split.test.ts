import assert from "node:assert/strict";

import {
  buildWeeklyAreaSplitIndex,
  describeBranchAreaShares,
  governorateOfAreaName,
  resolveBranchAreaShares,
  type WeeklyBranchScope,
} from "../src/lib/sales/weekly/branch-area-split.ts";

/**
 * OWNER'S RULE (2026-08-27) — a distributor branch that serves several territories is not
 * unmappable. Its money spreads evenly across the governorates its name names, then evenly again
 * across that governorate's areas. And the organogram — not a hard-coded table — decides which
 * areas those are, per line.
 *
 * The fixture below is a VERBATIM copy of the Upper Egypt rows of au_v_line_area_map read from
 * production on 2026-08-27, because the whole point of this test is that the three lines disagree
 * with each other and a plausible-looking invented fixture would hide exactly that.
 */

// area_code -> operational_region_code, per line. Copied from production, not invented.
const MAP_ROWS = [
  // Anti Infective — the only line that splits Upper Egypt into two districts.
  ...[["UE1", "UE-1"], ["UE2", "UE-1"], ["UE9", "UE-1"],
      ["UE3", "UE-2"], ["UE4", "UE-2"], ["UE5", "UE-2"], ["UE6", "UE-2"], ["UE7", "UE-2"], ["UE8", "UE-2"],
      ["GZ6", "GZ"]]
    .map(([area_code, operational_region_code]) => ({ line_code: "anti_infective", area_code, operational_region_code, effective_from: "2026-07-13", effective_to: null })),
  // Pedia — one flat UE. Beni Suef is GIZA here, and Qena 2 is parked in Others.
  ...[["UE1", "UE"], ["UE2", "UE"], ["UE3", "UE"], ["UE4", "UE"], ["UE5", "UE"], ["UE6", "UE"], ["UE7", "UE"],
      ["UE8", "OT"], ["UE9", "GZ"], ["GZ6", "GZ"]]
    .map(([area_code, operational_region_code]) => ({ line_code: "pedia", area_code, operational_region_code, effective_from: "2026-07-13", effective_to: null })),
  // CNS — one flat UE. Beni Suef is OTHERS here, and so is Qena 2.
  ...[["UE1", "UE"], ["UE2", "UE"], ["UE3", "UE"], ["UE4", "UE"], ["UE5", "UE"], ["UE6", "UE"], ["UE7", "UE"],
      ["UE8", "OT"], ["UE9", "OT"], ["GZ6", "OT"]]
    .map(([area_code, operational_region_code]) => ({ line_code: "cns", area_code, operational_region_code, effective_from: "2026-07-13", effective_to: null })),
  // Effective-dating must be honoured: a seat that has not started, and one already retired.
  { line_code: "anti_infective", area_code: "UE99", operational_region_code: "UE-1", effective_from: "2099-01-01", effective_to: null },
  { line_code: "anti_infective", area_code: "UE98", operational_region_code: "UE-1", effective_from: "2026-01-01", effective_to: "2026-06-01" },
];

const AREA_ROWS = [
  { area_code: "UE1", area_name: "Minia 1" }, { area_code: "UE2", area_name: "Minia 2" },
  { area_code: "UE3", area_name: "Assuit 1" }, { area_code: "UE4", area_name: "Assuit 2" },
  { area_code: "UE5", area_name: "Sohag1" }, { area_code: "UE6", area_name: "Sohag2" },
  { area_code: "UE7", area_name: "Qena 1" }, { area_code: "UE8", area_name: "Qena 2" },
  { area_code: "UE9", area_name: "Beni Suef" }, { area_code: "GZ6", area_name: "Fayoum" },
  { area_code: "UE99", area_name: "Minia 9" }, { area_code: "UE98", area_name: "Minia 8" },
];

const TODAY = "2026-08-27";
const index = buildWeeklyAreaSplitIndex(MAP_ROWS, AREA_ROWS, TODAY);

/** Shares as a stable "AREA:percent" list, so an assertion reads like the owner's own arithmetic. */
function shares(line: string, scope: WeeklyBranchScope): string[] {
  return resolveBranchAreaShares(index, line, scope)
    .slice()
    .sort((a, b) => a.areaCode.localeCompare(b.areaCode))
    .map((s) => `${s.areaCode}:${(s.weight * 100).toFixed(2)}`);
}

/**
 * Governorate tokens are the CANONICAL keys from governorates.ts ("assiut"), not the spelling that
 * happens to appear in an area name ("Assuit 1"). The two differ, and the canonical one wins: the
 * area -> governorate grouping is now an explicit code-keyed table, because deriving it from area
 * names silently mis-reads "Gharbia 1 (Tanta)", "Alex East" and "Down town".
 */
const governorates = (...names: string[]): WeeklyBranchScope => ({ kind: "governorates", names });

export async function runWeeklyBranchAreaSplitTests() {
  // 1) HEADLINE — the owner's worked example. "Minya and Assiut" is 50/50, then 25% per rep.
  {
    assert.deepEqual(
      shares("Anti Infective", governorates("minya", "assiut")),
      ["UE1:25.00", "UE2:25.00", "UE3:25.00", "UE4:25.00"],
      "a Minya+Assiut branch splits 50% per governorate, then evenly inside each",
    );
    assert.deepEqual(
      shares("Anti Infective", governorates("minya")),
      ["UE1:50.00", "UE2:50.00"],
      "a Minya branch gives each of the two Minia reps half",
    );
  }

  // 2) Every split sums to exactly 1 — no value may be created or lost by mapping a branch.
  {
    const scopes: WeeklyBranchScope[] = [
      governorates("minya"), governorates("minya", "assiut"), governorates("sohag", "qena"),
      governorates("beni suef"), { kind: "region", regionCode: "UE" },
      { kind: "brick", brickId: "B214-M1", areaCode: "UE6" }, { kind: "area", areaCode: "UE2" },
    ];
    for (const line of ["Anti Infective", "Pedia", "CNS"]) {
      for (const scope of scopes) {
        const resolved = resolveBranchAreaShares(index, line, scope);
        if (resolved.length === 0) continue;
        const sum = resolved.reduce((a, s) => a + s.weight, 0);
        assert.ok(Math.abs(sum - 1) < 1e-9, `${line} ${scope.kind} shares must sum to 1, got ${sum}`);
      }
    }
  }

  // 3) THE POINT OF THE WHOLE MODULE — "Upper Egypt" means a different set of areas on each line,
  //    and the owner stated exactly this: Beni Suef is Upper Egypt on Anti Infective, Giza on
  //    Pedia, Others on CNS. Nothing here special-cases Beni Suef; the organogram does it.
  {
    const ai = shares("Anti Infective", { kind: "region", regionCode: "UE" });
    assert.equal(ai.length, 9, "Anti Infective Upper Egypt is nine areas — UE-1 and UE-2 together");
    assert.ok(ai.includes("UE9:11.11"), "Beni Suef IS inside Anti Infective's Upper Egypt");

    for (const line of ["Pedia", "CNS"]) {
      const flat = shares(line, { kind: "region", regionCode: "UE" });
      assert.equal(flat.length, 7, `${line} Upper Egypt is seven areas`);
      assert.ok(!flat.some((s) => s.startsWith("UE9:")), `Beni Suef is NOT inside ${line}'s Upper Egypt`);
      assert.ok(!flat.some((s) => s.startsWith("UE8:")), `Qena 2 is NOT inside ${line}'s Upper Egypt`);
    }
  }

  // 4) The district refinement. Anti Infective has no region literally called "UE" — it has UE-1
  //    and UE-2 — so an exact-match-only lookup would return nothing and silently drop the branch.
  {
    assert.deepEqual(
      shares("Anti Infective", { kind: "region", regionCode: "UE-1" }),
      ["UE1:33.33", "UE2:33.33", "UE9:33.33"],
      "UE-1 alone is Minia 1, Minia 2 and Beni Suef",
    );
    assert.equal(
      resolveBranchAreaShares(index, "Anti Infective", { kind: "region", regionCode: "UE" }).length, 9,
      "a plain UE scope still resolves on Anti Infective, via its UE-1/UE-2 refinements",
    );
  }

  // 5) An explicit governorate still lands where the organogram files it — including in Others.
  {
    assert.deepEqual(shares("Anti Infective", governorates("beni suef")), ["UE9:100.00"], "Beni Suef is one area");
    assert.deepEqual(shares("Pedia", governorates("beni suef")), ["UE9:100.00"], "Pedia still resolves Beni Suef — into Giza");
    assert.deepEqual(shares("CNS", governorates("beni suef")), ["UE9:100.00"], "CNS still resolves Beni Suef — into Others");
  }

  // 6) A brick is never split. The owner's correction: البلينا and ملاوى are bricks, not questions.
  {
    assert.deepEqual(
      shares("Anti Infective", { kind: "brick", brickId: "B214-M1", areaCode: "UE6" }),
      ["UE6:100.00"], "a brick resolves to its one area at 100%",
    );
    assert.deepEqual(
      shares("Pedia", { kind: "brick", brickId: "B204-2", areaCode: "UE2" }),
      ["UE2:100.00"], "a brick does not depend on the line",
    );
  }

  // 7) Effective dating — a future seat and a retired seat are both invisible today.
  {
    const minia = shares("Anti Infective", governorates("minya"));
    assert.deepEqual(minia, ["UE1:50.00", "UE2:50.00"], "Minia 8 (retired) and Minia 9 (not started) must not dilute the split");
  }

  // 8) Governorate parsing — the rep number is stripped, with or without a space.
  {
    assert.equal(governorateOfAreaName("Minia 1"), "minia");
    assert.equal(governorateOfAreaName("Sohag1"), "sohag");
    assert.equal(governorateOfAreaName("Qena 2"), "qena");
    assert.equal(governorateOfAreaName("Beni Suef"), "beni suef", "a name with no rep number is the governorate itself");
    assert.equal(governorateOfAreaName(null), "");
  }

  // 9) Unknown scopes resolve to nothing rather than to a wrong manager.
  {
    assert.deepEqual(resolveBranchAreaShares(index, "Anti Infective", governorates("atlantis")), []);
    assert.deepEqual(resolveBranchAreaShares(index, "Head Office", governorates("minya")), [],
      "Head Office is not on the organogram — it must not resolve to a sales area");
    assert.deepEqual(resolveBranchAreaShares(index, "Anti Infective", null), []);
  }

  // 10) The calculation the mapping sheet prints — the owner asked to SEE the arithmetic.
  {
    const text = describeBranchAreaShares(index, resolveBranchAreaShares(index, "Anti Infective", governorates("minya")), 1155836);
    assert.ok(text.includes("UE1 Minia 1 50%"), `share label names the area, got: ${text}`);
    assert.ok(text.includes("577,918"), `share label shows the EGP, got: ${text}`);
  }
}
