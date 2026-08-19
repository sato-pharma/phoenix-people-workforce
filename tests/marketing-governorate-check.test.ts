import assert from "node:assert/strict";

import {
  buildGovernorateMismatchNote,
  checkCapturedGovernorate,
  resolveMarketingSystemValidationStatus,
} from "@/lib/marketing-requests/service";
import { MARKETING_GOVERNORATE_HOLD_PREFIX } from "@/lib/marketing-requests/types";

/**
 * Guards the comparison between WHERE THE REP STOOD (the reverse-geocoded GPS address) and WHERE
 * THE DISTRIBUTOR REGISTERS THE CODE (`marketing_pharmacy_code_references.raw_region`).
 *
 * Before this check existed nothing in Phoenix compared those two values — `raw_pharmacy_address`
 * and `raw_region` were written once by the reference importer and read by no code path at all.
 *
 * Every captured string below is a VERBATIM production `captured_address`, and every registered
 * region is that code's real `raw_region`, read from `ozucdzovmcqvepbozvqf` on 2026-08-20. Real
 * strings matter here more than usual, because the whole risk in this check is a false mismatch:
 * Google's reverse geocoder puts street names into the address that are themselves the names of
 * OTHER governorates, and three of the fixtures below are exactly that trap.
 */

/** Captured address, registered region, and the verdict the pair must produce. */
const PRODUCTION_PAIRS: Array<{
  captured: string;
  label: string;
  region: string;
  verdict: "agrees" | "disagrees";
}> = [
  // ── The one real failure in production ─────────────────────────────────────────────────────
  {
    captured: "4 El-Nour, Sheraton Al Matar, El Nozha, Cairo Governorate 4471133, Egypt",
    label: "MKT-PHA-20260619-6F50E43C — captured in Cairo, code registered in Alexandria",
    region: "الإسكندرية",
    verdict: "disagrees",
  },

  // ── The traps: the captured address contains ANOTHER governorate's name ─────────────────────
  {
    // "Alexandria" here is a STREET in Heliopolis, Cairo — not the governorate.
    captured: "38WH+WX6, Alexandria, El-Bostan, Heliopolis, Cairo Governorate 4460321, Egypt",
    label: "a street called Alexandria inside Cairo must not read as Alexandria",
    region: "القاهرة",
    verdict: "agrees",
  },
  {
    // "بورسعيد" (Port Said) is the street; the governorate is Menoufia.
    captured: "HWX6+72M، بورسعيد، El-Shohada City, El Shohada, Menofia Governorate 6113411, Egypt",
    label: "a street called Port Said inside Menoufia must not read as Port Said",
    region: "المنوفية",
    verdict: "agrees",
  },
  {
    // "El-Sadat" is a district of Assiut here, but Sadat City is in Menoufia.
    captured: "55GV+HMJ, El-Sadat, El-Masara, Asyut 2, Assiut Governorate 2090020, Egypt",
    label: "El-Sadat inside Assiut must not read as Menoufia's Sadat City",
    region: "أسيوط",
    verdict: "agrees",
  },

  // ── The ordinary agreeing captures, across every shape the geocoder returns ─────────────────
  {
    captured: "PQFW+W9M, Fakous, Faqous, Al-Sharqia Governorate 7322342, Egypt",
    label: "Plus Code with no street, Sharqia",
    region: "الشرقية",
    verdict: "agrees",
  },
  {
    captured: "5 Ahmed Maher, Qism Shebeen El-Kom, Shibin el Kom, Menofia Governorate 6131333, Egypt",
    label: "full English street address, Menoufia",
    region: "المنوفية",
    verdict: "agrees",
  },
  {
    captured:
      "49 Masr Helwan Al Zeraei, Maadi Al Khabiri Ash Sharqeyah, Maadi, Cairo Governorate 4211121, Egypt",
    label: "Maadi, Cairo",
    region: "القاهرة",
    verdict: "agrees",
  },
  {
    captured: "Al-Marioteya Faisal St, Atati, El Talbia, Giza Governorate 3526001, Egypt",
    label: "Faisal Street, Giza",
    region: "الجيزة",
    verdict: "agrees",
  },
  {
    captured:
      "فيكتوريا 18 فيليب جلاد متفرع من، Al Galaa, Al Qasaei Qebli, El Raml 2, Alexandria Governorate 5447447, Egypt",
    label: "mixed Arabic and English, Alexandria",
    region: "الإسكندرية",
    verdict: "agrees",
  },
  {
    captured: "Madinet Qotour, Kotoor, Gharbia Governorate 6724732, Egypt",
    label: "Qotour, Gharbia",
    region: "الغربية",
    verdict: "agrees",
  },
  {
    captured: "R7WG+M4X, Madinet Al Badrashin, Badrshein, Giza Governorate 3365572, Egypt",
    label: "Badrashin, Giza",
    region: "الجيزة",
    verdict: "agrees",
  },
  {
    // "Souhag Rd" is spelled differently from the governorate token that actually resolves it.
    captured: "HM3V+7VC, Al Moinshaa - Souhag Rd, El-Khouly, Sohag 1, Sohag Governorate 1674211, Egypt",
    label: "the انجي جاد pharmacy carrying shared code 421516, Sohag",
    region: "سوهاج",
    verdict: "agrees",
  },
  {
    captured: "8P76+2FG, Madinet Samalout, East Samalout, Minya Governorate 2481538, Egypt",
    label: "Samalout, Minya",
    region: "المنيا",
    verdict: "agrees",
  },
  {
    captured: "شارع 23 يوليو، Ash Sheyakhah as Sabeah, Asyut 1, Assiut Governorate, Egypt",
    label: "Arabic street with no postcode, Assiut",
    region: "أسيوط",
    verdict: "agrees",
  },
  {
    captured: "2R63+MG, Al Amrereyah Gharb, Amreya 1, Alexandria Governorate, Egypt",
    label: "Amreya, Alexandria",
    region: "الإسكندرية",
    verdict: "agrees",
  },
];

export function runMarketingGovernorateCheckTests() {
  // ── Every real production pair lands on the verdict it must ────────────────────────────────
  for (const pair of PRODUCTION_PAIRS) {
    const check = checkCapturedGovernorate({
      capturedAddress: pair.captured,
      registeredRegion: pair.region,
    });
    assert.equal(
      check.verdict,
      pair.verdict,
      `${pair.label}: expected ${pair.verdict}, got ${check.verdict} ` +
        `(captured "${check.capturedGovernorate}" vs registered "${check.registeredGovernorate}")`,
    );
  }

  // The headline assertion: the Cairo-vs-Alexandria capture is caught, and named in the note.
  const cairoAgainstAlexandria = checkCapturedGovernorate({
    capturedAddress: "4 El-Nour, Sheraton Al Matar, El Nozha, Cairo Governorate 4471133, Egypt",
    registeredAddress: "بلوك 2 مساكن كوم الشقافة – مين",
    registeredRegion: "الإسكندرية",
  });
  assert.equal(cairoAgainstAlexandria.verdict, "disagrees");
  assert.equal(cairoAgainstAlexandria.capturedGovernorate, "Cairo");
  assert.equal(cairoAgainstAlexandria.registeredGovernorate, "Alexandria");

  const mismatchNote = buildGovernorateMismatchNote(cairoAgainstAlexandria);
  assert.ok(mismatchNote, "a disagreeing check must produce a note");
  assert.match(mismatchNote, /Cairo/);
  assert.match(mismatchNote, /Alexandria/);
  // The registered street is quoted so the reviewer can see what the code is supposed to be.
  assert.match(mismatchNote, /كوم الشقافة/);

  // ── A mismatch must never be invented from the free-text street address ─────────────────────
  // Production files code 330340 under القاهرة with the address "16ناصيه هارون والمنصوره". That
  // text contains المنصورة (Dakahlia). If the address were ever consulted as a fallback this would
  // read as a Cairo-vs-Dakahlia mismatch on a capture that is perfectly correct.
  const arabicStreetNamingAnotherCity = checkCapturedGovernorate({
    capturedAddress: "38WH+WX6, Alexandria, El-Bostan, Heliopolis, Cairo Governorate 4460321, Egypt",
    registeredAddress: "16ناصيه هارون والمنصوره",
    registeredRegion: "القاهرة",
  });
  assert.equal(
    arabicStreetNamingAnotherCity.verdict,
    "agrees",
    "the registered street address must not be used to resolve the governorate",
  );
  assert.equal(buildGovernorateMismatchNote(arabicStreetNamingAnotherCity), null);

  // ── Missing data is never evidence of a wrong capture ───────────────────────────────────────
  // Five production codes match the reference database but carry a blank address/region.
  for (const blank of [null, undefined, "", "   "]) {
    const check = checkCapturedGovernorate({
      capturedAddress: "R7WG+M4X, Madinet Al Badrashin, Badrshein, Giza Governorate 3365572, Egypt",
      registeredRegion: blank,
    });
    assert.equal(check.verdict, "not_comparable", `blank registered region (${JSON.stringify(blank)})`);
    assert.equal(check.registeredGovernorate, null);
    assert.equal(buildGovernorateMismatchNote(check), null, "a blank reference must never be flagged");
  }

  // A capture the geocoder could not resolve to any governorate is equally not comparable.
  for (const unresolvable of [null, "", "8P76+894", "Unnamed Road"]) {
    const check = checkCapturedGovernorate({
      capturedAddress: unresolvable,
      registeredRegion: "الجيزة",
    });
    assert.equal(
      check.verdict,
      "not_comparable",
      `unresolvable captured address (${JSON.stringify(unresolvable)})`,
    );
    assert.equal(buildGovernorateMismatchNote(check), null);
  }

  assert.deepEqual(Object.keys(cairoAgainstAlexandria).sort(), [
    "capturedGovernorate",
    "registeredAddress",
    "registeredGovernorate",
    "verdict",
  ]);

  // ── A CONTRADICTION BLOCKS ──────────────────────────────────────────────────────────────────
  // Owner instruction, 2026-08-20. Complete evidence is no longer enough on its own: a capture in
  // Cairo against a code registered in Alexandria is held on `pending` for a human to release,
  // which is what production row MKT-PHA-20260619-6F50E43C should have got and did not.
  assert.equal(
    resolveMarketingSystemValidationStatus({
      customerEvidenceStatus: "complete",
      governorateVerdict: "disagrees",
      pharmacyEvidenceStatus: "complete",
    }),
    "pending",
    "a governorate contradiction must hold the link even when both captures are complete",
  );

  // ── ONLY a contradiction blocks — a gap in our own reference data never does ─────────────────
  // The asymmetry is the whole safety property. `not_comparable` is what a blank, missing or
  // unrecognisable reference region produces, and Phoenix owns that import: if it blocked, every
  // hole in our own data would park an honest rep on a status only a Super Admin / CEO can clear.
  for (const verdict of ["agrees", "not_comparable", undefined] as const) {
    assert.equal(
      resolveMarketingSystemValidationStatus({
        customerEvidenceStatus: "complete",
        governorateVerdict: verdict,
        pharmacyEvidenceStatus: "complete",
      }),
      "system_validated",
      `verdict ${JSON.stringify(verdict)} must not block a fully evidenced capture`,
    );
  }

  // The evidence rule is untouched underneath: agreeing geography cannot rescue a missing photo.
  assert.equal(
    resolveMarketingSystemValidationStatus({
      customerEvidenceStatus: "complete",
      governorateVerdict: "agrees",
      pharmacyEvidenceStatus: "missing",
    }),
    "pending",
  );

  // ── A held row must SAY why, or nobody can release it ────────────────────────────────────────
  // Only a Super Admin / CEO can clear a pending link (`canAccessCustomerPharmacyMapping`), and
  // they were not on the visit. The marker is a shared constant so the workspace can recognise the
  // hold without pattern-matching prose that someone later rewords.
  assert.ok(
    mismatchNote.startsWith(MARKETING_GOVERNORATE_HOLD_PREFIX),
    "a blocking note must carry the marker the workspace recognises the hold by",
  );
}
