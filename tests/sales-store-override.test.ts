import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyCustomerChannel,
  isStoreCustomer,
  isStoreCustomerForPeriod,
  isStoreOverride,
  legacyIsStoreCustomer,
  STORE_OVERRIDE_CUSTOMER_KEYS,
  storeOverrideReason,
} from "../src/lib/sales/customer-channel.ts";
import {
  isSplitEligible,
  isStoreCitySplitActive,
  splitTargetsFor,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";

// The owner ruled on 2026-08-07 that ابن خلدون (client code 446299, distributor IBNSINA) is a
// genuine Menoufia wholesaler that must be split across Menoufia's areas like the other four
// wholesalers there, even though production confirms its name is exactly "ابن خلدون" on every
// period on record — none of the six STORE_NAME_KEYWORDS. This is the mirror image of
// sales-pharmacy-override.test.ts: that file pins a store-by-keyword forced to pharmacy, this one
// pins a pharmacy-by-default forced to store.

const IBN_KHALDOUN = { code: "446299", distributorCode: "IS-S", name: "ابن خلدون" };

function splitRow(over: Partial<StoreSplitRow> = {}): StoreSplitRow {
  return {
    areaCode: "D12",
    clientCode: IBN_KHALDOUN.code,
    clientName: IBN_KHALDOUN.name,
    distributorCode: IBN_KHALDOUN.distributorCode,
    includedInClosing: true,
    isDirect: false,
    officialLine: "Anti Infective",
    productCode: "SA001",
    qty: 200,
    salesValue: 22230,
    ...over,
  };
}

export async function runSalesStoreOverrideTests() {
  // ── the override is recognised, and zero-padding does not defeat it ────────────────────────
  assert.ok(isStoreOverride(IBN_KHALDOUN.code, "is-s"), "the distributor-scoped code is recognised");
  assert.ok(isStoreOverride("0000446299", " IS-S "), "padding and casing do not defeat the key");
  assert.ok(!isStoreOverride(IBN_KHALDOUN.code, "OTHER"), "the same code at another distributor is untouched");
  assert.ok(!isStoreOverride("446300", "IS-S"), "a neighbouring code is not swept in");
  assert.ok(!isStoreOverride("", "IS-S"), "a blank code overrides nothing");
  assert.ok(!isStoreOverride(null, "IS-S"), "a missing code overrides nothing");

  // ── classification honours the ruling despite no keyword in the name ──────────────────────
  assert.equal(
    classifyCustomerChannel(IBN_KHALDOUN.name, IBN_KHALDOUN.code, IBN_KHALDOUN.distributorCode),
    "store",
    "ابن خلدون is a store despite carrying none of the six store words",
  );
  // Without the code, nothing signals a store, and the classifier's honest fallback is pharmacy —
  // pinning the silent-failure mode: a caller that forgets to pass the code gets the OLD answer.
  assert.equal(
    classifyCustomerChannel(IBN_KHALDOUN.name, IBN_KHALDOUN.code, "OTHER"),
    "pharmacy",
    "the same code at another distributor falls back to the keyword-less default",
  );
  assert.equal(storeOverrideReason(IBN_KHALDOUN.code, IBN_KHALDOUN.distributorCode), "Owner-approved store");
  // A genuine keyword-matched store is untouched by this override existing at all.
  assert.equal(classifyCustomerChannel("مخزن القادسية", "0001539521"), "store");

  // ── and the SPLIT starts moving its money ──────────────────────────────────────────────────
  // This is the point of the exercise: this wholesaler's sale must now spread across Menoufia's
  // areas instead of sitting entirely on the one area (Menoufia 1 / D12) it happened to book on.
  assert.equal(
    isSplitEligible(splitRow()),
    true,
    "ابن خلدون's Menoufia sale must now be split — it was not before this override",
  );
  // The control: a customer with no override and no keyword is still left alone.
  assert.equal(
    isSplitEligible(splitRow({ clientCode: "999999", clientName: "صيدلية النور" })),
    false,
    "an un-overridden, un-keyworded pharmacy is still never split",
  );
  assert.equal(
    isSplitEligible(splitRow({ distributorCode: "OTHER" })),
    false,
    "a cross-distributor code collision is never split by Ibn Khaldoun's ruling",
  );

  // isStoreCustomer is what the split asks, so it must agree with the classifier here.
  assert.equal(isStoreCustomer(IBN_KHALDOUN.name, IBN_KHALDOUN.code, IBN_KHALDOUN.distributorCode), true);
  assert.equal(isStoreCustomer(IBN_KHALDOUN.name), false, "again: no code, no override");
  assert.equal(isStoreCustomer("مخزن القادسية", "0001539521"), true);

  await runAmerQutbRulingTests();
  await runAlFatehRulingTests();

  assert.equal(STORE_OVERRIDE_CUSTOMER_KEYS.size, 6, "the three earlier rulings plus the three الفاتح Delta accounts");

  const channelsByRepSource = readFileSync(
    new URL("../src/lib/sales/channels-by-rep.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    channelsByRepSource,
    /p_store_override_keys:\s*\[\.\.\.STORE_OVERRIDE_CUSTOMER_KEYS\]/,
    "Channels by Rep must pass the same distributor-scoped override keys as Monthly Closing",
  );

  const migration = readFileSync(
    new URL("../supabase/migrations/20260807044131_scope_store_override_and_channels_by_rep.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /split_part\(c, '\|', 1\)/, "closing RPCs must compare the distributor part");
  assert.match(migration, /p_store_override_keys text\[\]/, "Channels by Rep must accept owner overrides");
  assert.match(
    migration,
    /split_part\(k, '\|', 1\)/,
    "Channels by Rep must scope an override to the distributor before matching its client code",
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// عامر قطب (402837, IS) — owner ruling 2026-09-10: a warehouse, split it.
//
// WHY THIS NEEDS ITS OWN BLOCK RATHER THAN A ROW IN THE FIXTURE ABOVE. ابن خلدون trades on IS-S and
// its month is Anti Infective, where the cutover means the NEW rule answers. This one trades on IS
// and its money is AUGUST CNS, whose cutover is 2026-09 — so the August closing asks
// `legacyIsStoreCustomer`, not `isStoreCustomer`. An override that reached only the new rule would
// classify this customer correctly on every screen and move nothing at all in the one month the
// owner ruled about, with no error anywhere. The legacy assertion below is the load-bearing one.
const AMER_QUTB = { code: "402837", distributorCode: "IS", name: "عامر قطب" };

// The same shop at Elgomhouria — same building 265, same shop 8, a different distributor's own code.
// Owner 2026-09-10, asked separately and answered "yes add it too".
const AMER_QUTB_EG = { code: "33995", distributorCode: "EG", name: "عامر قطب - جمعيه احمد عرابى" };

// Its August 2026 CNS month, as production holds it: one line, 1,300 units of TE001, on CA4.
const AMER_AUGUST_VALUE = 78975;
const CAIRO_AREAS = ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6"];

function amerRow(over: Partial<StoreSplitRow> = {}): StoreSplitRow {
  return {
    areaCode: "CA4",
    clientCode: AMER_QUTB.code,
    clientName: AMER_QUTB.name,
    distributorCode: AMER_QUTB.distributorCode,
    includedInClosing: true,
    isDirect: false,
    officialLine: "CNS",
    productCode: "TE001",
    qty: 1300,
    salesValue: AMER_AUGUST_VALUE,
    ...over,
  };
}

async function runAmerQutbRulingTests(): Promise<void> {
  // ── the key is recognised, and only at Ibn Sina ────────────────────────────────────────────
  assert.ok(isStoreOverride(AMER_QUTB.code, "is"), "the distributor-scoped code is recognised");
  assert.ok(isStoreOverride("0000402837", " IS "), "padding and casing do not defeat the key");
  assert.ok(
    !isStoreOverride(AMER_QUTB.code, "EG"),
    "Ibn Sina's code number is not a licence at Elgomhouria — each account is keyed separately",
  );
  assert.ok(!isStoreOverride("402838", "IS"), "a neighbouring code is not swept in");

  // ── the SAME SHOP at Elgomhouria — owner 2026-09-10, "yes add it too" ──────────────────────
  // Two distributors independently recording عقار 265 / محل 8 is the address-based identity signal
  // AGENTS.md §2.3 accepts. It was left out of the first pass and put to the owner rather than
  // inferred, which is why it is a second ruling and not a second guess.
  assert.ok(isStoreOverride(AMER_QUTB_EG.code, "eg"), "the Elgomhouria account is recognised");
  assert.ok(isStoreOverride("0033995", " EG "), "padding and casing do not defeat it either");
  assert.ok(
    !isStoreOverride(AMER_QUTB_EG.code, "IS"),
    "and Elgomhouria's code number is not a licence at Ibn Sina",
  );
  assert.equal(
    legacyIsStoreCustomer(AMER_QUTB_EG.name, AMER_QUTB_EG.code, AMER_QUTB_EG.distributorCode),
    true,
    "the legacy rule honours it too, so a pre-September month would split it if one had sales",
  );
  assert.equal(
    classifyCustomerChannel(AMER_QUTB_EG.name, AMER_QUTB_EG.code, AMER_QUTB_EG.distributorCode),
    "store",
    "and every screen shows the Elgomhouria account as a store",
  );
  // 🔴 THE POINT OF THIS KEY IS THAT IT MOVES NOTHING YET. Its only production periods are 2026-01,
  // 2026-06 and 2026-07, all before the split gate, so no figure changes. It decides the FIRST month
  // at or after August in which this account sells — pinned here so a later session measuring 0.00
  // reads it as correct rather than as a broken override.
  assert.equal(
    isSplitEligible(
      amerRow({
        areaCode: "CA4",
        clientCode: AMER_QUTB_EG.code,
        clientName: AMER_QUTB_EG.name,
        distributorCode: AMER_QUTB_EG.distributorCode,
        qty: 10,
        salesValue: 810,
      }),
      "2026-07",
    ),
    true,
    "the ruling reaches the Elgomhouria row itself",
  );
  assert.equal(
    isStoreCitySplitActive("2026-06"),
    false,
    "but none of its three periods divides, so this key moves 0.00 today",
  );

  // ── the name alone still says pharmacy, so the override is provably what does the work ─────
  assert.equal(
    isStoreCustomer(AMER_QUTB.name),
    false,
    "the name carries no store word and no trade phrase — without the code this is a pharmacy",
  );
  assert.equal(
    classifyCustomerChannel(AMER_QUTB.name, AMER_QUTB.code, "EG"),
    "pharmacy",
    "the same code at another distributor keeps the keyword-less default",
  );

  // ── THE LOAD-BEARING ONE: August CNS runs the LEGACY rule, and the override must reach it ──
  assert.equal(
    legacyIsStoreCustomer(AMER_QUTB.name, AMER_QUTB.code, AMER_QUTB.distributorCode),
    true,
    "the pre-2026-09-06 rule must honour the override — this is what August CNS asks",
  );
  assert.equal(
    isStoreCustomerForPeriod(AMER_QUTB.name, AMER_QUTB.code, AMER_QUTB.distributorCode, "2026-08", "CNS"),
    true,
    "August 2026 CNS sees عامر قطب as a warehouse",
  );
  assert.equal(
    isStoreCustomerForPeriod(AMER_QUTB.name, AMER_QUTB.code, AMER_QUTB.distributorCode, "2026-09", "CNS"),
    true,
    "and so does September, under the newer rule",
  );
  assert.equal(
    classifyCustomerChannel(AMER_QUTB.name, AMER_QUTB.code, AMER_QUTB.distributorCode),
    "store",
    "every screen shows it as a store too",
  );
  assert.equal(storeOverrideReason(AMER_QUTB.code, AMER_QUTB.distributorCode), "Owner-approved store");

  // ── and its August money actually moves, across all six Cairo areas ───────────────────────
  assert.equal(
    isSplitEligible(amerRow(), "2026-08"),
    true,
    "the August CNS line must now split — it did not before this ruling",
  );
  const plan = splitTargetsFor(amerRow());
  assert.ok(plan, "a Cairo warehouse always has a split plan");
  assert.equal(plan?.group, "Cairo");
  assert.deepEqual([...(plan?.homeAreas ?? [])].sort(), CAIRO_AREAS, "all six Cairo areas take a share");
  assert.deepEqual(plan?.awayAreas, [], "an Ibn Sina warehouse never reaches outside its own city");
  assert.equal(plan?.homeFraction, 1, "nothing leaves Cairo — the El Qema national band is not this rule");
  assert.equal(
    AMER_AUGUST_VALUE / CAIRO_AREAS.length,
    13162.5,
    "each Cairo area takes 13,162.50 of the 78,975.00, so CA4 gives up 65,812.50",
  );

  // ── the control: earlier months cannot move, because the SPLIT is period-gated ─────────────
  // This customer also has 2026-01, 2026-02 and 2026-07 CNS rows. The override is not dated, so it
  // re-answers "warehouse?" for them too — and none of them divides, because no month before
  // 2026-08 splits at all. That gate, not the override, is what keeps published months still.
  assert.equal(isStoreCitySplitActive("2026-07"), false, "July 2026 never splits, so its 2,409.75 cannot move");
  assert.equal(isStoreCitySplitActive("2026-01"), false, "nor January");
  assert.equal(isStoreCitySplitActive("2026-08"), true, "August 2026 does");

  // A pharmacy in the same brick is still left alone — the ruling is about one account, not a brick.
  assert.equal(
    isSplitEligible(amerRow({ clientCode: "999999", clientName: "صيدلية الحى السادس" }), "2026-08"),
    false,
    "a neighbouring pharmacy in brick B12-12 is untouched",
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// الفاتح, Delta 1 — owner ruling 2026-09-23: one wholesaler mis-booked as pharmacies, split it.
//
// The bare-name Delta accounts carry none of the six store words and no trade phrase, so both rules
// call each a pharmacy. Its Helwan branch «الفاتح لتجارة وتوزيع الادويه» is a store on the trade
// phrase already; these three are keyed by (distributor, code). The load-bearing one is 446433, whose
// money is AUGUST ANTI INFECTIVE — cutover 2026-09, so August asks legacyIsStoreCustomer, exactly like
// عامر's August CNS. The owner UNLOCKED August Anti Infective on 2026-09-22 to take this restatement.
const AL_FATEH = { code: "446433", distributorCode: "IS-S", name: "الفاتح" };
const AL_FATEH_AUGUST_VALUE = 17190;
const GHARBIA_AREAS = ["D14", "D15"];

function alFatehRow(over: Partial<StoreSplitRow> = {}): StoreSplitRow {
  return {
    areaCode: "D15",
    clientCode: AL_FATEH.code,
    clientName: AL_FATEH.name,
    distributorCode: AL_FATEH.distributorCode,
    includedInClosing: true,
    isDirect: false,
    officialLine: "Anti Infective",
    productCode: "SA001",
    qty: 200,
    salesValue: AL_FATEH_AUGUST_VALUE,
    ...over,
  };
}

async function runAlFatehRulingTests(): Promise<void> {
  // ── the three keys are recognised, and only at their own distributor ────────────────────────
  assert.ok(isStoreOverride(AL_FATEH.code, "is-s"), "the Mahalla account is recognised");
  assert.ok(isStoreOverride("0000446433", " IS-S "), "padding and casing do not defeat the key");
  assert.ok(!isStoreOverride(AL_FATEH.code, "PS"), "the same code number is not a licence at another distributor");
  assert.ok(isStoreOverride("0001552831", "ps"), "the Tanta account is recognised");
  assert.ok(isStoreOverride("1520649", "PS"), "the second Mahalla account is recognised");
  assert.ok(!isStoreOverride("446434", "IS-S"), "a neighbouring code is not swept in");

  // ── the name alone says pharmacy, so the override is provably what does the work ────────────
  assert.equal(isStoreCustomer(AL_FATEH.name), false, "bare «الفاتح» carries no store word — without the code it is a pharmacy");
  assert.equal(
    classifyCustomerChannel(AL_FATEH.name, AL_FATEH.code, "PS"),
    "pharmacy",
    "the same code number at another distributor keeps the keyword-less default",
  );
  assert.equal(
    classifyCustomerChannel(AL_FATEH.name, AL_FATEH.code, AL_FATEH.distributorCode),
    "store",
    "but at IS-S the owner ruling makes it a store",
  );
  assert.equal(storeOverrideReason(AL_FATEH.code, AL_FATEH.distributorCode), "Owner-approved store");

  // ── THE LOAD-BEARING ONE: August Anti Infective runs the LEGACY rule, and the override reaches it ──
  assert.equal(
    legacyIsStoreCustomer(AL_FATEH.name, AL_FATEH.code, AL_FATEH.distributorCode),
    true,
    "the pre-2026-09-06 rule must honour the override — this is what August Anti Infective asks",
  );
  assert.equal(
    isStoreCustomerForPeriod(AL_FATEH.name, AL_FATEH.code, AL_FATEH.distributorCode, "2026-08", "Anti Infective"),
    true,
    "August 2026 Anti Infective sees الفاتح as a warehouse",
  );

  // ── and its August money moves, evenly across Gharbia's two areas ───────────────────────────
  assert.equal(
    isSplitEligible(alFatehRow(), "2026-08"),
    true,
    "the August Anti Infective line must now split — it did not before this ruling",
  );
  const plan = splitTargetsFor(alFatehRow());
  assert.ok(plan, "a Gharbia warehouse always has a split plan");
  assert.deepEqual([...(plan?.homeAreas ?? [])].sort(), GHARBIA_AREAS, "both Gharbia areas take a share");
  assert.deepEqual(plan?.awayAreas, [], "a Gharbia warehouse never reaches outside its own city");
  assert.equal(plan?.homeFraction, 1, "nothing leaves Gharbia — this is the plain city rule, not El Qema");
  assert.equal(
    AL_FATEH_AUGUST_VALUE / GHARBIA_AREAS.length,
    8595,
    "each Gharbia area takes 8,595.00 of the 17,190.00, so Mahalla (D15) gives up 8,595.00 to Tanta (D14)",
  );

  // ── the control: July never splits, so its 50 units stay whole on Mahalla ───────────────────
  assert.equal(isStoreCitySplitActive("2026-07"), false, "July 2026 never splits, so the July Anti Infective line cannot move");

  // ── the two zero-move siblings are stores on every screen, and move nothing today ───────────
  assert.equal(classifyCustomerChannel("الفاتح طنطا", "0001552831", "PS"), "store", "the Tanta account shows as a store");
  assert.equal(classifyCustomerChannel("الفاتح المحلة", "1520649", "PS"), "store", "the second Mahalla account shows as a store");

  // ── a neighbouring pharmacy in the same brick is untouched — the ruling is about these accounts ──
  assert.equal(
    isSplitEligible(alFatehRow({ clientCode: "888888", clientName: "صيدلية النصر" }), "2026-08"),
    false,
    "an un-overridden pharmacy in the same brick is never split",
  );
}
