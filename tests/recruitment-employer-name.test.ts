import assert from "node:assert/strict";

import { cleanEmployerName } from "../src/lib/recruitment/employer-name.ts";

/**
 * Every literal below is a REAL value read off production on 2026-08-25, not an invented example.
 * That matters in both directions: the rejects are what the card was actually showing a screener,
 * and the keeps are the real employers that a looser rule would have deleted.
 */
export function runRecruitmentEmployerNameTests() {
  // --- NOT A NAME AT ALL. These were on screen in the Employer slot of the "who is this person"
  // --- card, where the reader has to stop and work out that the system has nothing.
  for (const junk of ["(", "( )", "()", "[ ]", "01/", "07.", "2", " ", "-", "|", "..."]) {
    assert.equal(cleanEmployerName(junk), null, `"${junk}" is not an employer name`);
  }

  // --- ONE LETTER IS NOT A NAME EITHER, and this is the only case the letter count catches on its
  // --- own: everything above tidies away to nothing, or reads as a bare number.
  assert.equal(cleanEmployerName("A"), null, "a single letter cannot identify an employer");
  assert.equal(cleanEmployerName("2a"), null, "a letter with a digit stuck to it is not a company");

  // --- SENTENCE FRAGMENTS. The CV reader grabbed the middle of a line. A screener reading
  // --- "Employer: From" learns nothing and doubts the rest of the card.
  assert.equal(cleanEmployerName("From"), null);
  assert.equal(cleanEmployerName("From :"), null);
  assert.equal(cleanEmployerName("(From )"), null);
  assert.equal(cleanEmployerName("from 15-12"), null);
  assert.equal(cleanEmployerName("and missions."), null);
  assert.equal(cleanEmployerName("and inventory control"), null);
  assert.equal(cleanEmployerName("and Immunology portfolios nationwide."), null);
  assert.equal(cleanEmployerName("of Elola Steel Group (Steel Manufacturing)"), null);

  // --- DATES. "Jan 2026 _ till now" is when they worked somewhere, not where.
  assert.equal(cleanEmployerName("Jan 2026 _ till now"), null);
  assert.equal(cleanEmployerName("(jan. )"), null);
  assert.equal(cleanEmployerName("From Jul ."), null);
  assert.equal(cleanEmployerName("(1 year)"), null);
  assert.equal(cleanEmployerName("date"), null);

  // --- PLACES. Where they worked, not who for. This is the rule with the most room to do damage,
  // --- which is why it fires ONLY when every single word is a place — see the keeps below.
  assert.equal(cleanEmployerName("Egypt"), null);
  assert.equal(cleanEmployerName("Pakistan"), null);
  assert.equal(cleanEmployerName("UAE & Oman"), null);
  assert.equal(cleanEmployerName("Cairo, Egypt"), null);
  assert.equal(cleanEmployerName("Lahore Pakistan"), null);
  assert.equal(cleanEmployerName("South East Asia"), null);
  assert.equal(cleanEmployerName("Greater Cairo"), null);
  assert.equal(cleanEmployerName("sohag area"), null);
  assert.equal(cleanEmployerName("New Cairo)"), null);
  assert.equal(cleanEmployerName("KSA, Pakistan & Sri Lanka"), null);

  // --- VALUES THAT ANSWER NOTHING, matched whole and never as a substring.
  assert.equal(cleanEmployerName("training"), null);
  assert.equal(cleanEmployerName("insurance."), null);
  assert.equal(cleanEmployerName("Various clients"), null);
  assert.equal(cleanEmployerName("Key Responsibilities"), null);
  assert.equal(cleanEmployerName("Personnel & Operations:"), null);
  assert.equal(cleanEmployerName("N/A"), null);

  // --- CV BULLETS. Somebody's duties pasted into the employer slot — up to 285 characters of it.
  assert.equal(
    cleanEmployerName("Oversaw medication inventory management, including ordering, stocking, and secure storage.- Collaborated with the team"),
    null,
  );
  assert.equal(cleanEmployerName("Drove daily targets and performance metrics for sales agents and Key Accounts Managers."), null);
  assert.equal(cleanEmployerName("optimized manpower planning, and delivered continuous improvements in sales"), null);
  assert.equal(cleanEmployerName("expanding environmental and fire-fighting system services across GCC markets."), null);
  assert.equal(cleanEmployerName("focusing on strategic initiatives to"), null);
  assert.equal(cleanEmployerName("/ Assigned as Alexandria Scientific Office"), null);

  // --- THE HALF THAT MATTERS MORE. Every one of these is a REAL employer on a real candidate, and
  // --- every one of them looks odd enough that a looser rule would have taken it. Losing a true
  // --- employer is worse than showing a strange one: the cell exists to say who this person is.
  const realEmployers = [
    "S. A. Miro, Inc.",
    "Egyptian Russian University.",
    "Kk's Tavern, 25 Nkonjane Street kwanobuhle 6242",
    "Qfix info Infocomm Pvt. Ltd. (100% subsidiary of Pine Labs)",
    "Madawa Pharmaceutical Company | Twenty One Food Industries | Mira Technologies",
    "Mepaco-Medifood for Medicinal plants and Pharmaceutical products",
    "Safe Hearts co.",
    "Carea pharma.",
    "Best Agrolife Ltd.",
    "DMS",
    "ARK",
    "vmed",
    "FREELANCE",
    "CIB (Commercial International Bank - Egypt)",
    "شركة سوفيكو فارم للأدوية",
    "Ministry of Health and Population",
    "Al-Galaa Medical Complex, Armed Forces",
    "(PharmaOverSeas ) with Over Than 54 Branches",
  ];
  for (const name of realEmployers) {
    assert.ok(cleanEmployerName(name), `"${name}" is a real employer and must survive the guard`);
  }

  // --- A PLACE NAME INSIDE A COMPANY NAME IS NORMAL HERE. Five of the biggest employers in this
  // --- pool contain "Egypt". A substring test against the place list would have deleted all of
  // --- them, which is exactly why the rule requires EVERY word to be a place.
  for (const name of ["Fly Egypt", "Toyota Egypt", "Dabur Egypt Ltd", "Union pharma Egypt", "Egypt Sun Marine", "KSA, Al Safi Danone Farm"]) {
    assert.equal(cleanEmployerName(name), name, `"${name}" must be kept exactly as it is`);
  }

  // --- A SHORT NAME STARTING ON A DUTY VERB SURVIVES. The bullet rule needs four words, so a real
  // --- two-word company is never mistaken for the start of a sentence.
  assert.equal(cleanEmployerName("Managed Care"), "Managed Care");
  assert.equal(cleanEmployerName("Led Lighting Egypt"), "Led Lighting Egypt");

  // --- TIDYING, WHICH IS THE HALF THAT KEEPS FACTS RATHER THAN DROPPING THEM. Most of what looks
  // --- broken is a good name wearing noise from a CV template, and cleaning it loses only noise.
  assert.equal(cleanEmployerName("Maxim Foods ( )"), "Maxim Foods");
  assert.equal(cleanEmployerName("Al Andalous ( )"), "Al Andalous");
  assert.equal(cleanEmployerName("Pharco Pharmaceuticals ( )"), "Pharco Pharmaceuticals");
  assert.equal(cleanEmployerName("Orange Digital Center Egypt ( )"), "Orange Digital Center Egypt");
  assert.equal(cleanEmployerName("Kamal Shoaib Law Office ( ):"), "Kamal Shoaib Law Office");
  assert.equal(cleanEmployerName("Junior Kid swear Factory, | ( )"), "Junior Kid swear Factory");
  assert.equal(cleanEmployerName("Psychological Medicine Hospital Dr.Adel Sadek ( )."), "Psychological Medicine Hospital Dr.Adel Sadek");
  assert.equal(cleanEmployerName("NP Pharma from ."), "NP Pharma");
  assert.equal(cleanEmployerName("Ahmedabad)………......"), "Ahmedabad", "dot leaders and an orphan bracket go; the word behind them is left alone");

  // --- ...but a bracket that BALANCES belongs to the name. Stripping a trailing `)` on sight
  // --- would rewrite two of the largest employers in this pool.
  assert.equal(cleanEmployerName("CIB (Commercial International Bank - Egypt)"), "CIB (Commercial International Bank - Egypt)");
  assert.equal(cleanEmployerName("Green Modeling Contracting (GMC)"), "Green Modeling Contracting (GMC)");

  // --- ...and the SAME at the other end. Stripping a leading "(" without checking that it closes
  // --- left a stray ")" stranded in the middle of a real employer's name — measured on production,
  // --- not imagined, and the reason the rule counts brackets instead of matching characters.
  assert.equal(
    cleanEmployerName("(PharmaOverSeas ) with Over Than 54 Branches"),
    "(PharmaOverSeas ) with Over Than 54 Branches",
    "a balanced leading bracket belongs to the name",
  );
  assert.equal(cleanEmployerName("(Vitacure"), "Vitacure", "an UNbalanced leading bracket is wreckage and does go");

  // --- A TRAILING PERIOD THAT BELONGS TO THE NAME IS NOT NOISE. "Ltd." and "co." end in one, and
  // --- stripping it would quietly rewrite a company's name on screen.
  assert.equal(cleanEmployerName("Cosmo Pharma (Pvt.) Ltd."), "Cosmo Pharma (Pvt.) Ltd.");
  assert.equal(cleanEmployerName("Ajwan Global."), "Ajwan Global.");

  // --- Whitespace is normalised, never used as a reason to reject.
  assert.equal(cleanEmployerName("  Zeta   Pharma  "), "Zeta Pharma");
  assert.equal(cleanEmployerName(null), null);
  assert.equal(cleanEmployerName(undefined), null);
  assert.equal(cleanEmployerName(""), null);

  // --- PROSE BY LENGTH, and the boundary is where it is on purpose: the longest real name in the
  // --- production pool is 78 characters, so the cap sits above it rather than on top of it.
  assert.equal(cleanEmployerName("x".repeat(78)), "x".repeat(78), "a 78-character name is real — that length exists in the pool");
  assert.equal(cleanEmployerName("y".repeat(120)), null, "120 characters is a paragraph, not a company");
}
