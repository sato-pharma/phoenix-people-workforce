import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  chooseSignboard,
  chooseSignToReadAgain,
  jsonbSafe,
  judgeSignboard,
  judgeSignboards,
  nameIsPinnableAcrossScripts,
  SIGNBOARD_CROP_MIN_FRACTION,
  signboardApplies,
  signboardHoldRecord,
  signboardHoldsForReview,
  signboardNameIsUsable,
  signboardUnjudged,
  signNamesCustomer,
  stampBandFraction,
  type PhoenixCrmSign,
} from "../src/lib/phoenix-crm/signboard-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the signboard check (owner, 2026-10-08).
 *
 * The module validated a LOCATION while the owner graded an IDENTIFICATION: of 643 places validated
 * in five days, 179 photographs showed no building, a blank wall, paper or a car window, and 561 got
 * no identity check of any kind. His rulings, each pinned here as behaviour:
 *
 *   1. Require the customer's name always — a confident "no signboard at all" HOLDS.
 *   7. "NEVER A PERSON — AM SIGN / PM SIGN": an AM capture is judged on the place name only, and an AM
 *      sign naming nobody is a MATCH; a PM capture is judged on the person.
 *
 * And the module's own safety property: NO ANSWER NEVER HOLDS. A lapsed key or a slow model must
 * never hold every validation in the field.
 */

const judge = (overrides: Partial<Parameters<typeof judgeSignboard>[0]>) =>
  judgeSignboard({
    customerName: "احمد سمير عبدالله",
    listType: "PM",
    signPresent: true,
    signText: null,
    personNames: [],
    placeNames: [],
    note: null,
    croppedFraction: 0.18,
    ...overrides,
  });

function checkStampBand(): void {
  // 🔴 The crop must clear the camera's frame guide in BOTH canvas shapes, or a signboard framed
  // exactly where the rep was told to put it is cropped away before it is read.
  const capture = readFileSync("src/components/phoenix-crm/live-photo-capture.tsx", "utf8");
  const bottom = Number(/const SIGNBOARD_FRAME_BOTTOM = ([0-9.]+);/.exec(capture)?.[1]);
  assert.ok(bottom > 0 && bottom < 1, "the frame guide's bottom edge is a fraction of the frame");
  const portrait = stampBandFraction(720, 1280);
  const landscape = stampBandFraction(1280, 720);
  assert.equal(portrait, SIGNBOARD_CROP_MIN_FRACTION, "portrait clamps to the one-line floor");
  assert.equal(landscape, 0.4917, "landscape crops the eight-line worst case");
  assert.ok(1 - portrait > bottom, "portrait: the crop never reaches the framed signboard");
  assert.ok(1 - landscape > bottom, "landscape: the crop never reaches the framed signboard");

  // The crop restates drawStamp line for line; if one changes without the other this goes red.
  for (const line of [
    "Math.max(16, Math.round(canvas.width * 0.022))",
    "Math.round(fontSize * 1.38)",
    "Math.round(fontSize * 0.75)",
  ]) {
    assert.ok(capture.includes(line), `drawStamp still computes ${line}`);
  }
  assert.equal(stampBandFraction(0, 0), 0.6, "a frame with no size crops the maximum, never nothing");
}

function checkVerdicts(): void {
  // Ruling 1: no signboard at all, said confidently, holds — on either list.
  for (const listType of ["PM", "AM"] as const) {
    const none = judge({ listType, signPresent: false });
    assert.equal(none.verdict, "no_name", `${listType}: a photo with no signboard is held`);
    assert.equal(signboardHoldsForReview(none), true);
  }
  // But an UNSURE model (null) never holds.
  const unsure = judge({ signPresent: null });
  assert.equal(unsure.verdict, "unjudged", "unsure is unjudged");
  assert.equal(signboardHoldsForReview(unsure), false, "and unjudged never holds");

  // Ruling 7, AM half: an AM sign naming no place is a match, whoever it names.
  const amPeopleOnly = judge({ listType: "AM", personNames: ["د. محمد علي"], signText: "د. محمد علي" });
  assert.equal(amPeopleOnly.verdict, "match", "an AM sign that names nobody's place is a match — never judged on a person");
  // AM: the place name is what is read.
  const amPlace = judge({ listType: "AM", customerName: "مستشفى النور التخصصي", placeNames: ["مستشفى النور التخصصي"] });
  assert.equal(amPlace.verdict, "match");
  const amOtherPlace = judge({ listType: "AM", customerName: "مستشفى النور التخصصي", placeNames: ["مركز الشفاء الطبي"] });
  assert.equal(amOtherPlace.verdict, "other_name", "an AM sign naming a different place is held");

  // PM: the person is what is read, honorifics folded away.
  const pmMatch = judge({ personNames: ["د. احمد سمير"], signText: "د. احمد سمير" });
  assert.equal(pmMatch.verdict, "match", "a three-token name may lose one token; the honorific is folded");
  const pmOther = judge({ personNames: ["د. محمود حسن"], signText: "د. محمود حسن" });
  assert.equal(pmOther.verdict, "other_name");
  assert.equal(pmOther.reason, "sign_other_name");
  const pmPlaceOnly = judge({ placeNames: ["مركز الشفاء الطبي"] });
  assert.equal(pmPlaceOnly.verdict, "no_name", "a PM sign naming only a place has no nameplate for the person");

  // The name test on its own: a two-token name must find both tokens.
  assert.equal(
    signNamesCustomer({ customerName: "احمد سمير", listType: "PM", personNames: ["احمد حسن"], placeNames: [], signText: null }).matches,
    false,
    "a shared first name is not the customer",
  );
  assert.equal(
    signNamesCustomer({ customerName: "احمد سمير", listType: "PM", personNames: [], placeNames: [], signText: null }).matches,
    null,
    "nothing read is an absence, never a mismatch",
  );
  assert.equal(signboardNameIsUsable("احمد"), false, "a one-token name is not evidence");
  assert.equal(signboardNameIsUsable("احمد سمير"), true);
  assert.equal(signboardApplies("Pharmacy"), false, "a pharmacy is never asked");
  assert.equal(signboardApplies("PM") && signboardApplies("AM"), true);
}

function checkRecords(): void {
  const unjudged = signboardUnjudged("call_failed");
  assert.equal(unjudged.verdict, "unjudged");
  assert.equal(unjudged.reason, "call_failed", "an absence always says WHY, so NOT CHECKED never reads as CLEAN");

  const record = signboardHoldRecord(judge({ personNames: ["د. محمود حسن"] }), { lat: 30, lon: 31, accuracyMeters: 9, source: "photo" });
  assert.equal(record.verdict, "signboard", "the review row says which detector held it");
  assert.deepEqual(record.listings, [], "an empty listing list, never a missing key, for the queue loader");
}

function checkServerAndSweep(): void {
  const server = stripComments(readFileSync("src/lib/phoenix-crm/server/signboard-check.ts", "utf8"));
  assert.ok(server.includes("PHOENIX_CRM_SIGNBOARD_TIMEOUT_MS = 8_000"), "a rep at the door waits eight seconds at most");
  assert.ok(server.includes('await import("sharp")'), "sharp is loaded lazily, never at the top of a route-reachable file");
  assert.ok(server.includes("downloadIssuedPlacePhoto"), "a save reads only a path the server issued to this person");
  assert.ok(/Set sign_present to false only when/.test(readFileSync("src/lib/phoenix-crm/server/signboard-check.ts", "utf8")), "the prompt asks for false only when sure");

  // The nightly pass never holds, never un-validates, and tells nobody.
  const sweep = stripComments(readFileSync("src/lib/phoenix-crm/server/signboard-sweep.ts", "utf8"));
  for (const banned of ["hold_review", "validation_reviews", "notifyPhoenixCrm", "status:"]) {
    assert.ok(!sweep.includes(banned), `the signboard sweep never touches ${banned}`);
  }
  assert.ok(sweep.includes('.order("captured_at", { ascending: true })'), "oldest first, so an old backlog is never left behind");
  assert.ok(sweep.includes('.neq("customer.list_type", "Pharmacy")'), "pharmacies are excluded at the database");
  assert.ok(sweep.includes('.eq("is_test", false)'), "real entries only");
  assert.ok(sweep.includes("filePlaceSignboardFlag"), "a confident negative is FILED as a case for the board");

  const dupes = readFileSync("src/lib/phoenix-crm/server/photo-dupes.ts", "utf8");
  const photos = dupes.indexOf("runPhoenixCrmPhotoSweep({ limit: options.limit })");
  const signs = dupes.indexOf("runPhoenixCrmSignboardSweep()");
  const behaviour = dupes.indexOf("runPhoenixCrmBehaviourSweep({ today: options.today })");
  assert.ok(photos > 0 && photos < signs && signs < behaviour, "photos, then signboards, then the month's shape");
}

/**
 * THE FIVE PLACES THIS CHECK HAD HELD, REPLAYED THROUGH THE READER THAT REPLACED IT.
 *
 * Read off production on 2026-10-09 — every verdict, every transcription and every note below is the
 * row the old single-sign reader actually wrote. FOUR of the five holds were wrong, and not one of
 * them was wrong about a letter: three were a board the reader itself said it could not read, and one
 * was the clothes shop next door. The fifth was right and must stay right, which is what makes this
 * the test that matters: it is one real batch, and a change that fixes the four by weakening the
 * check breaks the fifth.
 *
 * `signs` is what the new reader returns for each of those photographs — the board it quoted, plus
 * the one its own note says it could not read.
 */
function checkManySigns(): void {
  const sign = (over: Partial<PhoenixCrmSign>): PhoenixCrmSign => ({
    box: null,
    kind: "unknown",
    legibility: "clear",
    personNames: [],
    placeNames: [],
    text: null,
    ...over,
  });
  const judgeMany = (over: Partial<Parameters<typeof judgeSignboards>[0]>) =>
    judgeSignboards({
      croppedFraction: 0.18,
      customerName: "احمد سمير عبدالله",
      listType: "PM",
      note: null,
      signPresent: true,
      signs: [],
      ...over,
    });

  // 1 · رضوان محمد — the clothes shop was read clearly; the practice's own board was not read at all.
  const shop = judgeMany({
    customerName: "رضوان محمد",
    signs: [
      sign({
        box: { height: 0.3, left: 0.1, top: 0.1, width: 0.7 },
        kind: "other",
        placeNames: ["EL BALAD"],
        text: "DOKANAT\nBANAT EL BALAD\nWOMEN'S & KIDS' STYLE",
      }),
      sign({ box: { height: 0.1, left: 0.05, top: 0.5, width: 0.2 }, kind: "medical", legibility: "unreadable" }),
    ],
  });
  assert.equal(shop.verdict, "unjudged", "a clothes shop read clearly beside a board that was not read holds nothing");
  assert.equal(signboardHoldsForReview(shop), false);

  // 2 · اسلام عبدالعال — a room sign read clearly under an Arabic nameplate it could not transcribe.
  const roomSign = judgeMany({
    customerName: "اسلام عبدالعال",
    note: "Arabic text above the Clinic sign is not clear enough to transcribe confidently.",
    signs: [
      sign({ kind: "medical", placeNames: ["Clinic 4"], text: "Clin ic 4" }),
      sign({ kind: "medical", legibility: "unreadable" }),
    ],
  });
  assert.equal(roomSign.verdict, "unjudged", "a PM capture is asked WHO, and a room number does not answer it");

  // 3 · احمد صباح الشعراوي — one line of a board the reader itself called unclear. الشرباوي for
  //     الشعراوي is two letters lost to scale, and a partial read may not file a flag on it.
  const partialBoard = judgeMany({
    customerName: "احمد صباح الشعراوي",
    note: "نص اللافتة غير واضح بالكامل بخلاف اسم الدكتور الظاهر في أعلى اللافتة.",
    signs: [
      sign({ kind: "medical", legibility: "partial", personNames: ["أحمد الشرباوي"], text: "عيادات\nدكتور أحمد الشرباوي" }),
    ],
  });
  assert.equal(partialBoard.verdict, "unjudged", "a board read in part is not evidence that it names somebody else");

  // 3b · The SAME board, read clearly, is still a flag. The rule is the legibility, never the name.
  const clearBoard = judgeMany({
    customerName: "احمد صباح الشعراوي",
    signs: [sign({ kind: "medical", personNames: ["أحمد الشرباوي"], text: "عيادات\nدكتور أحمد الشرباوي" })],
  });
  assert.equal(clearBoard.verdict, "other_name", "a clear board naming another person is held, exactly as before");
  assert.equal(clearBoard.reason, "sign_other_name");

  // 4 · محمد فرج — held as `other_name` with `signText` NULL, off one line of a board whose other
  //     lines its own note called unreadable. A flag that could not quote the board it was read from.
  const noEvidence = judgeMany({
    customerName: "محمد فرج",
    note: "The board includes the name “محمد فريد”. Other lines are not confidently readable from this image.",
    signs: [sign({ kind: "medical", legibility: "partial", personNames: ["محمد فريد"], text: null })],
  });
  assert.equal(noEvidence.verdict, "unjudged", "one line of a board, with the rest unread, is not a flag");
  assert.equal(noEvidence.signText, null, "and what it could not quote stays null rather than being invented");
  const evidenceGuard = judgeMany({
    customerName: "محمد فرج",
    signs: [sign({ box: { height: 0.2, left: 0, top: 0, width: 0.2 } })],
  });
  assert.equal(evidenceGuard.verdict, "unjudged", "a box with no text and no names is not a flag either");

  // 5 · مستشفى المنشاوى العام — the photograph really is Tanta General Hospital. THE ONE TRUE HOLD,
  //     and it has to survive every rule above.
  const tanta = judgeMany({
    customerName: "مستشفى المنشاوى العام",
    listType: "AM",
    signs: [sign({ kind: "medical", placeNames: ["TANTA GENERAL HOSPITAL"], text: "TANTA GENERAL HOSPITAL" })],
  });
  assert.equal(tanta.verdict, "other_name", "a clear board naming another hospital is held — across scripts too");

  // 6 · The same hospital signing ITSELF in English. Before the cross-script compare this scored 0
  //     and was held for its SCRIPT rather than for its name.
  const menshawy = judgeMany({
    customerName: "مستشفى المنشاوى العام",
    listType: "AM",
    signs: [sign({ kind: "medical", placeNames: ["EL MENSHAWY GENERAL HOSPITAL"], text: "EL MENSHAWY GENERAL HOSPITAL" })],
  });
  assert.equal(menshawy.verdict, "match", "an Arabic list row and an English board are the same hospital");

  // 7 · ANY sign naming him is a match — the plate beside the shop, not the biggest board in frame.
  const plate = judgeMany({
    customerName: "احمد سمير عبدالله",
    signs: [
      sign({ box: { height: 0.4, left: 0, top: 0, width: 0.9 }, kind: "other", text: "SUPER MARKET EL NOUR" }),
      sign({
        box: { height: 0.06, left: 0.62, top: 0.55, width: 0.12 },
        kind: "medical",
        personNames: ["د. احمد سمير عبدالله"],
        text: "د. احمد سمير عبدالله",
      }),
    ],
  });
  assert.equal(plate.verdict, "match", "the practice's own plate is routinely the smallest sign in the photograph");

  // 8 · A flag is never filed across two scripts on a name this scheme cannot write down. عبدالعال
  //     compiles to a pattern demanding the inner article's alif as a literal "a"; English writes
  //     that syllable "abdel", so the comparison cannot be conclusive either way.
  assert.equal(nameIsPinnableAcrossScripts("مستشفى المنشاوى العام", "AM"), true);
  assert.equal(nameIsPinnableAcrossScripts("اسلام عبدالعال", "PM"), false, "an عبد compound does not pin in Latin letters");
  const englishPlate = judgeMany({
    customerName: "اسلام عبدالعال",
    signs: [sign({ kind: "medical", personNames: ["Dr Islam Abdelaal"], text: "Dr Islam Abdelaal" })],
  });
  assert.equal(englishPlate.verdict, "unjudged", "nothing to compare is never a mismatch");
  assert.equal(englishPlate.reason, "not_comparable");

  // 9 · Which sign the record shows. PM: the plate with a person's name, smallest first. AM: the
  //     largest board that names a place.
  const big = sign({ box: { height: 0.4, left: 0, top: 0, width: 0.9 }, kind: "other", placeNames: ["EL NOUR MARKET"], text: "SUPER MARKET" });
  const small = sign({ box: { height: 0.05, left: 0.6, top: 0.6, width: 0.1 }, kind: "medical", personNames: ["د. محمود حسن"], text: "د. محمود حسن" });
  assert.equal(chooseSignboard([big, small], "PM"), small, "PM reads the nameplate, never the biggest board");
  assert.equal(chooseSignboard([small, big], "AM"), big, "AM reads the building's own board, which is the big one");
  // Two plates that both name a person: the practice's own first, and then the SMALLER of them —
  // at a doorway the nameplate is the small plate and the board above it is the building's.
  const lawyer = sign({ box: { height: 0.2, left: 0, top: 0, width: 0.5 }, kind: "other", personNames: ["محمود سيد"], text: "محمود سيد — محاسب قانوني" });
  const plateA = sign({ box: { height: 0.12, left: 0.2, top: 0.3, width: 0.5 }, kind: "medical", personNames: ["د. هاني فؤاد"], text: "د. هاني فؤاد" });
  const plateB = sign({ box: { height: 0.04, left: 0.7, top: 0.7, width: 0.08 }, kind: "medical", personNames: ["د. محمود حسن"], text: "د. محمود حسن" });
  assert.equal(chooseSignboard([lawyer, plateA], "PM"), plateA, "another trade's plate is not the practice's, whatever its size");
  assert.equal(chooseSignboard([plateA, plateB], "PM"), plateB, "and between two practice plates the smaller one is the nameplate");

  // 10 · The owner's two rulings, untouched by any of the above.
  const nothing = judgeMany({ signPresent: false, signs: [] });
  assert.equal(nothing.verdict, "no_name", "a photo with no signboard of any kind is still held");
  const amNamesNobody = judgeMany({
    customerName: "مستشفى النور التخصصي",
    listType: "AM",
    signs: [sign({ kind: "medical", personNames: ["د. محمد علي"], text: "د. محمد علي" })],
  });
  assert.equal(amNamesNobody.verdict, "match", "an AM board that names nobody's place is still a match");

  // 12 · 🔴 THE ONE TRUE HOLD, THE WAY THE NEW READER ACTUALLY SEES IT. Re-reading that photograph on
  //      2026-10-09 returned a SECOND board — مستشفى طنطا العام, the same hospital in Arabic — and the
  //      place came back MATCHED, because a three-token name may lose one and the two it kept were
  //      "مستشفى" and "العام". It had only ever been held because the English board could not be
  //      compared to an Arabic list row at all. The quorum is counted on the DISTINCTIVE words now.
  assert.equal(
    signNamesCustomer({
      customerName: "مستشفى المنشاوى العام",
      listType: "AM",
      personNames: [],
      placeNames: ["مستشفى طنطا العام"],
      signText: "مستشفى طنطا العام",
    }).matches,
    false,
    "two general hospitals share every word but the one that names them",
  );
  const tantaArabic = judgeMany({
    customerName: "مستشفى المنشاوى العام",
    listType: "AM",
    signs: [
      sign({ box: { height: 0.2, left: 0.1, top: 0.1, width: 0.6 }, kind: "medical", placeNames: ["TANTA GENERAL HOSPITAL"], text: "TANTA GENERAL HOSPITAL" }),
      sign({ box: { height: 0.1, left: 0.1, top: 0.35, width: 0.5 }, kind: "medical", placeNames: ["مستشفى طنطا العام"], text: "مستشفى طنطا العام" }),
    ],
  });
  assert.equal(tantaArabic.verdict, "other_name", "the true hold survives the board being read in BOTH scripts");
  assert.equal(
    signNamesCustomer({ customerName: "مستشفى النور التخصصي", listType: "AM", personNames: [], placeNames: ["مستشفى النور التخصصي"], signText: null }).matches,
    true,
    "and a hospital still matches itself",
  );
  assert.equal(
    signNamesCustomer({ customerName: "مستشفى عام", listType: "AM", personNames: [], placeNames: ["مستشفى طنطا العام"], signText: null }).matches,
    null,
    "a name made only of kind words identifies nothing — an absence, never a mismatch",
  );

  // 13 · WHICH sign is cropped out and read again — the opposite question to which sign is quoted.
  //      Judging the crop on its own, and cropping the sign that was already read clearly, held
  //      رضوان محمد a second time: a clothes shop read clearly, and above it a practice board read
  //      only in part — "مركز الدكتور رضوان القصصي", which is the sign that would answer.
  const clearShop = sign({ box: { height: 0.3, left: 0.1, top: 0.1, width: 0.7 }, kind: "other", placeNames: ["DOKANAT BANAT EL BALAD"], text: "DOKANAT BANAT EL BALAD" });
  const partialPractice = sign({
    box: { height: 0.12, left: 0.15, top: 0.45, width: 0.4 },
    kind: "medical",
    legibility: "partial",
    personNames: ["رضوان القصصي"],
    text: "مركز الدكتور رضوان القصصي",
  });
  assert.equal(
    chooseSignToReadAgain([clearShop, partialPractice], "PM"),
    partialPractice,
    "read again the sign that would ANSWER and that defeated the reader, never the one already read",
  );
  assert.equal(chooseSignboard([clearShop, partialPractice], "PM"), clearShop, "while the sign QUOTED is still the one that was read");
  // Two plates that BOTH name a person: the one read only in part is the one worth the second call,
  // because the other has already given up everything it has.
  const readPlate = sign({ box: { height: 0.1, left: 0.1, top: 0.1, width: 0.3 }, kind: "medical", personNames: ["د. هاني فؤاد"], text: "د. هاني فؤاد" });
  const halfReadPlate = sign({ box: { height: 0.1, left: 0.5, top: 0.1, width: 0.3 }, kind: "medical", legibility: "partial", personNames: ["… رضوان"], text: "مركز … رضوان" });
  assert.equal(
    chooseSignToReadAgain([readPlate, halfReadPlate], "PM"),
    halfReadPlate,
    "between two plates that both answer, the half-read one is what the second call is for",
  );
  const shopAndPractice = judgeMany({
    customerName: "رضوان محمد",
    signs: [clearShop, partialPractice],
  });
  assert.equal(shopAndPractice.verdict, "unjudged", "and the frame's own unread board keeps it out of the flag list");

  // 11b · 🔴 ONE CHARACTER USED TO THROW THE WHOLE VERDICT AWAY. Postgres rejects the NUL and a lone
  //       surrogate, the recorder swallows the error by design, and the place then sits in the
  //       nightly backlog for ever — re-read every night, never recorded.
  const dirty = {
    signText: "مركز الدكتور\u0000 رضوان",
    signs: [{ personNames: ["\uD83D\uDE00 اسلام\uDFFF"], text: "Clinic\u00004\uD800" }],
    verdict: "match",
  };
  const safe = jsonbSafe(dirty);
  assert.equal(safe.signText, "مركز الدكتور رضوان", "the NUL goes and nothing else in the Arabic moves");
  assert.equal(safe.signs[0].text, "Clinic4", "including a NUL and a lone surrogate inside a sign's own text");
  assert.equal(safe.signs[0].personNames[0], "\uD83D\uDE00 اسلام", "a PAIRED surrogate is a character and survives; a lone one is not");
  assert.equal(safe.verdict, "match", "and the verdict itself is untouched");

  // 11 · Every sign stays on the record, so the queue can show what else was in the photograph.
  assert.equal(shop.signs.length, 2, "the board that was not read is kept as the evidence of why");
  assert.equal(shop.signText, "DOKANAT\nBANAT EL BALAD\nWOMEN'S & KIDS' STYLE", "and the sign that was read is quoted");
}

/**
 * How the two readers are asked, and what one place may cost the night.
 *
 * The door and the night are deliberately different callers of the same code: 8 s and the cheap
 * model with a rep standing in the street, 25 s and the strong model at 03:35 with a second look at
 * the sign on its own. Both numbers are load-bearing — see `checkSweepRate` for the pass's own
 * arithmetic, which the sweep budget feeds.
 */
function checkTwoReaders(): void {
  const server = readFileSync("src/lib/phoenix-crm/server/signboard-check.ts", "utf8");
  const stripped = stripComments(server);

  assert.ok(stripped.includes("PHOENIX_CRM_SIGNBOARD_TIMEOUT_MS = 8_000"), "a rep at the door waits eight seconds at most");
  assert.ok(
    stripped.includes("PHOENIX_CRM_SIGNBOARD_SWEEP_BUDGET_MS = 25_000"),
    "the night gets 25 s for the WHOLE place, every call it makes included",
  );
  assert.ok(
    stripped.includes("PHOENIX_CRM_SIGNBOARD_SWEEP_MODEL = OPENAI_STRONG_MODEL"),
    "the night reads with the strong model; three of the four false holds were a board the cheap one could not read",
  );
  assert.ok(
    stripped.includes("atTheDoor ? OPENAI_NANO_MODEL : PHOENIX_CRM_SIGNBOARD_SWEEP_MODEL"),
    "and the door still reads with the cheap one, inside the rep's own save",
  );

  // The prompt asks for EVERY sign, with the three fields the verdict turns on.
  for (const clause of [
    "LIST EVERY SIGNBOARD",
    "choose between them and do not merge them",
    "box as fractions of the image",
    "Set sign_present to false only when",
  ]) {
    assert.ok(server.includes(clause), `the prompt still says: ${clause}`);
  }
  assert.ok(/legibility: \{ enum: \["clear", "partial", "unreadable"\]/.test(server), "legibility is a field, never prose");
  assert.ok(/kind: \{ enum: \["medical", "other", "unknown"\]/.test(server), "so is the trade");
  assert.ok(
    !/customerName[^\n]*question|question[^\n]*customerName/.test(stripped),
    "the customer's name is NEVER in the prompt — a reader told what to expect finds it on a blank wall",
  );

  // The second look: taken only when the first found nobody, and then it decides.
  assert.ok(
    stripped.includes("if (atTheDoor || judged.verdict === \"match\") return judged;"),
    "one look at the door, and no second look once a sign has named him",
  );
  assert.ok(stripped.includes("cropToBox(cropped.jpeg, chosen.box)"), "the second look is the chosen sign, cropped out of the frame");
  assert.ok(
    stripped.includes("chooseSignToReadAgain(wide.signs, input.listType)"),
    "and it crops the sign that would ANSWER, not the one already read clearly",
  );
  assert.ok(
    /const evidence = \[\.\.\.close\.signs[\s\S]{0,400}signs: evidence,/.test(stripped),
    "the closer reading is judged WITH the rest of the frame — judging the crop alone re-held رضوان محمد",
  );
  assert.ok(stripped.includes("remaining() < 2_000"), "and it is not started with no budget left to read it in");

  // 14 · 🔴 THE VERDICT IS ACTUALLY KEPT. `recordPlaceSignboard` swallows its error by design, so
  //      nothing could see a lost write — and on 2026-10-09 the re-read pass printed "written to the
  //      place row" for all five places while اسلام عبدالعال still held its old verdict. It answers
  //      its caller now, and what it sends is a payload `jsonb` cannot refuse.
  assert.ok(
    /recordPlaceSignboard\([\s\S]{0,160}Promise<boolean>/.test(stripped),
    "the recorder says whether the row took the verdict — a void cannot be reported honestly",
  );
  assert.ok(
    stripped.includes("signboard_check: jsonbSafe(check)"),
    "and nothing it sends can be rejected for one unreadable character",
  );
  const pass = stripComments(readFileSync("scripts/phoenix-crm-reread-signboards.mjs", "utf8"));
  assert.ok(
    /const accepted = await recordPlaceSignboard\(place\.id, check\)/.test(pass) &&
      /\.select\("signboard_check"\)[\s\S]{0,120}\.eq\("id", place\.id\)/.test(pass),
    "the re-read pass keeps the recorder's answer AND reads the row back",
  );
  assert.ok(
    /const proven =\s*\n?\s*accepted &&[\s\S]{0,320}stored\?\.verdict === check\.verdict/.test(pass),
    "and `proven` needs both — the call accepted and the row holding that verdict",
  );
  assert.ok(
    /notWritten\.push\(/.test(pass) && /NOT WRITTEN/.test(pass) && /process\.exitCode = 1/.test(pass),
    "an unproven write is reported as a failure and carried in the exit code",
  );
}

/**
 * How fast the nightly pass is allowed to be, and what stops it.
 *
 * MEASURED ON PRODUCTION, 2026-10-09: the first night read its 60 places between 03:35:04 and
 * 03:35:45 Cairo — 42 seconds, from the `checkedAt` stamps the pass itself wrote — and stopped on
 * its LIMIT with 547 places still waiting. The owner raised the limit that day. What has to stay
 * true afterwards is not the number but the shape: the BUDGET is what ends a normal night, and the
 * whole pass still fits well inside the cron window with the behaviour pass left its room.
 *
 * Read out of the source rather than imported: this module reaches Supabase and the OpenAI client at
 * import time, and the rest of this file deliberately reads it as text for the same reason.
 */
function checkSweepRate(): void {
  const source = readFileSync("src/lib/phoenix-crm/server/signboard-sweep.ts", "utf8");
  const number = (name: string): number => {
    const found = source.match(new RegExp(`export const ${name} = ([0-9_]+)`));
    assert.ok(found, `${name} must still be an exported literal — this gate reads it out of the source`);
    return Number(found[1].replace(/_/g, ""));
  };
  const limit = number("SIGNBOARD_SWEEP_LIMIT");
  const budgetMs = number("SIGNBOARD_SWEEP_BUDGET_MS");
  const concurrency = number("SIGNBOARD_SWEEP_CONCURRENCY");
  // 🔴 THE PASS'S WORST CASE IS THE SWEEP BUDGET, NOT THE DOOR'S 8 s. The night reads a place with a
  // second, cropped look when the first does not find him, and that whole place is bounded by
  // PHOENIX_CRM_SIGNBOARD_SWEEP_BUDGET_MS — so this is the number that may be started one instant
  // before the deadline.
  const perReadTimeoutMs = Number(
    readFileSync("src/lib/phoenix-crm/server/signboard-check.ts", "utf8")
      .match(/PHOENIX_CRM_SIGNBOARD_SWEEP_BUDGET_MS = ([0-9_]+)/)?.[1]
      .replace(/_/g, "") ?? NaN,
  );

  /** 60 reads in 42 s, measured; four in flight. Places per second for the whole pass. */
  const MEASURED_READS_PER_SECOND = 60 / 42;

  assert.ok(
    limit >= 200,
    `the nightly limit is ${limit}: at the measured 1.4 places a second the pass used 42 s of its `
      + "120 s budget and then stopped on this number, leaving 547 places for nine more nights "
      + "(owner, 2026-10-09 — raise it)",
  );
  assert.ok(
    (limit / MEASURED_READS_PER_SECOND) * 1000 >= budgetMs,
    `the BUDGET must be what ends a normal night, not the limit: ${limit} places at the measured `
      + `rate is ${Math.round((limit / MEASURED_READS_PER_SECOND) * 1000)} ms against a ${budgetMs} ms budget. `
      + "Below that line the pass stops early with the window unused, which is the state this change undid.",
  );
  assert.ok(
    budgetMs + perReadTimeoutMs <= 150_000,
    `the pass may start a read right before the deadline, so its worst case is ${budgetMs + perReadTimeoutMs} ms; `
      + "the cron's maxDuration is 300 s and the photo and behaviour passes share it, so half is the ceiling",
  );
  assert.ok(limit <= 500, "the in-function clamp is 500 — a default above it would be silently cut");
  assert.ok(
    /Math\.min\(options\.limit \?\? SIGNBOARD_SWEEP_LIMIT, 500\)/.test(source),
    "that clamp must stay, so a caller's limit cannot run the pass past the cron window",
  );
  assert.equal(concurrency, 4, "reads in flight are unchanged — the raise buys nights, never parallel load");
}

export function runPhoenixCrmSignboardCheckTests(): void {
  checkStampBand();
  checkVerdicts();
  checkRecords();
  checkServerAndSweep();
  checkManySigns();
  checkTwoReaders();
  checkSweepRate();
  console.log("phoenix-crm signboard check: OK");
}
