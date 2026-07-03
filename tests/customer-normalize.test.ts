import assert from "node:assert/strict";

import {
  addressTokenOverlap,
  customerAddressTokens,
  normalizeCustomerNameKey,
} from "../src/lib/sales/normalizer/customer-normalize.ts";
import { detectChain, sameChainBranch } from "../src/lib/sales/normalizer/pharmacy-chains.ts";

export function runCustomerNormalizeTests() {
  // Taa marbuta equivalence — صيدلية and صيدليه are the same word.
  assert.equal(normalizeCustomerNameKey("صيدلية النور"), normalizeCustomerNameKey("صيدليه النور"));

  // Entity-prefix stripping: صيدلية د/ أحمد → احمد (alef unified, prefix + honorific stripped).
  assert.equal(normalizeCustomerNameKey("صيدلية د/ أحمد"), "احمد");
  assert.equal(normalizeCustomerNameKey("صيدلية دكتور أحمد على"), "احمد علي");
  assert.equal(normalizeCustomerNameKey("Dr. Ahmed Pharmacy"), normalizeCustomerNameKey("ahmed pharmacy"));

  // Latin prefixes strip too.
  assert.equal(normalizeCustomerNameKey("Pharmacy El Shefa"), "el shefa");

  // Respelled duplicates collapse to one key.
  assert.equal(
    normalizeCustomerNameKey("صيدلية د. محمد عبد الرحمن"),
    normalizeCustomerNameKey("صيدليه دكتور محمد عبد الرحمن"),
  );

  // Hamza carriers fold: مؤمن == مومن, هيئة == هيئه (via ئ→ي + ة→ه).
  assert.equal(normalizeCustomerNameKey("مؤمن"), normalizeCustomerNameKey("مومن"));

  // Arabic digit folding survives the customer layer.
  assert.equal(normalizeCustomerNameKey("صيدلية ١٩٠١١"), "19011");

  // Never strips the entire name away.
  assert.equal(normalizeCustomerNameKey("صيدلية"), "صيدليه");
  assert.equal(normalizeCustomerNameKey("د"), "د");

  // Idempotence: normalizing twice equals once.
  for (const sample of ["صيدلية د/ أحمد", "Dr. Ahmed Pharmacy", "العزبي مدينة نصر", "19011"]) {
    const once = normalizeCustomerNameKey(sample);
    assert.equal(normalizeCustomerNameKey(once), once);
  }

  // Empty / null-ish inputs.
  assert.equal(normalizeCustomerNameKey(""), "");
  assert.equal(normalizeCustomerNameKey(null), "");
  assert.equal(normalizeCustomerNameKey(undefined), "");

  // --- Chain detection ---

  const ezabyNasr = detectChain("صيدلية العزبي مدينة نصر");
  assert.ok(ezabyNasr);
  assert.equal(ezabyNasr.chainKey, "elezaby");
  assert.equal(ezabyNasr.branchToken, "مدينه نصر");

  const ezabyEnglish = detectChain("El Ezaby Pharmacy - Assiut");
  assert.ok(ezabyEnglish);
  assert.equal(ezabyEnglish.chainKey, "elezaby");

  const c19011 = detectChain("صيدليات ١٩٠١١ فرع المعادي");
  assert.ok(c19011);
  assert.equal(c19011.chainKey, "19011");
  assert.ok(c19011.branchToken.includes("المعادي"));

  // Non-chain pharmacy → null.
  assert.equal(detectChain("صيدلية النور الجديدة"), null);

  // Bare مصر in an address-like name must NOT match the misr chain.
  assert.equal(detectChain("صيدلية شارع مصر والسودان"), null);
  const misr = detectChain("صيدليات مصر فرع طنطا");
  assert.ok(misr);
  assert.equal(misr.chainKey, "misr");

  // Same chain, different branches → never the same branch.
  const a = detectChain("العزبي المنصورة");
  const b = detectChain("العزبي أسيوط");
  assert.ok(a && b);
  assert.equal(sameChainBranch(a, b), false);

  // Same chain, same branch (respelled) → matches.
  const c = detectChain("صيدلية العزبي المنصورة");
  const d = detectChain("العزبي المنصوره");
  assert.ok(c && d);
  assert.equal(sameChainBranch(c, d), true);

  // Unbranched chain name never asserts a branch match.
  const bare = detectChain("العزبي");
  assert.ok(bare);
  assert.equal(bare.branchToken, "");
  assert.equal(sameChainBranch(bare, a), false);

  // --- Address tokens + overlap ---

  const t1 = customerAddressTokens("شارع الجمهورية أمام المستشفى العام، المنصورة");
  const t2 = customerAddressTokens("ش الجمهوريه امام المستشفي العام المنصوره");
  assert.ok(addressTokenOverlap(t1, t2) >= 0.5);

  assert.equal(addressTokenOverlap(new Set(), t1), 0);
  assert.equal(addressTokenOverlap(customerAddressTokens("طنطا"), customerAddressTokens("اسوان")), 0);
}
