import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyCustomerChannel,
  HOSPITAL_NAME_KEYWORDS,
  isStoreCustomer,
  isStoreOverride,
  isPharmacyOverride,
  isWholesaleOnlyDistributor,
  matchedChannelKeywords,
  matchedHospitalKeywords,
  matchedNeverStoreKeywords,
  matchedStoreKeywords,
  matchedStorePrefixes,
  matchesTradePhrase,
  nameMatchesAnyKeyword,
  NEVER_STORE_KEYWORDS,
  normalizeCustomerName,
  PHARMACY_OVERRIDE_CHAINS,
  PHARMACY_OVERRIDE_CLIENT_CODES,
  PHARMACY_OVERRIDE_NAMES,
  STORE_NAME_KEYWORDS,
  STORE_NAME_PREFIXES,
  STORE_OVERRIDE_CUSTOMER_KEYS,
  STORE_OVERRIDE_NAMES,
  TRADE_BUSINESS_PAIR_STEMS,
  TRADE_BUSINESS_STEMS,
  TRADE_GOODS_STEMS,
  type ChannelNameKeyword,
} from "../src/lib/sales/customer-channel.ts";
import { stripComments } from "./support/comment-strip.ts";

// The classifier used to fold every keyword's stem again for every name it was asked about — ~58 stems per
// name — and that was ~0.35 ms a call: ~25 s of the web server's one thread for the Master Map's ~74,000 shops
// (measured 24 Oct 2026). The stems are now folded once per list. This decides which customers' sales the
// Monthly Closing spreads across a city, so NOT ONE ANSWER may move: every matcher is compared below against
// the old algorithm, written out plainly, on every stem the owner listed and the spellings distributors type.

// --- the old algorithm, verbatim in behaviour: fold the stem on every comparison -------------------------
const squash = (value: string | null | undefined) => normalizeCustomerName(value).replace(/\s+/g, "");

function oldMatch(name: string | null | undefined, keywords: readonly ChannelNameKeyword[]): string[] {
  const normalized = normalizeCustomerName(name);
  if (!normalized) return [];
  return keywords.filter((keyword) => normalized.includes(normalizeCustomerName(keyword.stem))).map((keyword) => keyword.label);
}

function oldPrefixes(name: string | null | undefined): string[] {
  const normalized = normalizeCustomerName(name);
  if (!normalized) return [];
  return STORE_NAME_PREFIXES.filter((entry) => normalized.startsWith(normalizeCustomerName(entry.stem))).map((entry) => entry.label);
}

function oldTrade(name: string | null | undefined): boolean {
  const squashed = squash(name);
  if (!squashed) return false;
  if (!TRADE_BUSINESS_STEMS.some((stem) => squashed.includes(stem))) return false;
  if (TRADE_BUSINESS_PAIR_STEMS.every((stem) => squashed.includes(stem))) return true;
  return TRADE_GOODS_STEMS.some((stem) => squashed.includes(stem));
}

function oldBoth(name: string | null | undefined, entries: readonly ChannelNameKeyword[]): string[] {
  const spaced = normalizeCustomerName(name);
  const squashed = squash(name);
  if (!spaced) return [];
  return entries
    .filter((entry) => {
      const stem = normalizeCustomerName(entry.stem);
      return spaced.includes(stem) || squashed.includes(stem.replace(/\s+/g, ""));
    })
    .map((entry) => entry.label);
}

const oldAny = (name: string | null | undefined, entries: readonly ChannelNameKeyword[]) => oldBoth(name, entries)[0] ?? null;

function oldIsStore(name: string | null | undefined, clientCode: string | null, distributorCode: string | null): boolean {
  if (isPharmacyOverride(clientCode)) return false;
  if (isStoreOverride(clientCode, distributorCode)) return true;
  if (oldAny(name, STORE_OVERRIDE_NAMES)) return true;
  if (oldAny(name, PHARMACY_OVERRIDE_NAMES)) return false;
  if (oldAny(name, PHARMACY_OVERRIDE_CHAINS)) return false;
  if (oldBoth(name, NEVER_STORE_KEYWORDS).length > 0) return false;
  if (isWholesaleOnlyDistributor(distributorCode)) return true;
  return oldMatch(name, STORE_NAME_KEYWORDS).length > 0 || oldPrefixes(name).length > 0 || oldTrade(name);
}

function oldClassify(name: string | null | undefined, clientCode: string | null, distributorCode: string | null) {
  if (oldMatch(name, HOSPITAL_NAME_KEYWORDS).length > 0) return "hospital";
  return oldIsStore(name, clientCode, distributorCode) ? "store" : "pharmacy";
}

// --- the corpus: every stem, in the spellings and spacings distributors really type ----------------------
const LISTS = [
  STORE_NAME_KEYWORDS,
  STORE_NAME_PREFIXES,
  HOSPITAL_NAME_KEYWORDS,
  NEVER_STORE_KEYWORDS,
  PHARMACY_OVERRIDE_CHAINS,
  STORE_OVERRIDE_NAMES,
  PHARMACY_OVERRIDE_NAMES,
];

function corpus(): Array<string | null | undefined> {
  const stems = [
    ...LISTS.flatMap((list) => list.map((entry) => entry.stem)),
    ...TRADE_BUSINESS_STEMS,
    ...TRADE_GOODS_STEMS,
  ];
  const fillers = ["صيدلية", "لتجارة وتوزيع"];
  const spellings = (stem: string) => [
    stem,
    ` ${stem} `,
    stem.replace(/ /g, "  "),
    stem.split("").join(" "),
    stem.replace(/ا/g, "أ"),
    stem.replace(/ه/g, "ة"),
    `x${stem}y`,
    stem.toUpperCase(),
  ];
  const names: Array<string | null | undefined> = [null, undefined, "", "   "];
  for (const stem of stems) {
    for (const spelling of spellings(stem)) {
      names.push(spelling);
      names.push(`${fillers[0]} ${spelling}`, `${spelling} ${fillers[1]}`, `أ َ ـ${spelling}`);
    }
  }
  for (let left = 0; left < stems.length; left += 1) {
    for (let right = left % 13; right < stems.length; right += 13) names.push(`${stems[left]} ${stems[right]}`);
  }
  return names;
}

function codePairs(): Array<[string | null, string | null]> {
  const pairs: Array<[string | null, string | null]> = [[null, null], ["1", "IS"], ["000123", "QM"], ["5", "qm"]];
  for (const code of [...PHARMACY_OVERRIDE_CLIENT_CODES].slice(0, 6)) pairs.push([code, "IS"]);
  for (const key of [...STORE_OVERRIDE_CUSTOMER_KEYS].slice(0, 6)) {
    const [distributor, code] = key.split("|");
    pairs.push([code, distributor], [`00${code}`, distributor.toLowerCase()]);
  }
  return pairs;
}

export function runCustomerChannelPreparedStemsTests() {
  const names = corpus();
  const pairs = codePairs();
  let compared = 0;

  for (const [index, name] of names.entries()) {
    const label = JSON.stringify(name);
    assert.deepEqual(matchedStoreKeywords(name), oldMatch(name, STORE_NAME_KEYWORDS), `store words for ${label}`);
    assert.deepEqual(matchedHospitalKeywords(name), oldMatch(name, HOSPITAL_NAME_KEYWORDS), `hospital words for ${label}`);
    assert.deepEqual(matchedStorePrefixes(name), oldPrefixes(name), `store prefixes for ${label}`);
    assert.deepEqual(matchedNeverStoreKeywords(name), oldBoth(name, NEVER_STORE_KEYWORDS), `never-a-store words for ${label}`);
    assert.equal(matchesTradePhrase(name), oldTrade(name), `trade phrase for ${label}`);
    const hospital = oldMatch(name, HOSPITAL_NAME_KEYWORDS);
    assert.deepEqual(matchedChannelKeywords(name), hospital.length > 0 ? hospital : oldMatch(name, STORE_NAME_KEYWORDS), `channel words for ${label}`);
    for (const list of LISTS) assert.equal(nameMatchesAnyKeyword(name, list), oldAny(name, list), `first matching entry for ${label}`);
    // Every name with no codes, and with one code pair in rotation, so every override is reached across
    // the corpus without multiplying it by the number of pairs.
    for (const [clientCode, distributorCode] of [pairs[0], pairs[1 + (index % (pairs.length - 1))]]) {
      assert.equal(isStoreCustomer(name, clientCode, distributorCode), oldIsStore(name, clientCode, distributorCode), `isStoreCustomer(${label}, ${clientCode}, ${distributorCode})`);
      assert.equal(classifyCustomerChannel(name, clientCode, distributorCode), oldClassify(name, clientCode, distributorCode), `classify(${label}, ${clientCode}, ${distributorCode})`);
      compared += 2;
    }
  }
  assert.ok(names.length > 2_000 && compared > 8_000, `the corpus must be wide enough to mean something — ${names.length} names, ${compared} classifications`);

  // A caller's OWN list (the venue guard passes the module's lists, but any array must work) is folded too.
  const own: ChannelNameKeyword[] = [{ label: "Own", stem: "مَخزن  الأمل" }];
  assert.equal(nameMatchesAnyKeyword("مخزن الامل للادوية", own), "Own");
  assert.equal(nameMatchesAnyKeyword("مخزنالامل", own), "Own", "the squashed form still matches a caller's own list");
  assert.equal(nameMatchesAnyKeyword("صيدلية النور", own), null);

  // --- source pins: the stems are folded once, never per name -------------------------------------------
  const source = stripComments(readFileSync(new URL("../src/lib/sales/customer-channel.ts", import.meta.url), "utf8"));
  const folds = source.match(/normalizeCustomerName\((?:keyword|entry)\.stem\)/g) ?? [];
  assert.equal(folds.length, 1, "a stem is folded in exactly one place — prepareKeywords — never inside a per-name matcher");
  assert.match(source, /const PREPARED_KEYWORDS = new WeakMap</, "each list's folded stems are kept, keyed by the list");
  assert.match(
    source,
    /function foldedIsStoreCustomer\([\s\S]*?foldedNeverStoreKeywords\(folded\)\.length > 0/,
    "the store decision folds the name once and hands it down",
  );
}
