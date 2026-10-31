import assert from "node:assert/strict";

import {
  candidateRegionForGovernorate,
  candidateRegionLabels,
  foreignCountryForGovernorate,
  foreignRegionLabel,
  normalizeGovernorate,
  recruitmentAreaRegionOverrides,
  recruitmentRegionForArea,
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
  // "Area Manager" moved here 2026-08-28 — see the dedicated block below, where the owner's
  // correction and its production measurement are documented.
  assert.equal(candidateRoleFamily("Area Manager"), "district_manager");
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
  assert.equal(candidateRoleFamily("Assistant General Manager Of Operations(Zonal Head)"), "area_regional_manager");

  // --- "Sales" wedged between the region word and the seniority word must not push these into the
  // --- sales catch-all: "Regional Sales Manager" is this pool's own name for the RSM field-force
  // --- role. Measured against production 2026-08-28: these 5, plus the two asserted just above,
  // --- are the complete set of 7 "Regional/Zonal" titles this pool holds.
  for (const title of [
    "Regional Sales Manager",
    "7-Regional Sales Manager",
    "Regional Sales Manager (Alex & Delta)",
    "Regional Sales Manager | Healthcare & Pharmaceuticals",
    "Regional sales manager for great cairo",
  ]) {
    assert.equal(candidateRoleFamily(title), "area_regional_manager", `"${title}" is a Regional Manager`);
  }
  // --- But not ANY word between the two \u2014 "Regional Collection Manager" carries both "regional"
  // --- and "manager" and is still not a field role, so it must stay unclaimed.
  assert.equal(
    candidateRoleFamily("Regional Collection Manager"),
    "other",
    "a Regional Collection Manager is not the Area / Regional field-force role",
  );

  // --- "Area (Sales) Manager/Supervisor" reads like a synonym for the block above, but the owner
  // --- corrected this 2026-08-28: in this industry it names the SAME first-line seat Phoenix calls
  // --- District Manager, not the tier above. Measured against production: these 6, plus "Area
  // --- Manager" asserted above, are the complete set of 7 "Area"-titled candidates that were
  // --- sitting in area_regional_manager (an 8th, "Pharmaceutical Area / District Sales Manager",
  // --- already resolved to district_manager via the plain \bdistrict\b rule and never moved).
  for (const title of [
    "Area Sales Manager",
    "area sales manager",
    "Area sales manager",
    "Area Sales Manager GCC Region",
    "Area Supervisor",
    "AREA MANGER", // the same misspelling normalizeJobTitle repairs for "district manger"
  ]) {
    assert.equal(candidateRoleFamily(title), "district_manager", `"${title}" is a District Manager, not Area / Regional`);
  }

  assert.equal(candidateRoleFamily("Product Manager (Respiratory & Anti-Infective)"), "product_manager");
  assert.equal(candidateRoleFamily("Senior HR Generalist"), "human_resources");
  // Personnel splits out of Human Resources (2026-10-31, the Personnel Specialist opening): a title
  // naming payroll or personnel work is that seat's job, even when it also says HR — and still never
  // Finance. A title naming the recruiting work keeps Talent Acquisition, which is tested first.
  assert.equal(candidateRoleFamily("Sr. Payroll & Personnel Specialist"), "personnel",
    "payroll and personnel are the Personnel seat's work, not finance");
  assert.equal(candidateRoleFamily("Sr. Payroll & Personnel Specialist | HR Operations | Comp & Ben"), "personnel",
    "the personnel word wins over a bare HR mention — it is the applied-for job");
  assert.equal(candidateRoleFamily("HR & Payroll Officer"), "personnel");
  assert.equal(candidateRoleFamily("Payroll Accountant"), "personnel", "payroll is HR work here, tested before finance");
  assert.equal(candidateRoleFamily("Personnel & Recruitment Specialist"), "talent_acquisition",
    "the recruiting word is tested first, so this title keeps the family it had");
  // Talent Acquisition splits out of Human Resources (2026-09-22): a title naming the recruiting
  // work lands in its own family, while bare-HR stays Human Resources.
  assert.equal(candidateRoleFamily("Talent Acquisition Specialist"), "talent_acquisition");
  assert.equal(candidateRoleFamily("Senior Recruiter"), "talent_acquisition");
  assert.equal(candidateRoleFamily("Recruitment Coordinator"), "talent_acquisition");
  assert.equal(candidateRoleFamily("Talent Acquisition & HR Manager"), "talent_acquisition",
    "the recruiting word wins over a bare HR mention — it is the applied-for job");
  // HR Section Head splits out of Human Resources (2026-10-06): only the exact seat moves, and it
  // beats the recruiting and bare-HR words in the same title.
  assert.equal(candidateRoleFamily("HR Section Head"), "hr_section_head");
  assert.equal(candidateRoleFamily("Human Resources Section Head"), "hr_section_head");
  assert.equal(candidateRoleFamily("HR Section Manager"), "hr_section_head");
  assert.equal(candidateRoleFamily("Section Head - HR & Recruitment"), "hr_section_head",
    "the section-head seat wins over the recruiting word — it is the applied-for job");
  assert.equal(candidateRoleFamily("Section Head of Human Resources"), "hr_section_head");
  assert.equal(candidateRoleFamily("HR Manager"), "human_resources", "an HR Manager is not the section-head seat");
  assert.equal(candidateRoleFamily("Head of HR"), "human_resources", "Head of HR keeps the family it had");
  assert.equal(candidateRoleFamily("Personnel Section Head"), "personnel", "a personnel section head is the Personnel family's senior end");
  assert.equal(candidateRoleFamily("Sales Section Head"), "sales", "a section head outside HR is untouched");
  assert.equal(candidateRoleFamily("Senior Tax & Accounts Payable"), "finance");
  assert.equal(candidateRoleFamily("\u0645\u062d\u0627\u0633\u0628 \u0639\u0627\u0645"), "finance", "Arabic accountant");
  assert.equal(candidateRoleFamily("Community Pharmacist"), "pharmacist");

  // --- No title is not the same claim as "none of these".
  assert.equal(candidateRoleFamilyOrNull(null), null, "a missing title is unjudged, not Other");
  assert.equal(candidateRoleFamilyOrNull("   "), null);
  // "Call Center Agent" is the example here because it genuinely matches no family. It used to be
  // "Receptionist & Call Center" — that title moved to office_coordinator on 2026-09-02 and now
  // proves the opposite point, so it is pinned separately below rather than deleted.
  assert.equal(candidateRoleFamilyOrNull("Call Center Agent"), "other");

  // --- The office seat, added 2026-09-02 for the Sheraton Office Coordinator opening.
  // A receptionist and a secretary are the same front-office job under this industry's older
  // names, so an applicant writing either is applying for this one and belongs on its shelf.
  for (const title of [
    "Office Coordinator",
    "Front Office Coordinator",
    "Administrative Assistant",
    "Executive Secretary",
    "Receptionist & Call Center",
  ]) {
    assert.equal(candidateRoleFamily(title), "office_coordinator", `"${title}" is the office seat`);
  }
  // The two titles this family must NOT claim. A bare admin word sweeps in warehouse and IT seats,
  // which is why every pattern anchors on a second word naming the SEAT; and "HR & Admin Officer"
  // is an HR job that the human_resources rule takes FIRST, which is what makes adding this family
  // move nobody out of the family they already had.
  assert.equal(candidateRoleFamily("IT System Administrator"), "other", "a system admin is not an office coordinator");
  assert.equal(candidateRoleFamily("HR & Admin Officer"), "human_resources", "HR wins the tie, and must keep winning it");
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

  // --- Delta (3): the Anti Infective district opened 2026-08-28 — Qalubeya, Sharkia, Suez, Ismailia.
  // Before this the four sat in three different regions and there was no way to search the pool for
  // the new district at all. These four assertions ARE the feature; they are not incidental.
  for (const gov of ["Qalyubia", "Al-Qalyubia", "Qalubeya", "Banha"]) {
    assert.equal(candidateRegionForGovernorate(gov), "D3", `${gov} is Delta (3), moved out of Delta (1)`);
  }
  for (const gov of ["Sharkia", "Sharqia", "El-Sharqia", "Zagazig"]) {
    assert.equal(candidateRegionForGovernorate(gov), "D3", `${gov} is Delta (3), moved out of Delta (2)`);
  }
  assert.equal(candidateRegionForGovernorate("Suez"), "D3", "Suez is Delta (3), moved out of Others");
  for (const gov of ["Ismailia", "Ismailiya"]) {
    assert.equal(candidateRegionForGovernorate(gov), "D3", `${gov} is Delta (3), moved out of Others`);
  }
  assert.equal(candidateRegionLabels.D3, "Delta (3)", "the label is the company's own region name");

  // The regions Delta (3) was carved OUT of must keep everything else — a carve-out that empties a
  // neighbour is a mistake, not a move.
  assert.equal(candidateRegionForGovernorate("Gharbia"), "D1", "Delta (1) keeps Gharbia");
  assert.equal(candidateRegionForGovernorate("Menoufia"), "D1", "Delta (1) keeps Menoufia");
  assert.equal(candidateRegionForGovernorate("Kafr El Sheikh"), "D1", "Delta (1) keeps Kafr El-Sheikh");
  assert.equal(candidateRegionForGovernorate("Dakahlia"), "D2", "Delta (2) keeps Dakahlia");
  assert.equal(candidateRegionForGovernorate("Port Said"), "D2", "Delta (2) keeps Port Said");
  assert.equal(candidateRegionForGovernorate("Damietta"), "D2", "Delta (2) keeps Damietta");
  assert.equal(candidateRegionForGovernorate("Hurghada"), "OT", "Others keeps Hurghada");
  assert.equal(candidateRegionForGovernorate("North Sinai"), "OT", "Others keeps North Sinai");

  // --- The seven the map could not place, taken verbatim from production 2026-08-29. Five are
  // --- real Egyptian governorates the CV reader spelled a way the map did not list, so the person
  // --- was missing from their own region's filter entirely. These are the exact strings, not
  // --- tidied ones: the point is that THESE arrive.
  assert.equal(candidateRegionForGovernorate("Sharqiya"), "D3", "Sharqiya is the Sharkia spelling with a y");
  assert.equal(candidateRegionForGovernorate("Al Sharqiyah"), "D3", "and the same again with a trailing h");
  assert.equal(
    candidateRegionForGovernorate("Elsharkia"),
    "D3",
    "the article written onto the name, which normalizeGovernorate cannot strip without a space",
  );
  assert.equal(candidateRegionForGovernorate("Dakahliya"), "D2", "Dakahliya is Dakahlia");
  assert.equal(candidateRegionForGovernorate("El Menia"), "UE", "El Menia is Minya, so Upper Egypt");

  // The article-stripping is the reason "Elsharkia" needed its own key. Spelled with a space it
  // never reaches the map at all, so a key written "el sharkia" would be dead on arrival — which is
  // what several already in the map are. Pin the mechanism so the next person spells theirs closed
  // up rather than adding another key that can never match.
  assert.equal(normalizeGovernorate("El Sharkia"), "sharkia", "a spaced article is stripped before lookup");
  assert.equal(normalizeGovernorate("Elsharkia"), "elsharkia", "an attached one survives and must be a key");

  // --- The other two are not in Egypt. They must NOT acquire a region: Others is a real selling
  // --- region with real areas, and filing Dubai there would claim somebody covers a territory
  // --- nobody confirmed. What they get instead is a country, so a screen can say which of the two
  // --- reasons for a blank region it is looking at.
  assert.equal(candidateRegionForGovernorate("Dubai"), null, "Dubai is not one of the company's regions");
  assert.equal(candidateRegionForGovernorate("Gauteng"), null, "nor is Gauteng");
  assert.equal(foreignCountryForGovernorate("Dubai"), "United Arab Emirates");
  assert.equal(foreignCountryForGovernorate("Gauteng"), "South Africa", "Gauteng is South Africa, not a governorate");
  assert.equal(foreignCountryForGovernorate("Riyadh, Saudi Arabia"), "Saudi Arabia", "a city with its country appended");
  assert.equal(foreignRegionLabel, "Outside Egypt", "what every screen calls a foreign address");

  // The two questions must not answer each other. An Egyptian governorate is never foreign, and a
  // blank is neither — if this ever flips, a real Egyptian candidate is quietly filed as abroad.
  for (const gov of ["Cairo", "Giza", "Sohag", "Suez", "Ismailia", "Port Said", "Aswan", "Beni Suef"]) {
    assert.equal(foreignCountryForGovernorate(gov), null, `${gov} is in Egypt`);
  }
  assert.equal(foreignCountryForGovernorate(""), null, "a blank address is unknown, not abroad");
  assert.equal(foreignCountryForGovernorate(null), null);

  // --- Delta (3), the AREA side. The region map above moves the GOVERNORATES; this moves the five
  // AREA rows the WhatsApp apply flow shows, which are read from the SALES geography and still sit
  // under the old districts until the August closing publishes. Without this override, picking
  // "Delta (3)" shows an EMPTY area list while Sharkia still appears under Delta (2) — the two
  // questions in one conversation contradicting each other. Keyed by the EXACT au.canonical_areas
  // name; a rename there silently drops the override, so the five names are pinned here.
  assert.deepEqual(
    Object.keys(recruitmentAreaRegionOverrides).sort(),
    ["Ismailia", "Qalubeya", "Sharkia 1", "Sharkia 2", "Suez"],
    "exactly the five Delta (3) areas are overridden — no more, no fewer",
  );
  for (const [areaName, region] of Object.entries(recruitmentAreaRegionOverrides)) {
    assert.equal(region, "D3", `${areaName} is overridden to Delta (3), matching the region map`);
  }
  // The override wins over whatever district the sales map hands in for those five areas...
  assert.equal(recruitmentRegionForArea("Qalubeya", "D1"), "D3", "Qalubeya moves off Delta (1)");
  assert.equal(recruitmentRegionForArea("Sharkia 1", "D2"), "D3", "Sharkia 1 moves off Delta (2)");
  assert.equal(recruitmentRegionForArea("Sharkia 2", "D2"), "D3", "Sharkia 2 moves off Delta (2)");
  assert.equal(recruitmentRegionForArea("Suez", "OT"), "D3", "Suez moves off Others");
  assert.equal(recruitmentRegionForArea("Ismailia", "OT"), "D3", "Ismailia moves off Others");
  // ...and once the sales side finally repoints them to D3, the override is a harmless no-op.
  assert.equal(recruitmentRegionForArea("Qalubeya", "D3"), "D3", "already-D3 sales grouping is unchanged");
  // Every other area passes straight through — the override touches only the five.
  assert.equal(recruitmentRegionForArea("Gharbia 1 (Tanta)", "D1"), "D1", "an untouched area keeps its sales region");
  assert.equal(recruitmentRegionForArea("Dakahlia 1", "D2"), "D2", "an untouched area keeps its sales region");
  assert.equal(recruitmentRegionForArea("Aswan", "OT"), "OT", "an untouched area keeps its sales region");
  // The AREA override and the GOVERNORATE map must agree on Delta (3), or the apply flow's two
  // questions would file the same person two ways.
  for (const gov of ["Qalubeya", "Sharkia", "Suez", "Ismailia"]) {
    assert.equal(
      candidateRegionForGovernorate(gov),
      "D3",
      `the governorate map agrees the area override's ${gov} is Delta (3)`,
    );
  }

  // --- Both spellings in production must land on one region, or each hides the other's people.
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
