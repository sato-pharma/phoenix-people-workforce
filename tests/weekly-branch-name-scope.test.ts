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
  ["OT2", "Suez"], ["OT3", "Aswan (Legacy)"], ["OT5", "Hurgada"], ["OT6", "Luxor"], ["OT7", "Aswan"],
  ["OT8", "Red Sea"], ["OTMS", "Main Store"],
  ["UE1", "Minia 1"], ["UE2", "Minia 2"], ["UE3", "Assuit 1"], ["UE4", "Assuit 2"],
  ["UE5", "Sohag1"], ["UE6", "Sohag2"], ["UE7", "Qena 1"], ["UE8", "Qena 2"], ["UE9", "Beni Suef"],
].map(([area_code, area_name]) => ({ area_code, area_name }));

/**
 * One line that maps every area above, so a reading is never hidden by an absent seat.
 *
 * The region comes off the area code by dropping ONE trailing digit — D11 is in Delta (1), D26 in
 * Delta (2) — because that is what production does, and dropping all of them would put every Delta
 * area in a region called "D" and make a branch named "Delta (1)" resolve to nothing at all.
 *
 * The two Kafr El-Sheikh areas are then moved to Alex-BHR by hand, which is not tidiness: the
 * organogram really does seat them under the Alex-BHR manager on this line even though their codes
 * say Delta. It is the reason a region reading has to be taken from the map and never from the code.
 */
const MAP_ROWS = AREA_ROWS.map((a) => ({
  line_code: "anti_infective",
  area_code: a.area_code,
  operational_region_code: a.area_code === "D16" || a.area_code === "D17"
    ? "AB"
    : a.area_code.replace(/\d$/, "").replace("OTMS", "OT"),
  effective_from: "2026-07-13",
  effective_to: null,
}));

/**
 * A handful of real bricks, in the spelling `source_of_sales_bricks` actually uses.
 *
 * The owner's own correction: "El-Balyana is a brick — you can easily map it to an area. Also
 * Mallawi." The brick table writes Mallawi with an extra alef (ملاوى) and the depot writes ملوى,
 * one letter apart, so this fixture keeps the difference rather than papering over it.
 */
const BRICK_ROWS = [
  { brick_name: "ملاوى", area_code: "UE2" },
  { brick_name: "البلينا", area_code: "UE6" },
  { brick_name: "شبين الكوم", area_code: "D12" },
  // The same name in two areas answers nothing, so it must be dropped rather than guessed at.
  { brick_name: "بيلا", area_code: "D16" },
  { brick_name: "بيلا", area_code: "D17" },
];

const index = buildWeeklyAreaSplitIndex(MAP_ROWS, AREA_ROWS, "2026-08-27", BRICK_ROWS);

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
const MALLAWI = "ملوى";
const BALYANA = "جملة – البلينا";
const SHEBIN = "فرع شبين الكوم";

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
    // "Alex-BHR" is not two governorates written together — it is the NAME OF THE REGION, and the
    // longest phrase in the name wins, so it is read as one. That matters: the region reading takes
    // its areas from the organogram and therefore pays the two Kafr El-Sheikh areas the Alex-BHR
    // manager actually holds, which reading it as "Alexandria and Beheira" would silently miss.
    assert.deepEqual(
      split("Direct - Alex-BHR", "AB"),
      ["AB1:14.29", "AB2:14.29", "AB3:14.29", "AB4:14.29", "AB5:14.29", "D16:14.29", "D17:14.29"],
      "Alex-BHR is a region — its areas come from the organogram, Kafr El-Sheikh included",
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

  // 8) HEADLINE — a name that states a REGION is read as that region, not as a failure.
  //    "Direct – Delta (1)" carries EGP 1,791,647 in production. Six such names carry EGP 5,918,000
  //    between them, and treating them as unreadable strands every piastre at manager level.
  //    Its areas come from the MAP, which is why Kafr El-Sheikh is correctly absent here.
  {
    const reading = readWeeklyBranchName(index, "Direct - Delta (1)", "D1");
    assert.equal(reading.branchClass, "territory", "the name states a place — the region itself");
    assert.deepEqual(reading.scope, { kind: "region", regionCode: "D1" } as WeeklyBranchScope);
    assert.deepEqual(
      split("Direct - Delta (1)", "D1"),
      ["D11:20.00", "D12:20.00", "D13:20.00", "D14:20.00", "D15:20.00"],
      "Delta (1) pays the five areas the organogram puts in it — not the two the code spelling suggests",
    );
    assert.deepEqual(split("Direct - Upper Egypt", "UE").length, 9, "Upper Egypt names all nine of its areas");
  }

  // 8b) A name with no place at all falls back to the region the branch is already mapped to, and
  //     a bare "Delta" is deliberately one of those: EGP 900,983 sits under a name that matches
  //     neither Delta (1) nor Delta (2), so it must be the owner's own mapping that answers.
  {
    const bare = readWeeklyBranchName(index, "Super KA Delta", "D1");
    assert.equal(bare.branchClass, "unreadable", "a bare Delta names no region we have");
    assert.deepEqual(bare.scope, { kind: "region", regionCode: "D1" } as WeeklyBranchScope);
    assert.deepEqual(split("Super KA Delta_ك", "D1"), split("Super KA Delta", "D1"), "the mirror falls back the same way");
    assert.equal(readWeeklyBranchName(index, "Unallocated POS", "").scope, null, "no region to fall back on");
    assert.deepEqual(
      split("Direct - National", "NATIONAL"), [],
      "NATIONAL is not an operational region — the fallback resolves to nothing and the row stays put",
    );
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

  // 11) HEADLINE — a name that IS a brick resolves to that brick's one area, beating every coarser
  //     reading. Both are the owner's own examples. Mallawi is spelled ملوى by the depot and ملاوى
  //     by the brick table; read as a governorate instead it would pay Minia 1 half of a branch
  //     that belongs entirely to Minia 2.
  {
    assert.deepEqual(split(MALLAWI, "UE"), ["UE2:100.00"], "Mallawi is a brick in Minia 2, not half of Minia");
    assert.deepEqual(split(BALYANA, "UE"), ["UE6:100.00"], "El-Balyana is a brick in Sohag 2, not half of Sohag");
    // A brick also beats the governorate reading of the same name: Shebin El Kom is in Menoufia,
    // which would otherwise be D12 + D13 at 50% each.
    assert.deepEqual(split(SHEBIN, "D1"), ["D12:100.00"], "a brick beats its own governorate");
    // But only the WHOLE name is a brick. "Qena New Branch" is a depot in Qena, not a brick.
    assert.equal(split("فرع قنا الجديد", "UE").length, 2, "a brick must be the whole name, not a word inside it");
    // A brick name that exists in TWO areas answers nothing and must not be guessed at.
    assert.equal(readWeeklyBranchName(index, "بيلا", "D1").scope?.kind !== "brick", true, "an ambiguous brick name is not a brick reading");
  }

  // 12) HEADLINE — the ENGLISH spelling of a place must read the same as the Arabic one.
  //
  //     A distributor never writes the brick verbatim: the brick is قليوب, the depot is "Kalioub
  //     Branch". Until these were added the English name stated no place at all, so the branch fell
  //     back to its REGION and the money spread across every area in it — Aswan's depot was landing
  //     on fourteen areas and Ibnsina's Suez depot on the whole of Others.
  //
  //     Each expectation below is the area `source_of_sales_bricks` itself assigns, read from
  //     production 2026-08-27, never a judgement about Egyptian geography. That ordering is the
  //     owner's rule: the brick table outranks any map we could reason from.
  {
    const one = (name: string, region: string, area: string, brick: string) =>
      assert.deepEqual(split(name, region), [`${area}:100.00`], `${name} must read ${area} — brick ${brick}`);

    one("Ain Shams Branch", "CA", "CA3", "عين شمس الشرقيه / الغربيه");
    one("Kalioub Branch", "D1", "D11", "قليوب");
    one("Shbein El Kom Branch", "D1", "D12", "شبين الكوم");
    one("Fakous", "D2", "D25", "فاقوس");
    one("Suiz Branch", "OT", "OT2", "السويس");
    one("Bani Swif Regional", "GZ", "UE9", "مدينة بنى سويف");
    one("Maryoutia Branch", "GZ", "GZ4", "ترعة المريوطية");

    // The depot's OWN number must not be mistaken for one of ours — the same rule as block 3.
    // "Maryoutia 3" is Ibnsina's third Maryoutia depot; there is no area "Maryoutia 3".
    one("Maryoutia 3 Branch", "GZ", "GZ4", "ترعة المريوطية");

    // The mirror and the retail variants of the same town are the same town.
    one("Retail Fakous", "D2", "D25", "فاقوس");
    one("Retail Fakous_ك", "D2", "D25", "فاقوس");

    // GUARD — "shbein el kom" is registered as the WHOLE phrase precisely because شبين القناطر is a
    // different town in a different governorate (D11, not D12). A bare "shbein" would collapse the
    // two, which is the shortcut the Arabic alias table already takes and this one must not.
    assert.deepEqual(split("شبين الكوم", "D1"), ["D12:100.00"], "the Arabic brick still reads Menoufia 1");
    assert.notDeepEqual(
      split("Shbein El Qanater", "D1"),
      ["D12:100.00"],
      "a different Shebin must not inherit Shebin El Kom's area",
    );

    // GUARD — adding a new area to the Others fixture must not change a region reading's arithmetic.
    // OT2 exists now, so a branch naming the region spreads over one more seat, evenly and to 100%.
    const others = split("Direct - Others", "OT");
    assert.ok(others.some((entry) => entry.startsWith("OT2:")), `Suez must appear in an Others reading, got ${others}`);
    assert.equal(
      new Set(others.map((entry) => entry.split(":")[1])).size,
      1,
      `every seat takes an equal share, got ${others}`,
    );
    // Conservation is a property of the WEIGHTS, never of the printed percentages: seven equal
    // seats print as 14.29% each and those strings add to 100.03. The sheet is rounded on purpose,
    // so read the weights — this is the assertion that would catch a lost or duplicated seat.
    const weights = resolveBranchAreaShares(index, "Anti Infective", readWeeklyBranchName(index, "Direct - Others", "OT").scope);
    assert.equal(weights.reduce((total, share) => total + share.weight, 0).toFixed(10), "1.0000000000");
  }
}
