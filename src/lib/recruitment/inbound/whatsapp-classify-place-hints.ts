// Recruitment / ATS — the bracketed place names under a region or area row in the WhatsApp menus.
//
// WHY THIS EXISTS. Owner's instruction 2026-08-28: "when you show the question, the Delta two or
// Delta one or Delta three, mention in brackets ... so the one who is applying, he knows, and don't
// choose something wrong. But of course you will not mention all the bricks because all the bricks
// are so many. You will mention the most three big bricks."
//
// The problem is real and it is not cosmetic. "Delta (1)" and "Delta (2)" are INTERNAL sales names.
// Nobody outside this company knows which governorates either one covers, and an applicant who
// guesses wrong is filed against a district that will never call them. Same for an area: "Behira 1"
// and "Behira 2" are indistinguishable to the person they are about. A second line naming the
// biggest places inside removes the guess.
//
// ── HOW "BIGGEST" WAS DECIDED ───────────────────────────────────────────────────────────────────
// Measured, not guessed, against production on 2026-08-28. Source of Sales carries a brick on
// 316,406 of its 317,801 rows (99.6%, 615 distinct bricks), so value per brick is a real number.
// Everything is attributed to TODAY's geography — the brick's current area, never the area code
// frozen on the import row — because that is the standing rule for all SoS reporting.
//
//   AREA hints  — the 3 highest-value BRICKS in that area, exactly as the owner asked, written
//                 in ENGLISH. The bricks are named in Arabic in the sales database, so these
//                 are transliterations of those names, not a second set of places: nothing
//                 reads a hint back, so the database keeps its own spelling. He accepted
//                 Arabic here in 2026-08-28 ("even if in Arabic") and then ruled on
//                 2026-10-04 that EVERY word a WhatsApp applicant reads is English — which
//                 is the later instruction and the one this file follows.
//
//   REGION hints — the 3 highest-value AREAS, written as the GOVERNORATE a person would say.
//                 NOT the top 3 bricks, and the difference matters: ranked purely by brick, AB's
//                 top three come out as Damanhour, Marsa Matrouh and Kafr El-Dawwar, with
//                 ALEXANDRIA ABSENT — the city is split across many small bricks (Smouha,
//                 Sporting, Khorshid, Fleming...) so each one loses to a single undivided brick
//                 elsewhere. A hint that omits Alexandria from the Alex region is worse than no
//                 hint at all: it would actively push an Alexandrian to choose something else,
//                 which is the exact failure the owner asked to prevent.
//
// ── WHICH MAP A REGION HINT FOLLOWS ─────────────────────────────────────────────────────────────
// Two maps of Egypt exist in this app and, as of 2026-08-28, they DISAGREE on purpose. The
// RECRUITMENT map is `governorateRegions` in candidate-region.ts; the SALES map is
// `au_v_canonical_areas`. #2509 moved Qalyubia, Sharqia, Suez and Ismailia onto Delta (3) in the
// recruitment map and deliberately left the sales map alone until the August closing is published.
//
// These hints follow the RECRUITMENT map, because that is the vocabulary the Region filter on the
// CV database and the recruitment pool actually search on — it decides whether a candidate is ever
// found. So Delta (1) no longer says Qalyubia, Delta (2) no longer says Sharqia, and Others no
// longer says Ismailia or Suez. The area LISTS behind those rows used to disagree — the sales map
// still files those five areas under the old districts until the August closing publishes — but the
// apply flow now overrides that grouping for recruitment (recruitmentAreaRegionOverrides in
// candidate-region.ts), so an applicant who picks Delta (3) sees the five areas and Delta (1)/(2)/
// Others no longer offer them. The two maps still differ in the DATABASE; the recruitment flow no
// longer exposes the difference. See docs/recruitment-inbound-intake.md.
//
// ONE KNOWN DISAGREEMENT IS LEFT STANDING: Matrouh. The recruitment map files it under Others, but
// its sales bricks (Marsa Matrouh) sit inside AREA "Alex West", so Alex-BHR is the only row whose
// area list can reach the job. AB therefore keeps Matrouh. Matrouh is not in the top three of Others by
// any measure, so nothing is lost there either way.
//
// The regenerating queries are in docs/recruitment-inbound-intake.md so this can be refreshed
// without rediscovering the joins. These are LABELS, not analysis — nothing reads them back, and
// no number is shown to anyone.
//
// This module is PURE data. A missing hint is not an error anywhere: the row simply renders without
// its second line.

import type { CandidateRegionCode } from "@/lib/recruitment/candidate-region";

/**
 * The governorates each region actually covers, biggest first.
 *
 * Three is a CAP, not a quota — the owner set it so the line does not become a list of every brick.
 * Where a region has fewer than three governorates, or has exactly four and they fit, the whole
 * truth is printed: naming three of four would push the fourth governorate's applicants onto the
 * wrong row, which is the failure this file exists to prevent. `D3` is the four-of-four case.
 */
export const regionPlaceHints: Partial<Record<CandidateRegionCode, string>> = {
  AB: "Alexandria · Beheira · Matrouh",
  CA: "East Cairo · Nasr City · Heliopolis",
  D1: "Gharbia · Menoufia · Kafr El-Sheikh",
  D2: "Dakahlia · Damietta · Port Said",
  // Delta (3), opened 2026-08-28 — all four governorates, because four is everything it has and
  // they fit in one line. This is the row the owner is recruiting into, and the one he singled out.
  D3: "Qalyubia · Sharqia · Ismailia · Suez",
  GZ: "Giza · Fayoum · Beni Suef",
  OT: "Luxor · Aswan · Red Sea",
  UE: "Assiut · Sohag · Qena",
};

/**
 * The three highest-value bricks in each area, biggest first.
 *
 * KEYED BY AREA NAME, not area code, because that is what `areaMenu` is handed — the session loads
 * area NAMES live from `au_v_canonical_areas`. A renamed area therefore loses its hint rather than
 * showing the wrong one, and the registered test fails on the mismatch so it is noticed. All 49
 * active areas are present as of 2026-08-28.
 *
 * Region groupings in the comments below are the SALES map. It drives the area list an applicant is
 * shown EXCEPT for five areas — Qalubeya, Sharkia 1/2, Suez, Ismailia — which the apply flow now
 * files under Delta (3) (recruitmentAreaRegionOverrides in candidate-region.ts), matching the
 * recruitment region map. The comments below still note their SALES district, marked "→ Delta (3)".
 */
export const areaPlaceHints: Record<string, string> = {
  // ── AB · Alex-BHR ──────────────────────────────────────────────────────────────────────────
  "Alex Center": "Smouha · Sporting · El Hadra",
  "Alex East": "Khorshid · Sidi Bishr · Fleming",
  "Alex West": "Marsa Matrouh · El Amreya · El Agamy",
  "Behira 1": "Damanhour Shubrakhit · Kom Hamada · Itay El Baroud",
  "Behira 2": "Kafr El-Dawwar · Abu Homs · El Mahmoudia",

  // ── CA · Cairo ─────────────────────────────────────────────────────────────────────────────
  "Cairo East 1": "Ramses St · Ain Shams East · El Matareya",
  "Cairo East 2": "Salam City · El Marg · Obour City",
  "Cairo West": "Shubra El Kheima · Bahteem · Rod El Farag",
  "Down town": "El Azbakeya · Sayeda Zeinab · Qasr El Eini St",
  Heliopolis: "Heliopolis Square · Roxy · New Nozha",
  "Nasr City": "Nasr City · Seventh District · El Mokattam",

  // ── D1 · Delta (1) ─────────────────────────────────────────────────────────────────────────
  "Gharbia 1 (Tanta)": "Tanta · Kafr El-Zayat · El Santa",
  "Gharbia 2 (Mahalla)": "Zefta · El Mahalla El Kubra · Samannoud",
  "Kafr El-Sheikh 1": "Kafr El-Sheikh · Desouk · Baltim",
  "Kafr El-Sheikh 2": "Fuwwah · Sidi Salem · El Hamoul",
  "Menoufia 1": "Shebin El Kom · Quweisna · Berket El Sabaa",
  "Menoufia 2": "Ashmoun · Menouf · Bagour",
  // Sales map: Delta (1). → Delta (3): the apply flow files it under Delta (3), matching the region map.
  Qalubeya: "Benha · Shebin El Qanater · Qalyub",

  // ── D2 · Delta (2) ─────────────────────────────────────────────────────────────────────────
  "Dakahlia 1": "Mansoura · Talkha · El Maasara Sherbin",
  "Dakahlia 2": "Mit Ghamr · El Senbellawein · Aga",
  "Dakahlia 3": "Dekernes · El Manzala · Minyat El Nasr",
  "Port said - Domiat": "Damietta · Port Said · Kafr Saad",
  // Sales map: Delta (2). → Delta (3): the apply flow files both under Delta (3), matching the region map.
  "Sharkia 1": "Zagazig · Abu Hammad · Minya El Qamh",
  "Sharkia 2": "Faqous · El Husseiniya · Abu Kebir",

  // ── GZ · Giza ──────────────────────────────────────────────────────────────────────────────
  // Beni Suef and Fayoum sit under GZ in `au_v_canonical_areas`; which line owns them differs, and
  // that is a separate golden rule. The menu follows the view, so the hint does too.
  "Beni Suef": "Beni Suef City · Ehnasia · El Wasta",
  "Dokki - Mohandseen - Bolak": "Bolak El Dakrour · Nahia · Ard El Lewa",
  Fayoum: "Fayoum City · Ibshaway · Etsa",
  "Giza - Giza Centers": "El Hawamdeya · El Ayyat · El Monib",
  "Haram - Faisal": "El Haram · Kerdasa · Faisal",
  "Helwan-Maadi": "Helwan · Maadi · El Saff",
  "Imbaba - Imbaba Centers": "Imbaba · El Kit Kat · Oseem",
  "October -Zayed": "6th of October City · Sheikh Zayed · Abu Rawash",

  // ── OT · Others ────────────────────────────────────────────────────────────────────────────
  // Several of these genuinely have fewer than three bricks. Two names, or one, is the whole truth
  // for that area — it is not a truncation, and nothing is missing.
  Aswan: "Aswan · Kom Ombo · Edfu",
  Hurgada: "Hurghada",
  Luxor: "Luxor · Esna",
  "New Valley": "New Valley · El Kharga",
  "North Sinai": "El Arish",
  "Red Sea": "Safaga · 6th October St (Red Sea) · El Quseir",
  "South Sinai": "Sharm El Sheikh · Tor Sinai",
  // Sales map: Others. → Delta (3): the apply flow files both under Delta (3), matching the region map.
  Ismailia: "Ismailia · El Qantara West",
  Suez: "Suez",

  // ── UE · Upper Egypt ───────────────────────────────────────────────────────────────────────
  "Assuit 1": "Manfalout · Dairout · El Qusiya",
  "Assuit 2": "Assiut City · Abnoub · Abu Tig",
  "Minia 1": "Samalout · Matay · Maghagha",
  "Minia 2": "Minya City · Mallawi · Deir Mawas",
  "Qena 1": "Qena City · Qus · Deshna",
  "Qena 2": "Naqada · Qena City (Qena 2) · Qeft",
  Sohag1: "Sohag City · Tahta · Tima",
  Sohag2: "Dar El Salam (Sohag) · Girga · El Balyana",
};

/** The hint for a region, or null when there is none to give. Never throws. */
export function regionPlaceHint(regionCode: string): string | null {
  return regionPlaceHints[regionCode as CandidateRegionCode] ?? null;
}

/** The hint for an area, keyed by the name the menu was handed. Never throws. */
export function areaPlaceHint(areaName: string): string | null {
  return areaPlaceHints[areaName] ?? null;
}
