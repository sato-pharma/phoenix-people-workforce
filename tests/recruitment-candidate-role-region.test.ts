import assert from "node:assert/strict";

import {
  candidateRegionForGovernorate,
  candidateRegionLabels,
  normalizeGovernorate,
} from "../src/lib/recruitment/candidate-region.ts";
import {
  candidateRoleFamily,
  candidateRoleFamilyLabels,
  candidateRoleFamilyOrNull,
  normalizeJobTitle,
} from "../src/lib/recruitment/candidate-role-family.ts";

export function runCandidateRoleRegionTests() {
  // --- The misspelling. Three people in production wrote "manger" on their CV, and a text search
  // --- for "district manager" returns none of them. This is the whole reason the family exists.
  for (const spelling of ["district manger", "district Manger", "District Manger"]) {
    assert.equal(
      candidateRoleFamily(spelling),
      "district_manager",
      `"${spelling}" is a District Manager despite the spelling`,
    );
  }

  // --- "District Sales Manager" does not contain the substring "district manager", so six more
  // --- people are invisible to a text search. Same family.
  for (const title of ["District Sales Manager", "district sales manager", "Pharmaceutical Area / District Sales Manager"]) {
    assert.equal(candidateRoleFamily(title), "district_manager", `"${title}" is a District Manager`);
  }

  // --- National Sales Manager. Added 2026-08-28 when the owner put it on the WhatsApp menu. These
  // --- are the SEVEN spellings production actually holds, read off ats_candidates that day. Every
  // --- one landed in `sales` before this family existed — the catch-all that runs last — so they
  // --- sorted below every medical rep in the screening queue.
  for (const title of [
    "National Sales Manager",
    "National sales manager",
    "NATIONAL SALES MANAGER - PHARMACEUTICALS",
    "National Sales Manger", // spelled that way on the CV; normalizeJobTitle repairs it first
    "National Sales Head",
    "Head of Sales (National Sales Manager)", // compound: bare "sales" would otherwise claim it
    "Market Access & National Sales Manager", // compound, and must not be read as marketing
  ]) {
    assert.equal(candidateRoleFamily(title), "national_sales_manager", `"${title}" is a National Sales Manager`);
  }

  // --- And it must not steal anyone. A district or regional seat is not a national one, and the
  // --- bare abbreviation is deliberately unmatched — nobody in this pool uses it.
  assert.equal(candidateRoleFamily("District Sales Manager"), "district_manager");
  assert.equal(candidateRoleFamily("Regional Manager"), "area_regional_manager");
  assert.equal(candidateRoleFamily("Area Manager"), "area_regional_manager");
  assert.equal(
    candidateRoleFamily("NSM"),
    "other",
    "a bare NSM is ambiguous and unused here — same reasoning as the excluded bare MR and KAM",
  );
  // "Regional Sales Manager" now resolves to area_regional_manager, not sales — see the dedicated
  // block below, where the area/regional branch's fix and its production measurement are documented.

  // --- Compound titles name two jobs. The more senior, more specific one wins.
  assert.equal(
    candidateRoleFamily("Medical Sales Professional | District Manager"),
    "district_manager",
    "a compound title is judged on District Manager, not on the medical-sales half",
  );
  assert.equal(
    candidateRoleFamily("SENIOR DISTRICT MANAGER | PHARMACEUTICAL SALES & LEADERSHIP"),
    "district_manager",
  );
  assert.equal(candidateRoleFamily("District Manager /Upper Egypt 2"), "district_manager");
  assert.equal(candidateRoleFamily("Acting District Manager"), "district_manager");

  // --- This pool's own data equates Territory Manager with Medical Rep: one person wrote both.
  assert.equal(candidateRoleFamily("Medical representative ( territory manager )"), "medical_rep");
  assert.equal(candidateRoleFamily("Territory Manager"), "medical_rep");
  assert.equal(candidateRoleFamily("Senior Product Specialist"), "medical_rep");
  assert.equal(candidateRoleFamily("Senior Med. Rep."), "medical_rep");

  // --- A bare honorific must never read as Medical Rep.
  assert.equal(
    candidateRoleFamily("Mr Ahmed Hassan"),
    "other",
    "a title carrying the honorific Mr is not a Medical Representative",
  );
  assert.equal(
    candidateRoleFamily("Benefits & Medical Insurance Specialist"),
    "other",
    "medical insurance is not medical sales",
  );

  assert.equal(candidateRoleFamily("Regional Manager \u2013 Upper Egypt"), "area_regional_manager");
  assert.equal(candidateRoleFamily("Area Supervisor"), "area_regional_manager");

  // --- "Sales" wedged between the region word and the seniority word must not push these into the
  // --- sales catch-all: "Regional/Area Sales Manager" is this pool's own name for the RSM/ASM
  // --- field-force role. Measured against production 2026-08-28: 12 of 345 titled candidates (9
  // --- distinct titles, all this shape) were falling through to "sales" before this fix.
  for (const title of [
    "Regional Sales Manager",
    "7-Regional Sales Manager",
    "Regional Sales Manager (Alex & Delta)",
    "Regional sales manager for great cairo",
    "Area Sales Manager",
    "area sales manager",
    "Area Sales Manager GCC Region",
  ]) {
    assert.equal(candidateRoleFamily(title), "area_regional_manager", `"${title}" is an Area / Regional Manager`);
  }
  // --- But not ANY word between the two \u2014 "Regional Collection Manager" carries both "regional"
  // --- and "manager" and is still not a field role, so it must stay unclaimed.
  assert.equal(
    candidateRoleFamily("Regional Collection Manager"),
    "other",
    "a Regional Collection Manager is not the Area / Regional field-force role",
  );

  assert.equal(candidateRoleFamily("Product Manager (Respiratory & Anti-Infective)"), "product_manager");
  assert.equal(candidateRoleFamily("Senior HR Generalist"), "human_resources");
  assert.equal(candidateRoleFamily("Sr. Payroll & Personnel Specialist"), "human_resources",
    "payroll and personnel are HR work here, not finance");
  assert.equal(candidateRoleFamily("Senior Tax & Accounts Payable"), "finance");
  assert.equal(candidateRoleFamily("\u0645\u062d\u0627\u0633\u0628 \u0639\u0627\u0645"), "finance", "Arabic accountant");
  assert.equal(candidateRoleFamily("Community Pharmacist"), "pharmacist");

  // --- No title is not the same claim as "none of these".
  assert.equal(candidateRoleFamilyOrNull(null), null, "a missing title is unjudged, not Other");
  assert.equal(candidateRoleFamilyOrNull("   "), null);
  assert.equal(candidateRoleFamilyOrNull("Receptionist & Call Center"), "other");
  assert.equal(normalizeJobTitle("  District   MANGER | x "), "district manager x");

  // --- Region: the owner's decision is the COMPANY grouping, not plain geography.
  for (const gov of ["Sohag", "Assiut", "Minya", "Qena", "assuit", "SOHAG"]) {
    assert.equal(candidateRegionForGovernorate(gov), "UE", `${gov} is Upper Egypt`);
  }
  assert.equal(
    candidateRegionForGovernorate("Beni Suef"),
    "GZ",
    "Beni Suef is the company's Giza region, not Upper Egypt \u2014 owner decision 2026-08-24",
  );
  assert.equal(candidateRegionForGovernorate("Fayoum"), "GZ", "Fayoum is Giza, matching the Organogram");
  assert.equal(candidateRegionForGovernorate("Aswan"), "OT", "Aswan is Others, not Upper Egypt");
  assert.equal(candidateRegionForGovernorate("Luxor"), "OT");

  // --- Both spellings in production must land on one region, or each hides the other's people.
  assert.equal(candidateRegionForGovernorate("Qalyubia"), "D1");
  assert.equal(
    candidateRegionForGovernorate("Al-Qalyubia"),
    candidateRegionForGovernorate("Qalyubia"),
    "Al-Qalyubia and Qalyubia are one place and must group together",
  );
  assert.equal(candidateRegionForGovernorate("\u0627\u0644\u0642\u0627\u0647\u0631\u0629"), "CA", "Arabic Cairo");
  assert.equal(candidateRegionForGovernorate("Cairo, Egypt"), "CA", "a trailing country name still resolves");

  // --- Unknown is NOT Others. "Others" is a real selling region with real areas in it.
  assert.equal(candidateRegionForGovernorate(null), null);
  assert.equal(candidateRegionForGovernorate(""), null);
  assert.equal(
    candidateRegionForGovernorate("Atlantis"),
    null,
    "an unrecognised place is unknown, never folded into the Others region",
  );
  assert.equal(normalizeGovernorate("  Al-Qalyubia Governorate "), "qalyubia");

  // --- Every family and region has a human-readable label, never a raw code on screen.
  for (const label of Object.values(candidateRoleFamilyLabels)) {
    assert.ok(label.length > 0 && !label.includes("_"), `role label "${label}" is human-readable`);
  }
  for (const label of Object.values(candidateRegionLabels)) {
    assert.ok(label.length > 0 && !label.includes("_"), `region label "${label}" is human-readable`);
  }

  // --- Sales & Business Development. Added 2026-08-24 at the owner's request. Eight people in
  // --- production, every one of them previously sitting in Other.
  for (const title of [
    "Sales Manager",
    "Sales Manager North",
    "Sales & Business Development Manager",
    "key account manager",
    "BDM & Marketing Advisor",
    "Dental sales representative",
  ]) {
    assert.equal(candidateRoleFamily(title), "sales", `"${title}" is Sales & Business Development`);
  }

  // --- THE TRAP. "Salesforce" is a CRM product, not a selling job, and one candidate here is a
  // --- Salesforce developer. A substring search for "sales" claims them; a word-boundary match
  // --- does not, because there is no boundary inside "salesforce".
  assert.equal(
    candidateRoleFamily("Salesforce Developer | Salesforce Technical Consultant"),
    "other",
    "a Salesforce developer is not in the Sales family",
  );

  // --- Sales runs LAST, so a title another family already owns keeps that family even though it
  // --- carries the word "sales". These four are what that placement is protecting.
  assert.equal(candidateRoleFamily("District Sales Manager"), "district_manager");
  assert.equal(candidateRoleFamily("Medical sales representative"), "medical_rep");
  assert.equal(candidateRoleFamily("Pharmacy Sales Representative"), "pharmacist");
  assert.equal(
    candidateRoleFamily("DISTRICT MANAGER | Pharmaceutical Sales"),
    "district_manager",
    "the word sales in a District Manager title does not move them to Sales",
  );

  // --- Sales Force Effectiveness genuinely contains the word but is its own discipline here.
  assert.equal(
    candidateRoleFamily("Sales Force Effectiveness (SFE) Analyst"),
    "other",
    "SFE is not a selling role",
  );
  assert.equal(
    candidateRoleFamily("Sales Force Effectiveness (SFE) & Business Development Manager | Acting HR Manager"),
    "human_resources",
    "the SFE title keeps the family it had before Sales existed",
  );
}
