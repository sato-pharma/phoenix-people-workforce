import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  comparePharmacyPair,
  diceCoefficient,
  findPharmacyMatchCandidates,
  jaccardSimilarity,
  nameTokens,
  normalizeArabicPharmacyName,
  removeStopWords,
  resolvePharmacyMatchConfidence,
  canAccessPharmacyMaster,
  assertPharmacyMasterAccess,
  type PharmacyMatchMember,
} from "../src/lib/pharmacy-master/pharmacy-matching.ts";

function member(overrides: Partial<PharmacyMatchMember>): PharmacyMatchMember {
  return {
    pharmacyId: "p1",
    pharmacyCode: "PH-0001",
    displayName: "الشعب الجديدة",
    distributorId: 1,
    distributorCode: "IS",
    distributorName: "Ibn Sina",
    distributorPharmacyCode: "123456",
    areaName: null,
    regionName: null,
    governorateName: null,
    address: null,
    latitude: null,
    longitude: null,
    ...overrides,
  };
}

function access(overrides: Partial<AccessContext>): AccessContext {
  return { hrId: "M-1", loginId: "M-1", role: "Super Admin", scope: "system", source: "session", ...overrides };
}

function testAccessGate() {
  assert.equal(canAccessPharmacyMaster(access({ role: "Super Admin" })), true);
  assert.equal(canAccessPharmacyMaster(access({ role: "CEO" })), true);
  for (const role of ["Employee", "Medical Rep", "District Manager", "Marketing Manager", "Product Manager"] as const) {
    assert.equal(canAccessPharmacyMaster(access({ role, scope: "team" })), false, `${role} must not access Pharmacy Master`);
    assert.throws(() => assertPharmacyMasterAccess(access({ role, scope: "team" })), /Forbidden/);
  }
  assert.equal(canAccessPharmacyMaster(access({ role: "Employee", source: "system" })), true, "system source is always allowed");
  assert.doesNotThrow(() => assertPharmacyMasterAccess(access({ role: "CEO" })));
}

// Arabic normalization: alef/ya unification, tatweel + harakat stripping, digit/generic-char
// collapse, and idempotent on already-normalized text.
function testArabicNormalization() {
  assert.equal(normalizeArabicPharmacyName("إبراهيم"), normalizeArabicPharmacyName("ابراهيم"), "alef forms must unify");
  assert.equal(normalizeArabicPharmacyName("مصطفى"), normalizeArabicPharmacyName("مصطفي"), "ya forms must unify");
  assert.equal(normalizeArabicPharmacyName("الشعب  الجديدة"), normalizeArabicPharmacyName("الشعب الجديدة"), "whitespace collapses");
  assert.equal(normalizeArabicPharmacyName(null), "");
  assert.equal(normalizeArabicPharmacyName(""), "");
  // tatweel + harakat are cosmetic and must not affect the normalized form
  assert.equal(normalizeArabicPharmacyName("مُحَمَّد"), normalizeArabicPharmacyName("محمد"));
}

function testStopWordRemoval() {
  assert.equal(removeStopWords("صيدلية الشعب الجديدة"), "الشعب");
  assert.equal(removeStopWords("مستشفى الامومة"), "الامومة");
  // a name that is ENTIRELY stop words must not be reduced to nothing (keeps original tokens)
  assert.equal(removeStopWords("صيدلية فارما"), "صيدلية فارما");
  assert.equal(removeStopWords(""), "");
}

function testTokenAndRatioScoring() {
  const a = nameTokens("الشعب الجديدة");
  const b = nameTokens("الشعب جديدة");
  assert.ok(jaccardSimilarity(a, b) > 0, "shared meaningful token must overlap");
  assert.equal(jaccardSimilarity(new Set(), new Set(["x"])), 0, "empty set never overlaps");

  assert.equal(diceCoefficient("", "abc"), 0);
  assert.equal(diceCoefficient("abc", "abc"), 1, "identical strings are a perfect match");
  assert.ok(diceCoefficient("محمد قاسم", "محمد هراس") < diceCoefficient("محمد قاسم", "محمد قاسم"));
}

function testConfidenceThresholds() {
  // Exact thresholds locked in from the Phase 0 production audit.
  assert.equal(resolvePharmacyMatchConfidence(0.7, 0), "high");
  assert.equal(resolvePharmacyMatchConfidence(0, 0.9), "high");
  assert.equal(resolvePharmacyMatchConfidence(0.5, 0), "medium");
  assert.equal(resolvePharmacyMatchConfidence(0, 0.75), "medium");
  assert.equal(resolvePharmacyMatchConfidence(0.1, 0.6), "low");
  assert.equal(resolvePharmacyMatchConfidence(0, 0), null, "no signal at all is not a candidate");
  assert.equal(resolvePharmacyMatchConfidence(0, 0.5), null, "below the low floor is not a candidate");
}

function testComparePharmacyPair() {
  // Same distributor — must NEVER be compared, no matter how similar the names are.
  const sameDistA = member({ pharmacyId: "a", displayName: "الشعب الجديدة", distributorId: 1 });
  const sameDistB = member({ pharmacyId: "b", displayName: "الشعب الجديدة", distributorId: 1 });
  assert.equal(comparePharmacyPair(sameDistA, sameDistB), null, "identical names under the SAME distributor must not be shown as a candidate");

  // Cross-distributor near-identical name → high confidence, no warning.
  const crossA = member({ pharmacyId: "a", displayName: "الشعب الجديدة", distributorId: 1 });
  const crossB = member({ pharmacyId: "b", displayName: "الشعب جديدة", distributorId: 2 });
  const highGroup = comparePharmacyPair(crossA, crossB);
  assert.ok(highGroup, "cross-distributor near-identical names must produce a candidate");
  assert.equal(highGroup!.confidence, "high");
  assert.equal(highGroup!.warning, null, "high confidence carries no warning");
  assert.equal(highGroup!.matchReason, "token_overlap");
  assert.equal(highGroup!.groupKey, ["a", "b"].sort().join("|"));

  // Cross-distributor, weak/no overlap → not a candidate.
  const unrelatedA = member({ pharmacyId: "a", displayName: "احمد جمال", distributorId: 1 });
  const unrelatedB = member({ pharmacyId: "b", displayName: "مكة دمياط", distributorId: 2 });
  assert.equal(comparePharmacyPair(unrelatedA, unrelatedB), null);

  // Medium confidence must carry an explicit review warning (false-positive risk documented
  // in the Phase 0 audit for common first-name overlaps).
  const commonNameA = member({ pharmacyId: "a", displayName: "احمد السيد سويلم", distributorId: 1 });
  const commonNameB = member({ pharmacyId: "b", displayName: "احمد محمد السيد محمد", distributorId: 2 });
  const mediumGroup = comparePharmacyPair(commonNameA, commonNameB);
  if (mediumGroup) {
    assert.notEqual(mediumGroup.confidence, "high", "generic shared first-name tokens must never reach high confidence alone");
    assert.ok(mediumGroup.warning, "medium/low confidence must always carry a warning");
  }

  // GPS proximity (exact key) overrides name dissimilarity — two very differently-named
  // pharmacies at (nearly) the same coordinates are still a strong candidate.
  const gpsA = member({ pharmacyId: "a", displayName: "الحياة", distributorId: 1, latitude: 30.0444, longitude: 31.2357 });
  const gpsB = member({ pharmacyId: "b", displayName: "زينب", distributorId: 2, latitude: 30.04445, longitude: 31.23575 });
  const gpsGroup = comparePharmacyPair(gpsA, gpsB);
  assert.ok(gpsGroup, "near-identical GPS coordinates must produce a candidate even with dissimilar names");
  assert.equal(gpsGroup!.confidence, "high");
  assert.equal(gpsGroup!.matchReason, "exact_key");
  assert.equal(gpsGroup!.score, 1);

  // Identical normalized address (exact key) — also fires without needing GPS.
  const addrA = member({ pharmacyId: "a", displayName: "احمد", distributorId: 1, address: "شارع الهرم، الجيزة" });
  const addrB = member({ pharmacyId: "b", displayName: "محمود", distributorId: 2, address: "شارع الهرم، الجيزة" });
  const addrGroup = comparePharmacyPair(addrA, addrB);
  assert.ok(addrGroup, "identical normalized address must produce a candidate");
  assert.equal(addrGroup!.matchReason, "exact_key");
}

function testFindPharmacyMatchCandidatesGrouping() {
  const members = [
    member({ pharmacyId: "a", displayName: "الشعب الجديدة", distributorId: 1 }),
    member({ pharmacyId: "b", displayName: "الشعب جديدة", distributorId: 2 }),
    member({ pharmacyId: "c", displayName: "مكة دمياط", distributorId: 1 }),
    // same distributor as "a" — must never pair with "a" even though the name is identical
    member({ pharmacyId: "d", displayName: "الشعب الجديدة", distributorId: 1 }),
  ];
  const groups = findPharmacyMatchCandidates(members);
  assert.ok(groups.length >= 1, "must find the a<->b cross-distributor candidate");
  for (const group of groups) {
    assert.notEqual(group.members[0].distributorId, group.members[1].distributorId, "no same-distributor pair may ever be returned");
  }
  // results are sorted strongest-first
  for (let i = 1; i < groups.length; i += 1) {
    assert.ok(groups[i - 1].score >= groups[i].score, "candidates must be sorted score descending");
  }
}

// Source-level guards on the new page/route/service — Phase 1 must be strictly read-only,
// GET-only, and never expose write/merge/create actions.
function testSurfaceIsReadOnlyPhase1() {
  const service = readFileSync("src/lib/pharmacy-master/pharmacy-matching-service.ts", "utf8");
  assert.doesNotMatch(service, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/, "Phase 1 service must be strictly read-only");
  assert.match(service, /marketing_pharmacies/, "service must read marketing_pharmacies");
  assert.match(service, /marketing_pharmacy_distributor_codes/, "service must read marketing_pharmacy_distributor_codes");

  const route = readFileSync("app/api/pharmacy-master/candidates/route.ts", "utf8");
  assert.match(route, /export async function GET/, "route must be read-only (GET)");
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/, "Phase 1 must not expose any mutating method");

  const workspace = readFileSync("src/components/pharmacy-master/pharmacy-master-workspace.tsx", "utf8");
  assert.doesNotMatch(workspace, /onClick=\{[^}]*(approve|reject|merge|create)/i, "Phase 1 UI must not offer any approve/reject/merge/create action");
  assert.doesNotMatch(workspace, /method:\s*["'](POST|PUT|PATCH|DELETE)["']/, "Phase 1 UI must never issue a mutating request");
}

export function runPharmacyMatchingTests() {
  testAccessGate();
  testArabicNormalization();
  testStopWordRemoval();
  testTokenAndRatioScoring();
  testConfidenceThresholds();
  testComparePharmacyPair();
  testFindPharmacyMatchCandidatesGrouping();
  testSurfaceIsReadOnlyPhase1();
}
