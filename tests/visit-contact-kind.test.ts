import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyVisitContactKind } from "../src/lib/crm/visit-workload.ts";

export function runVisitContactKindTests() {
  // ── The classifier: pharmacy / institution / doctor / unclassified ───────────────────────────
  assert.equal(classifyVisitContactKind("Pharmacy"), "pharmacy");
  assert.equal(classifyVisitContactKind("  pharmacy  "), "pharmacy", "vendor casing/whitespace never changes the kind");
  for (const institution of [
    "Hospital",
    "Private Hospital",
    "University Hospital",
    "Educational Hospital",
    "Armed Forces Hospital",
    "Polyclinics",
    "Health Insurance",
    "Contract",
  ]) {
    assert.equal(classifyVisitContactKind(institution), "institution", `${institution} is a place, not a person`);
  }
  for (const specialty of ["Internal Medicine", "Pediatrics", "ENT", "Neurology", "General Practitioner", "NICU"]) {
    assert.equal(classifyVisitContactKind(specialty), "doctor", `${specialty} is a medical specialty → doctor`);
  }
  assert.equal(classifyVisitContactKind(null), "unclassified", "campaign/meeting rows carry no speciality by vendor contract");
  assert.equal(classifyVisitContactKind(""), "unclassified");
  assert.equal(classifyVisitContactKind("   "), "unclassified");

  // ── Source contracts ─────────────────────────────────────────────────────────────────────────
  const workloadSource = readFileSync("src/lib/crm/visit-workload.ts", "utf8");
  assert.match(workloadSource, /speciality, visit_date, visit_type/, "the workload read must select speciality or every kind is unclassified");

  // The split is DISPLAY-ONLY (owner ruling 2026-08-02): the outstation decision engine must not
  // consume it — pharmacy visits still count toward eligibility exactly as before, until the owner
  // rules otherwise. If either rule below fires, someone silently turned display into policy.
  const decisionSource = readFileSync("src/lib/outstation/decision.ts", "utf8");
  assert.doesNotMatch(decisionSource, /pharmacy|speciality|contactKind/i, "decision.ts must stay pharmacy-blind — the split is display-only by owner ruling");

  // The snapshot merge must persist the split so the portal dashboard can show it without a live
  // CRM re-read — and it must come from the CRM rep-workload read, never the double-visit mirror.
  const evidenceSource = readFileSync("src/lib/outstation/workload-evidence.ts", "utf8");
  assert.match(evidenceSource, /doctorVisits: repWorkload\.doctorVisits/);
  assert.match(evidenceSource, /pharmacyVisits: repWorkload\.pharmacyVisits/);
  assert.match(evidenceSource, /institutionVisits: repWorkload\.institutionVisits/);
}
