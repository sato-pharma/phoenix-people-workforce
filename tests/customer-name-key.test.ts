import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CUSTOMER_NAME_FOLDS_THAT_DIFFER,
  foldCustomerName,
  removeCustomerStopWords,
} from "../src/lib/customer-master/name-key.ts";
import {
  nameTokens,
  normalizeArabicPharmacyName,
  removeStopWords,
} from "../src/lib/pharmacy-master/pharmacy-matching.ts";
import { pharmacyNameKey } from "../src/lib/phoenix-crm/pharmacy-call-rules.ts";

// ─────────────────────────────────────────────────────────────────────────────
// ONE CUSTOMER NAME KEY (enterprise audit REC-009, F-SAL-010; 14 Nov 2026).
//
// `foldCustomerName` (src/lib/customer-master/name-key.ts) is the one exported matcher for a
// customer's name. Pharmacy Master, Pharmacy Search, Direct Orders and Phoenix CRM's pharmacy rules all
// read it. The owner chose "one home, no merges", so it is the old Pharmacy Master fold moved
// unchanged: no key and no match moved. Every other customer-name fold is listed, with its reason, in
// `CUSTOMER_NAME_FOLDS_THAT_DIFFER`. This file pins:
//   1. the table of sample names: which spellings are one customer, and which stay apart;
//   2. every caller reads the very same function, so the table answers alike from each;
//   3. no file folds Arabic letters without being sorted here, as the one key, a listed difference,
//      or not a customer's name.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Spellings of ONE customer: every one in a row folds to the row's key. */
const SAME_CUSTOMER: ReadonlyArray<{ key: string; spellings: readonly string[] }> = [
  { key: "صيدلية ابراهيم", spellings: ["صيدلية إبراهيم", "صيدلية ابراهيم", "صيدلية أبراهيم", "صيدلية  إبراهيم ", "صيدلية إبـراهيم"] },
  { key: "صيدلية مصطفي", spellings: ["صيدلية مصطفى", "صيدلية مصطفي", "صيدلية مُصْطَفَى"] },
  { key: "صيدلية محمد", spellings: ["صيدلية محمد", "صيدلية مُحَمَّد", "صيدلية ـمحمد", "صيدلية-محمد", "صيدلية (محمد)"] },
  { key: "صيدلية الامل", spellings: ["صيدلية الأمل", "صيدلية الامل", "صيدلية الآمل", "صيدلية الإمل", "صيدلية الأمل."] },
  { key: "صيدلية الشفا 2", spellings: ["صيدلية الشفا 2", "صيدلية الشفا - 2", "صيدلية الشفا (2)"] },
  { key: "el ezaby pharmacy", spellings: ["El Ezaby Pharmacy", "EL EZABY PHARMACY", "El-Ezaby Pharmacy", "El Ezaby  Pharmacy", "El Ézaby Pharmacy"] },
  { key: "seif pharmacies", spellings: ["Seif Pharmacies", "SEIF PHARMACIES", "Seif, Pharmacies"] },
  { key: "د علي", spellings: ["د. علي", "د.علي", "د/ علي", "د. على"] },
  { key: "", spellings: ["", "   ", "---", "..."] },
];

/** Pairs the key keeps APART — a fold that merged them would be a different matcher, not this one. */
const KEPT_APART: ReadonlyArray<readonly [string, string, string]> = [
  ["صيدلية النور", "صيدليه النور", "ة and ه stay apart (Phoenix CRM's pharmacyNameKey folds them, on top)"],
  ["صيدلية الهدى", "صيدلية الهدي 2", "a branch number is part of the name"],
  ["صيدلية أحمد", "صيدلية محمد", "different names"],
  ["صيدلية ٢", "صيدلية 2", "Arabic digits are not read as digits here (pharmacyNameKey does)"],
  ["صيدلية العزبي", "صيدليةالعزبي", "words are kept apart"],
];

function testTheSampleNameTable() {
  // HEADLINE: the table answers.
  for (const { key, spellings } of SAME_CUSTOMER) {
    for (const spelling of spellings) {
      assert.equal(foldCustomerName(spelling), key, `"${spelling}" is the customer "${key}"`);
    }
  }
  for (const [a, b, why] of KEPT_APART) {
    assert.notEqual(foldCustomerName(a), foldCustomerName(b), `"${a}" and "${b}" stay apart: ${why}`);
  }
  assert.equal(foldCustomerName(null), "");
  assert.equal(foldCustomerName(undefined), "");
  // The stop words come off a keyed name, never down to nothing.
  assert.equal(removeCustomerStopWords(foldCustomerName("صيدلية الشعب الجديدة")), "الشعب");
  assert.equal(removeCustomerStopWords(foldCustomerName("صيدلية فارما")), "صيدلية فارما");
}

function testEveryCallerReadsTheSameFunction() {
  // HEADLINE: the old address IS the one key — the same function object, so every input answers alike.
  assert.equal(normalizeArabicPharmacyName, foldCustomerName, "Pharmacy Master's old name is the one key itself");
  assert.equal(removeStopWords, removeCustomerStopWords, "and its stop-word removal");
  for (const { spellings } of SAME_CUSTOMER) {
    for (const spelling of spellings) {
      assert.deepEqual([...nameTokens(spelling)], removeCustomerStopWords(foldCustomerName(spelling)).split(" ").filter((t) => t.length >= 2), "Pharmacy Master's tokens are the key's words");
    }
  }
  // Phoenix CRM's pharmacy key builds ON the one key and only adds its own folds.
  for (const [a, b] of [["صيدلية النور", "صيدليه النور"], ["ص. إبراهيم", "صيدليه ابراهيم"]] as const) {
    assert.equal(pharmacyNameKey(a), pharmacyNameKey(b), `Phoenix CRM reads "${a}" and "${b}" as one pharmacy`);
  }
  assert.match(read("src/lib/phoenix-crm/pharmacy-call-rules.ts"), /const tokens = foldCustomerName\(digits\)/, "pharmacyNameKey starts from the one key");

  // Every caller imports it from the one home, not a copy.
  for (const file of [
    "src/lib/direct-orders/evidence-check.ts",
    "src/lib/direct-orders/geography-check.ts",
    "src/lib/pharmacy-search/locate.ts",
    "src/lib/pharmacy-search/profile.ts",
    "src/lib/pharmacy-search/save.ts",
    "src/lib/pharmacy-search/search.ts",
    "src/lib/phoenix-crm/pharmacy-call-rules.ts",
  ]) {
    const text = read(file);
    assert.match(text, /import \{ foldCustomerName(, removeCustomerStopWords)? \} from "@\/lib\/customer-master\/name-key";/, `${file} reads the one key`);
    assert.equal(/normalizeArabicPharmacyName/.test(text), false, `${file} no longer reaches it through Pharmacy Master`);
  }
  const matching = read("src/lib/pharmacy-master/pharmacy-matching.ts");
  assert.match(matching, /foldCustomerName as normalizeArabicPharmacyName/, "Pharmacy Master keeps its old name as the one key");
  assert.equal(/\.normalize\("NFKD"\)/.test(matching), false, "and holds no copy of the fold");
}

/** Every file under src/lib with a regex that folds the alef forms (أ إ آ to ا) — what a name fold always does. */
function alefFoldingFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && /\/\[(?=[^\]\n]*أ)(?=[^\]\n]*إ)(?=[^\]\n]*آ)[^\]\n]*\]\/g/.test(read(path))) out.push(path);
    }
  };
  walk("src/lib");
  return out.sort();
}

/** Files that fold Arabic for something that is not a customer's name — what each one folds. */
const NOT_A_CUSTOMER_NAME: Readonly<Record<string, string>> = {
  "src/lib/crm/account-doctor-notes.ts": "a doctor's note text",
  "src/lib/crm/campaign-contact-match.ts": "a contact PERSON's name (identityNameKey builds on it)",
  "src/lib/crm/campaign-note.ts": "a campaign note's words",
  "src/lib/geo/egypt-locations.ts": "a governorate or city",
  "src/lib/phoenix-crm/dictation-correct.ts": "dictated words",
  "src/lib/phoenix-crm/list-sheet-hours.ts": "a weekday in an opening-hours cell",
  "src/lib/recruitment/inbound/whatsapp-text-only-applicant.ts": "an applicant's message",
  "src/lib/recruitment/my-candidates-find.ts": "a candidate's name",
  "src/lib/sales/closing-organogram-regions.ts": "a region of the organogram",
  "src/lib/sales/normalizer/address-brick.ts": "an address",
  "src/lib/sales/weekly/governorates.ts": "a governorate",
  "src/lib/venues/pharmacy-code-suggestions.ts": "a town",
};

function testNoFoldIsUnsorted() {
  // HEADLINE: a file that folds Arabic letters is the one key, a listed difference, or not a customer's name.
  const listed = new Set(CUSTOMER_NAME_FOLDS_THAT_DIFFER.map((fold) => fold.file));
  const unsorted = alefFoldingFiles().filter(
    (file) => file !== "src/lib/customer-master/name-key.ts" && !listed.has(file) && !(file in NOT_A_CUSTOMER_NAME),
  );
  assert.deepEqual(
    unsorted,
    [],
    "a new Arabic fold: if it folds a customer's name, call foldCustomerName or add it to CUSTOMER_NAME_FOLDS_THAT_DIFFER; otherwise add it to NOT_A_CUSTOMER_NAME here",
  );
  // Each sorted file still folds — an entry for a fold that moved away would hide the next one.
  const folding = new Set(alefFoldingFiles());
  for (const file of Object.keys(NOT_A_CUSTOMER_NAME)) assert.ok(folding.has(file), `${file} still folds Arabic letters`);

  // Each listed difference names a real function, with a reason.
  for (const fold of CUSTOMER_NAME_FOLDS_THAT_DIFFER) {
    assert.ok(fold.why.length > 40 && fold.usedBy.length > 10, `${fold.name} says who reads it and why it differs`);
    if (fold.file.startsWith("supabase")) {
      const migrations = readdirSync(join(ROOT, "supabase/migrations"));
      assert.ok(
        migrations.some((name) => read(`supabase/migrations/${name}`).includes(`function public.${fold.name}(`)),
        `${fold.name} is defined by a migration`,
      );
    } else {
      assert.match(read(fold.file), new RegExp(`export function ${fold.name}\\(`), `${fold.name} is exported from ${fold.file}`);
    }
  }
  assert.equal(new Set(CUSTOMER_NAME_FOLDS_THAT_DIFFER.map((fold) => `${fold.file}#${fold.name}`)).size, CUSTOMER_NAME_FOLDS_THAT_DIFFER.length, "each listed once");
  assert.match(read("docs/customer-master.md"), /foldCustomerName/, "the ownership note names the one key");
}

export function runCustomerNameKeyTests() {
  testTheSampleNameTable();
  testEveryCallerReadsTheSameFunction();
  testNoFoldIsUnsorted();
}
