import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { adviseOnBuilding, adviseOnSign } from "../src/lib/phoenix-crm/place-check-advice.ts";
import { sharedPlaceKindNoun } from "../src/lib/phoenix-crm/shared-place-rules.ts";
import {
  buildingNamedOnSign,
  buildingSignboardNow,
  judgeSignboards,
  type PhoenixCrmSign,
  type PhoenixCrmSignboardCheck,
} from "../src/lib/phoenix-crm/signboard-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The buildings on the Place checks board (owner, 14 Nov 2026, "Fix all three"). Measured that day on
 * production, 231 buildings:
 *
 * 1. 25 were recommended for REJECT, 20 of them in use, and in 9 the sign named the same building —
 *    written the way a board writes it ("كفر الدوار" for the typed "كفرالدوار", "النزهة" for the typo
 *    "النرهه"), or in English only ("Alaa Ezzat Hospital"). The bulk "Pick the 25 the system
 *    recommends rejecting" would have retired every customer seated behind those doors.
 * 2. 78 hospitals and medical centres read "The sign names this polyclinic".
 * 3. 65 buildings said their sign "is read again tonight", the oldest captured on 10 Oct: the night
 *    pass reads a customer's own place only, never a building.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

function sign(placeNames: string[], text: string | null = placeNames.join(" ")): PhoenixCrmSign {
  return { box: null, kind: "medical", legibility: "clear", personNames: [], placeNames, text };
}

function judge(name: string, signs: PhoenixCrmSign[], subject?: "customer" | "building"): PhoenixCrmSignboardCheck {
  return judgeSignboards({ croppedFraction: 0, customerName: name, listType: "AM", note: null, signPresent: true, signs, ...(subject ? { subject } : {}) });
}

/** The seven shapes production held as "a different place" while the sign named the building. */
const SAME_BUILDING: ReadonlyArray<readonly [string, string]> = [
  ["مستشفى كفرالدوار العام", "مستشفى كفر الدوار العام"],
  ["مستشفى الأنباتكلا التخصصي", "مستشفى الأنبا تكلا التخصصي ANBA TAKLA HOSPITAL"],
  ["عيادة د. ابراهيم ابو الخير", "Abo Elkheir Kids Clinic د. إبراهيم أبوالخير"],
  ["يس عبدالغفار", "مركز د.يس عبد الغفار الخيرى"],
  ["عيادات مستشفى العبور", "CH مستشفى العبور"],
  ["مستشفي النرهه", "NEW NOZHA HOSPITAL NH مستشفى النزهة الجديدة"],
  ["Alma clinc", "ALMA YOUR MIND MATTERS"],
];

/** Signs that truly name another place: each stays a flag. */
const ANOTHER_PLACE: ReadonlyArray<readonly [string, string]> = [
  ["مستشفى الندى التخصصي", "التخصصي"],
  ["مستشفى ديرمواس", "العيادات الخارجية"],
  ["رودينا", "معامل البرج للتحاليل الطبية"],
  ["مستشفي كنيسه العذراء", "المركز الطبي للسيدة العذراء"],
];

function checkBuildingMatcher() {
  for (const [name, text] of SAME_BUILDING) {
    assert.ok(buildingNamedOnSign(name, sign([text])), `🔴 the sign "${text}" names the building "${name}"`);
    assert.equal(judge(name, [sign([text])], "building").verdict, "match", `a building's sign check matches "${name}"`);
  }
  // 🔴 BUILDINGS ONLY: a customer's own place keeps the customer rule exactly as it was.
  assert.equal(judge("مستشفى كفرالدوار العام", [sign(["مستشفى كفر الدوار العام"])]).verdict, "other_name", "a customer's place is not judged by the building rule");
  assert.equal(judge("مستشفي النرهه", [sign(["مستشفى النزهة الجديدة"])], "customer").verdict, "other_name");

  for (const [name, text] of ANOTHER_PLACE) {
    assert.ok(!buildingNamedOnSign(name, sign([text])), `"${text}" does not name "${name}"`);
    assert.equal(judge(name, [sign([text])], "building").verdict, "other_name", `🔴 a sign naming another place stays a flag on "${name}"`);
  }
  // A name made only of words that say what kind of place it is names nothing.
  assert.ok(!buildingNamedOnSign("عيادات المركز", sign(["مركز عيادات النور"])));
  assert.ok(!buildingNamedOnSign(null, sign(["مستشفى النور"])));

  // 🔴 A BUILDING IS NEVER FLAGGED ON A SIGN ONLY IN THE OTHER SCRIPT: the admin's look, never a reject.
  const english = judge("مستشفى علاء عزت", [sign(["Alaa Ezzat Hospital"])], "building");
  assert.equal(english.verdict, "unjudged");
  assert.equal(english.reason, "not_comparable");
  assert.equal(adviseOnBuilding({ signboard: { verdict: english.verdict, reason: english.reason, signText: english.signText } }).kind, "look");
  assert.equal(judge("مستشفى علاء عزت", [sign(["Alaa Ezzat Hospital"])]).verdict, "other_name", "a customer whose name pins in Latin is still flagged as before");
  // An Arabic sign naming another place beside the English one is still a flag.
  assert.equal(judge("مستشفى علاء عزت", [sign(["Alaa Ezzat Hospital"]), sign(["مستشفى النور"])], "building").verdict, "other_name");
}

function checkBoardRejudge() {
  const stored = (over: Partial<PhoenixCrmSignboardCheck>): PhoenixCrmSignboardCheck =>
    ({
      attempts: 2,
      checkedAt: "2026-10-10T08:00:00.000Z",
      croppedFraction: 0.1,
      nameScore: null,
      note: null,
      personNames: [],
      placeNames: [],
      reason: "sign_other_name",
      signText: "مستشفى كفر الدوار العام",
      signs: [sign(["مستشفى كفر الدوار العام"])],
      verdict: "other_name",
      ...over,
    }) as PhoenixCrmSignboardCheck;

  const fixed = buildingSignboardNow(stored({}), "مستشفى كفرالدوار العام");
  assert.equal(fixed.verdict, "match", "🔴 a building held on a verdict the rules no longer give reads as today's verdict on the board");
  assert.equal(fixed.attempts, 2, "no photo is read: the count stays as stored");
  assert.equal(fixed.checkedAt, "2026-10-10T08:00:00.000Z", "and so does the time it was read");

  // A brick answers for the town word, exactly as on a customer's place.
  const taiba = stored({ signs: [sign(["مستشفى طيبة التخصصي", "TEBA"])], signText: "TEBA مستشفى طيبة التخصصي" });
  assert.equal(buildingSignboardNow(taiba, "مستشفي طيبه جرجا", "جرجا").verdict, "match");
  assert.equal(buildingSignboardNow(taiba, "مستشفي طيبه جرجا", null).verdict, "other_name", "without the brick the town word is missing");

  // 🔴 IT ONLY EVER SOFTENS.
  const flag = stored({ signs: [sign(["مستشفى النور"])], signText: "مستشفى النور" });
  assert.equal(buildingSignboardNow(flag, "مستشفى الندى التخصصي").verdict, "other_name", "a true flag stays a flag");
  const unread = stored({ reason: "unreadable", signs: [sign(["مستشفى النور"])], verdict: "unjudged" });
  assert.equal(buildingSignboardNow(unread, "مستشفى الندى التخصصي").verdict, "unjudged", "🔴 an unread sign never becomes a flag here");
  const matched = stored({ reason: null, signs: [sign(["مستشفى النور"])], verdict: "match" });
  assert.equal(buildingSignboardNow(matched, "مستشفى الندى التخصصي").verdict, "match", "🔴 a match is never taken back here");
  const noName = stored({ reason: "sign_no_name", signs: [sign(["مستشفى كفر الدوار العام"])], verdict: "no_name" });
  assert.equal(buildingSignboardNow(noName, "مستشفى كفرالدوار العام").verdict, "no_name", "a 'no sign' verdict leaned on what is not stored");
  assert.equal(buildingSignboardNow(stored({ signs: [] }), "مستشفى كفرالدوار العام").verdict, "other_name", "an old check with no signs stored is left as it is");

  // The board and the capture both go through it.
  const server = stripComments(read("src/lib/phoenix-crm/server/shared-places.ts"));
  assert.match(server, /buildingSignboardNow\(stored as unknown as PhoenixCrmSignboardCheck, buildingName, brickName\)/, "the board shows the building's sign judged by today's rules");
  assert.match(server, /signboardOf\(row\.signboard_check, String\(row\.name \?\? ""\), text\(row\.brick_name\)\)/);
  assert.match(server, /const signboard = buildingSignboardNow\(signRead, draft\.value\.name, text\(located\.brick_name\)\)/, "a new capture is judged by the building rule too");
}

function checkWording() {
  // 🔴 A BUILDING'S SIGN IS NEVER READ AGAIN, so it is never promised a night read.
  const building = adviseOnBuilding({ signboard: { verdict: "unjudged", reason: "unreadable", signText: null } });
  assert.equal(building.kind, "look");
  assert.ok(!/tonight|again/i.test(building.reason), `🔴 a building is not told its sign is read again: "${building.reason}"`);
  assert.match(adviseOnSign({ verdict: "unjudged", reason: "unreadable", signText: null }).reason, /read again tonight/, "a customer's own place is still read again tonight");
  assert.match(adviseOnSign({ verdict: "unjudged", reason: "not_comparable", signText: "Alaa Ezzat" }, "building").reason, /another script from the building's name/);

  assert.equal(sharedPlaceKindNoun("polyclinic"), "polyclinic");
  assert.equal(sharedPlaceKindNoun("medical_centre"), "medical centre");
  assert.equal(sharedPlaceKindNoun("hospital_outpatient"), "hospital");
  assert.equal(sharedPlaceKindNoun(null), "building");

  // 🔴 A HOSPITAL IS NEVER CALLED A POLYCLINIC on the board or the review deck.
  const list = stripComments(read("src/components/phoenix-crm/shared-place-list.tsx"));
  assert.ok(!/names this polyclinic/.test(list), "the match label is not 'this polyclinic' for every kind");
  assert.match(list, /`The sign names this \$\{sharedPlaceKindNoun\(kind\)\}`/);
  assert.match(list, /a \{sharedPlaceKindNoun\(row\.kind\)\} has none/, "the Google sentence names the building's own kind");
  assert.ok(!/could not be read yet/.test(list), "🔴 never 'yet' on a building's sign");
  const deck = stripComments(read("src/components/place-review-deck/review-deck.tsx"));
  assert.ok(!/The polyclinic itself|>\s*Polyclinic ·/.test(deck), "the review deck names the building's own kind");
  assert.match(deck, /venueSignboardText\(venue\.signboard, venue\.kind\)/);
}

export function runPhoenixCrmBuildingSignTests() {
  checkBuildingMatcher();
  checkBoardRejudge();
  checkWording();
}
