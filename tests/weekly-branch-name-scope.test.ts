import assert from "node:assert/strict";

import {
  buildWeeklyAreaSplitIndex,
  resolveBranchAreaShares,
  type WeeklyBranchScope,
} from "../src/lib/sales/weekly/branch-area-split.ts";
import {
  classifyWeeklyBranch,
  readWeeklyBranchName,
} from "../src/lib/sales/weekly/branch-name-scope.ts";
import { normalizeArabic, placeMentions } from "../src/lib/sales/weekly/governorates.ts";

/**
 * Weekly sales arrive per DEPOT and the depot's NAME is the only statement of where the money went.
 * Measured on production 2026-08-27, 161 branches carrying EGP 57,105,208 reached a manager but no
 * rep purely because nobody read those names. This pins how they are read.
 *
 * The area list below is a verbatim copy of `source_of_sales_areas` in production, because the
 * whole difficulty is that the names are inconsistent — "Minia 1" is regular, "Gharbia 1 (Tanta)"
 * hides its number mid-string, "Alex East" has none, and "Port said - Domiat" is two governorates
 * in one area. An invented, tidy fixture would test a problem that does not exist.
 */
const AREA_ROWS = [
  ["AB1", "Alex East"], ["AB2", "Alex Center"], ["AB3", "Alex West"],
  ["AB4", "Behira 1"], ["AB5", "Behira 2"],
  ["CA1", "Heliopolis"], ["CA2", "Nasr City"], ["CA3", "Cairo East 1"],
  ["CA4", "Cairo East 2"], ["CA5", "Down town"], ["CA6", "Cairo West"],
  ["D11", "Qalubeya"], ["D12", "Menoufia 1"], ["D13", "Menoufia 2"],
  ["D14", "Gharbia 1 (Tanta)"], ["D15", "Gharbia 2 (Mahalla)"],
  ["D16", "Kafr El-Sheikh 1"], ["D17", "Kafr El-Sheikh 2"],
  ["D21", "Dakahlia 1"], ["D22", "Dakahlia 2"], ["D23", "Dakahlia 3"],
  ["D24", "Sharkia 1"], ["D25", "Sharkia 2"], ["D26", "Port said - Domiat"],
  ["GZ1", "Giza - Giza Centers"], ["GZ2", "Dokki - Mohandseen - Bolak"],
  ["GZ3", "Imbaba - Imbaba Centers"], ["GZ4", "Haram - Faisal"],
  ["GZ5", "Helwan-Maadi"], ["GZ6", "Fayoum"], ["GZ7", "October -Zayed"],
  ["OT3", "Aswan (Legacy)"], ["OT5", "Hurgada"], ["OT6", "Luxor"], ["OT7", "Aswan"],
  ["OT8", "Red Sea"], ["OTMS", "Main Store"],
  ["UE1", "Minia 1"], ["UE2", "Minia 2"], ["UE3", "Assuit 1"], ["UE4", "Assuit 2"],
  ["UE5", "Sohag1"], ["UE6", "Sohag2"], ["UE7", "Qena 1"], ["UE8", "Qena 2"], ["UE9", "Beni Suef"],
].map(([area_code, area_name]) => ({ area_code, area_name }));

/** One line that maps every area above, so a reading is never hidden by an absent seat. */
const MAP_ROWS = AREA_ROWS.map((a) => ({
  line_code: "anti_infective",
  area_code: a.area_code,
  operational_region_code: a.area_code.replace(/\d+$/, "").replace("OTMS", "OT"),
  effective_from: "2026-07-13",
  effective_to: null,
}));

const index = buildWeeklyAreaSplitIndex(MAP_ROWS, AREA_ROWS, "2026-08-27");

/** Read a branch name and render the split as "AREA:percent", the owner's own arithmetic. */
function split(branchName: string, region?: string): string[] {
  const reading = readWeeklyBranchName(index, branchName, region ?? null);
  if (!reading.scope) return [];
  return resolveBranchAreaShares(index, "Anti Infective", reading.scope)
    .slice()
    .sort((a, b) => a.areaCode.localeCompare(b.areaCode))
    .map((s) => `${s.areaCode}:${(s.weight * 100).toFixed(2)}`);
}

// Arabic names as escapes so this file cannot be corrupted by an editor or a shell heredoc.
const IMBABA = "ك.عملاء امبابة";
const DAKAHLIA2_DAMIETTA = "ك.ع.الدقهلية2 ودمياط";
const GHARBIA2 = "ك.عملاء الغربية 2";
const ALEX4 = "ك.عملاء اسكندرية 4";
const FAISAL_HARAM = "ك.عملاء فبصل والهرم";
const MINYA_ASSIUT = "ك.ع.المنيا واسيوط";
const ASWAN = "ك.عملاء اسوان";
const SOHAG_MIRROR = "ك.عملاء سوهاج_ك";
const SOHAG = "ك.عملاء سوهاج";
const TENDER = "مناقصات العبور";
const WAREHOUSE_AR = "مستودع القاهره الاقليمى";

export async function runWeeklyBranchNameScopeTests() {
  // 1) HEADLINE — a district that IS an area must not be smeared over its whole governorate.
  //    "ك.عملاء امبابة" carries EGP 2,235,364 in production and Imbaba is GZ3. Reading it as
  //    "somewhere in Giza" hands five sixths of that to reps the name never mentioned.
  {
    assert.deepEqual(split(IMBABA, "GZ"), ["GZ3:100.00"], "Imbaba is an area, not a hint about Giza");
    assert.deepEqual(split(FAISAL_HARAM, "GZ"), ["GZ4:100.00"], "Faisal and Haram are one area (GZ4), not two places");
    assert.equal(
      split("Super KA Giza", "GZ").length, 6,
      "but a branch naming GIZA itself spreads across all six Giza areas — GZ6 is Fayoum, not Giza",
    );
  }

  // 2) HEADLINE — a name listing two places splits evenly across them, then inside each.
  //    This is the owner's own worked example, and the mixed case he did not state but implied:
  //    Dakahlia **2** is one area while Damietta is a governorate, and they are still 50/50.
  {
    assert.deepEqual(
      split(MINYA_ASSIUT, "UE"),
      ["UE1:25.00", "UE2:25.00", "UE3:25.00", "UE4:25.00"],
      "Minya and Assiut: 50% per governorate, then evenly inside each",
    );
    assert.deepEqual(
      split(DAKAHLIA2_DAMIETTA, "D2"),
      ["D22:50.00", "D26:50.00"],
      "the 2 binds to Dakahlia, not to Damietta, and the two halves stay equal",
    );
    assert.deepEqual(
      split("Direct - Alex-BHR", "AB"),
      ["AB1:16.67", "AB2:16.67", "AB3:16.67", "AB4:25.00", "AB5:25.00"],
      "BHR is Beheira — dropping it would quietly pay Alexandria the whole branch",
    );
  }

  // 3) A number is only ours when an area answers to it. "Alexandria 4" is the DEPOT's numbering —
  //    our Alexandria areas are East, Center and West — so it must spread, not invent a fourth rep.
  {
    assert.deepEqual(split(GHARBIA2, "D1"), ["D15:100.00"], "Gharbia 2 is D15 by name");
    assert.deepEqual(
      split(ALEX4, "AB"),
      ["AB1:33.33", "AB2:33.33", "AB3:33.33"],
      "Alexandria has no numbered areas, so the depot's 4 is ignored",
    );
  }

  // 4) Every split sums to exactly 1 — mapping a branch must never create or destroy value.
  {
    for (const name of [IMBABA, DAKAHLIA2_DAMIETTA, MINYA_ASSIUT, ALEX4, GHARBIA2, ASWAN, "Direct - Alex-BHR", "Super KA Cairo"]) {
      const reading = readWeeklyBranchName(index, name, "AB");
      const shares = reading.scope ? resolveBranchAreaShares(index, "Anti Infective", reading.scope) : [];
      if (shares.length === 0) continue;
      const sum = shares.reduce((a, s) => a + s.weight, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `${name} must sum to 1, got ${sum}`);
    }
  }

  // 5) The three classes that are not territories keep region-level behaviour and are labelled.
  {
    for (const [name, expected] of [
      ["Almaza Storage", "warehouse"], [WAREHOUSE_AR, "warehouse"], ["Assiut 2 Warehouse", "warehouse"],
      [TENDER, "tender"], ["Private Hospi Cairo", "hospital"],
    ] as const) {
      assert.equal(classifyWeeklyBranch(name), expected, `${name} should classify as ${expected}`);
      assert.equal(readWeeklyBranchName(index, name, "CA").scope, null, `${name} must not split to reps`);
    }
    assert.equal(classifyWeeklyBranch(SOHAG), "territory");
  }

  // 6) The "overseas" mirror of a branch is the same branch. If the _ك suffix ever stopped being
  //    stripped, half of every key-account depot's value would silently stop splitting.
  {
    assert.deepEqual(split(SOHAG_MIRROR, "UE"), split(SOHAG, "UE"), "the _ك mirror reads identically");
    assert.deepEqual(split(SOHAG, "UE"), ["UE5:50.00", "UE6:50.00"]);
  }

  // 7) A retired seat must not be paid. OT3 is "Aswan (Legacy)" beside OT7 "Aswan"; left in, a
  //    branch named اسوان would send half of EGP 327,029 to a seat nobody sits in.
  {
    assert.deepEqual(split(ASWAN, "OT"), ["OT7:100.00"], "Aswan resolves to the live area only");
  }

  // 8) A name with no place falls back to its region rather than vanishing.
  {
    const reading = readWeeklyBranchName(index, "Direct - Delta (1)", "D1");
    assert.equal(reading.branchClass, "unreadable");
    assert.deepEqual(reading.scope, { kind: "region", regionCode: "D1" } as WeeklyBranchScope);
    assert.equal(readWeeklyBranchName(index, "Unallocated POS", "").scope, null, "no region to fall back on");
  }

  // 9) Arabic folding — a lookup must not depend on which alef or final letter was typed.
  {
    assert.equal(normalizeArabic("الدقهلية"), normalizeArabic("الدقهليه"));
    assert.equal(normalizeArabic("إمبابة"), normalizeArabic("امبابه"));
  }

  // 10) An overlapping phrase is consumed once. "Kafr El-Sheikh" must not also read as Kafr
  //     El-Zayat's governorate, and a place named twice counts once.
  {
    const mentions = placeMentions("Key Acc. W Kafr El Sheikh");
    assert.equal(mentions.length, 1, `expected one place, got ${JSON.stringify(mentions)}`);
    assert.equal(mentions[0].governorate, "kafr el-sheikh", "the canonical label comes from the shared geo table");
    assert.equal(placeMentions("Giza Giza Giza").length, 1, "a place named three times is one place");
  }
}
