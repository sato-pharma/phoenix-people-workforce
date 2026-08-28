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
//   AREA hints  — the 3 highest-value BRICKS in that area, exactly as the owner asked. Arabic,
//                 because that is how bricks are named in this database and how an applicant
//                 recognises their own town. He anticipated this himself: "even if in Arabic".
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
// longer says Ismailia or Suez, even though the area LISTS behind those rows still offer those
// areas until the sales half of the split lands. That residue is a known gap, written up in
// docs/recruitment-inbound-intake.md; it is not a bug in this file.
//
// ONE KNOWN DISAGREEMENT IS LEFT STANDING: Matrouh. The recruitment map files it under Others, but
// its sales bricks (مرسى مطروح) sit inside AREA "Alex West", so Alex-BHR is the only row whose area
// list can reach the job. AB therefore keeps مطروح. Matrouh is not in the top three of Others by
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
  AB: "الإسكندرية · البحيرة · مطروح",
  CA: "شرق القاهرة · مدينة نصر · مصر الجديدة",
  D1: "الغربية · المنوفية · كفر الشيخ",
  D2: "الدقهلية · دمياط · بورسعيد",
  // Delta (3), opened 2026-08-28 — all four governorates, because four is everything it has and
  // they fit in one line. This is the row the owner is recruiting into, and the one he singled out.
  D3: "القليوبية · الشرقية · الإسماعيلية · السويس",
  GZ: "الجيزة · الفيوم · بني سويف",
  OT: "الأقصر · أسوان · البحر الأحمر",
  UE: "أسيوط · سوهاج · قنا",
};

/**
 * The three highest-value bricks in each area, biggest first.
 *
 * KEYED BY AREA NAME, not area code, because that is what `areaMenu` is handed — the session loads
 * area NAMES live from `au_v_canonical_areas`. A renamed area therefore loses its hint rather than
 * showing the wrong one, and the registered test fails on the mismatch so it is noticed. All 49
 * active areas are present as of 2026-08-28.
 *
 * Region groupings in the comments below are the SALES map, which is what drives the area list an
 * applicant is shown. Five of these areas — Qalubeya, Sharkia 1/2, Suez, Ismailia — are Delta (3)
 * in the recruitment map already; they are commented where the area menu still puts them.
 */
export const areaPlaceHints: Record<string, string> = {
  // ── AB · Alex-BHR ──────────────────────────────────────────────────────────────────────────
  "Alex Center": "سموحه · سبورتنج · الحضره",
  "Alex East": "خورشيد · سيدى بشر · فليمنج",
  "Alex West": "مرسى مطروح · العامرية · العجمى",
  "Behira 1": "دمنهور شبراخيت · كوم حماده · إيتاى البارود",
  "Behira 2": "كفر الدوار · أبو حمص · المحموديه",

  // ── CA · Cairo ─────────────────────────────────────────────────────────────────────────────
  "Cairo East 1": "ش رمسيس · عين شمس الشرقيه · المطريه",
  "Cairo East 2": "مدينة السلام · المرج · مدينة العبور",
  "Cairo West": "شبرا الخيمه · بهتيم · روض الفرج",
  "Down town": "الأزبكيه · السيده زينب · ش القصر العينى",
  Heliopolis: "ميدان هليوبوليس · روكسى · النزهه الجديدة",
  "Nasr City": "مدينة نصر · الحي السابع · المقطم",

  // ── D1 · Delta (1) ─────────────────────────────────────────────────────────────────────────
  "Gharbia 1 (Tanta)": "طنطا · كفر الزيات · السنطة",
  "Gharbia 2 (Mahalla)": "زفته · المحله الكبرى · سمنود",
  "Kafr El-Sheikh 1": "كفر الشيخ · دسوق · بلطيم",
  "Kafr El-Sheikh 2": "فوه · سيدى سالم · الحامول",
  "Menoufia 1": "شبين الكوم · قويسنا · بركة السبع",
  "Menoufia 2": "أشمون · منوف · باجور",
  // Delta (3) in the recruitment map since #2509; still listed under Delta (1) in the area menu.
  Qalubeya: "بنها · شبين القناطر · قليوب",

  // ── D2 · Delta (2) ─────────────────────────────────────────────────────────────────────────
  "Dakahlia 1": "المنصورة · طلخا · المعصره شربين",
  "Dakahlia 2": "ميت غمر · السنبلاوين · أجا",
  "Dakahlia 3": "دكرنس · المنزلة · منيا النصر",
  "Port said - Domiat": "دمياط · بور سعيد · كفر سعد",
  // Delta (3) in the recruitment map since #2509; still listed under Delta (2) in the area menu.
  "Sharkia 1": "الزقازيق · أبو حماد · منيا القمح",
  "Sharkia 2": "فاقوس · الحسينيه · أبو كبير",

  // ── GZ · Giza ──────────────────────────────────────────────────────────────────────────────
  // Beni Suef and Fayoum sit under GZ in `au_v_canonical_areas`; which line owns them differs, and
  // that is a separate golden rule. The menu follows the view, so the hint does too.
  "Beni Suef": "مدينة بنى سويف · إهناسيا · الوسطى",
  "Dokki - Mohandseen - Bolak": "بولاق الدكرور · ناهيا · أرض اللواء",
  Fayoum: "مدينة الفيوم · إبشواى · إطسا",
  "Giza - Giza Centers": "الحوامديه · العياط · المنيب",
  "Haram - Faisal": "الهرم · كرداسه · فيصل",
  "Helwan-Maadi": "حلوان · المعادى · الصف",
  "Imbaba - Imbaba Centers": "إمبابه · الكيت كات · اوسيم",
  "October -Zayed": "مدينة 6 أكتوبر · الشيخ زايد · ابو رواش",

  // ── OT · Others ────────────────────────────────────────────────────────────────────────────
  // Several of these genuinely have fewer than three bricks. Two names, or one, is the whole truth
  // for that area — it is not a truncation, and nothing is missing.
  Aswan: "اسوان · كوم امبو · ادفو",
  Hurgada: "الغردقة",
  Luxor: "الاقصر · اسنا",
  "New Valley": "الوادى الجديد · الخارجة",
  "North Sinai": "العريش",
  "Red Sea": "سفاجا · ش6 اكتوبر-البحرالاحمر · القصير",
  "South Sinai": "شرم الشيخ · طور سيناء",
  // Delta (3) in the recruitment map since #2509; still listed under Others in the area menu.
  Ismailia: "الاسماعيليه · القنطرةغرب",
  Suez: "السويس",

  // ── UE · Upper Egypt ───────────────────────────────────────────────────────────────────────
  "Assuit 1": "منفلوط · ديروط · القوصيه",
  "Assuit 2": "مدينة أسيوط · أبنوب · أبو تيج",
  "Minia 1": "سمالوط · مطاى · مغاغه",
  "Minia 2": "مدينة المنيا · ملاوى · دير مواس",
  "Qena 1": "مدينة قنا · قوص · دشنا",
  "Qena 2": "نقادة · مدينة قنا - قنا 2 · قفط",
  Sohag1: "مدينة سوهاج · طهطا · طما",
  Sohag2: "دار السلام -سوهاج · جرجا · البلينا",
};

/** The hint for a region, or null when there is none to give. Never throws. */
export function regionPlaceHint(regionCode: string): string | null {
  return regionPlaceHints[regionCode as CandidateRegionCode] ?? null;
}

/** The hint for an area, keyed by the name the menu was handed. Never throws. */
export function areaPlaceHint(areaName: string): string | null {
  return areaPlaceHints[areaName] ?? null;
}
