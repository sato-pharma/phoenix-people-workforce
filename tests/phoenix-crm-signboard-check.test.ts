import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  chooseSignboard,
  chooseSignToReadAgain,
  jsonbSafe,
  judgeSignboard,
  SIGNBOARD_MAX_READ_ATTEMPTS,
  signboardNextAttempt,
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
  SIGNBOARD_DOOR_MAX_TRIES,
  SIGNBOARD_PHOTO_PROBLEMS,
  SIGNBOARD_RETAKE_CODE,
  parseSignboardPhotoProblem,
  signboardAsksForAPhoto,
  signboardBacklogCheckToKeep,
  signboardBacklogOutcome,
  signboardDoorAction,
  signboardRefusalKey,
  signboardRetakeAdvice,
  signboardRetakeIsAtThePlace,
  signboardRetakeWaiting,
  mergeSignboardParts,
  firstInListToAnswer,
  readerRanOutOfRoom,
  signboardPartsTimeoutMs,
  spelledOneWay,
  signboardRejudge,
  SIGNBOARD_PART_OVERLAP,
  signboardQuarters,
  type PhoenixCrmSign,
  type PhoenixCrmSignboardCheck,
} from "../src/lib/phoenix-crm/signboard-rules.ts";
import { PLACE_PHOTO_MAX_LONG_SIDE, placePhotoCanvasSize } from "../src/lib/phoenix-crm/place-photo-size.ts";
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

  // 🔴 A SIGNBOARD IS STORED AT UP TO 1920 ON THE LONG SIDE SINCE 2026-10-18 (place-photo-size.ts). Every
  // place photo was 720 x 1280 before — the outstation helper's cap — and a plate a few metres away came
  // out a few pixels per letter. The band scales with the width, so the guide clears it here too.
  assert.equal(PLACE_PHOTO_MAX_LONG_SIDE, 1920, "a signboard keeps up to 1920 on its long side");
  assert.deepEqual(placePhotoCanvasSize(2560, 1440), { height: 1080, width: 1920 }, "a 1440p frame is stored at 1920 x 1080");
  assert.deepEqual(placePhotoCanvasSize(1080, 1920), { height: 1920, width: 1080 }, "a portrait 1080p frame is kept whole");
  assert.deepEqual(placePhotoCanvasSize(1280, 720), { height: 720, width: 1280 }, "a smaller frame is never enlarged");
  assert.deepEqual(placePhotoCanvasSize(0, 0), { height: 1080, width: 1920 }, "a frame with no size yet falls back to 1920 x 1080");
  const bigPortrait = stampBandFraction(1080, 1920);
  const bigLandscape = stampBandFraction(1920, 1080);
  assert.equal(bigPortrait, SIGNBOARD_CROP_MIN_FRACTION, "1080 x 1920 clamps to the one-line floor");
  assert.equal(bigLandscape, 0.4889, "1920 x 1080 crops the eight-line worst case");
  assert.ok(1 - bigPortrait > bottom && 1 - bigLandscape > bottom, "at 1920 the crop never reaches the framed signboard either");
  const wired = stripComments(capture);
  assert.ok(
    wired.includes("frameGuide ? placePhotoCanvasSize(video.videoWidth, video.videoHeight) : getCompressedEvidenceCanvasSize(video)"),
    "only a framed signboard capture takes the larger size; every other photo keeps the shared evidence size",
  );
  assert.ok(wired.includes("frameGuide ? PLACE_PHOTO_CAMERA_IDEAL"), "and only it asks the camera for more");

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
  assert.ok(
    /maxRetries: 0,\s*\n\s*\.\.\.readerParams\(input\.reader\)/.test(server),
    "readSigns must pass maxRetries: 0 — the SDK retries a timeout with a fresh copy of the budget, so the 8-second door waited 16.4 s, five times in three days (production, 2026-10-12)",
  );
  const client = stripComments(readFileSync("src/lib/ai/openai-client.ts", "utf8"));
  assert.ok(
    client.includes("openAiClient(undefined, params.timeoutMs, params.maxRetries)"),
    "createOpenAiResponseText must hand a caller's maxRetries to the client, or the signboard's 0 is ignored",
  );
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

  // 11c · 🔴 THE RE-READ IS BOUNDED BY A VALUE A HUMAN CAN SEE IN THE ROW, not by a JSON-number filter.
  //       The third unreadable reading becomes `unreadable_final`, which no backlog query takes.
  const unread = signboardUnjudged("unreadable");
  assert.equal(signboardNextAttempt(unread, 0).attempts, 2, "a first re-read is the second attempt");
  assert.equal(signboardNextAttempt(unread, 0).reason, "unreadable", "and it is still worth trying again");
  assert.equal(
    signboardNextAttempt(unread, SIGNBOARD_MAX_READ_ATTEMPTS - 1).reason,
    "unreadable_final",
    "the last attempt makes the answer final, so the place leaves the backlog instead of circling in it",
  );
  assert.equal(
    signboardNextAttempt(signboardUnjudged("call_failed"), SIGNBOARD_MAX_READ_ATTEMPTS).reason,
    "call_failed",
    "a lost call is never made final by the counter — the frame was never read at all",
  );
  assert.equal(
    signboardNextAttempt(judgeMany({ customerName: "محمد فرج", signs: [sign({ personNames: ["محمد فرج"], text: "د/ محمد فرج" })] }), 5).verdict,
    "match",
    "and an answered place keeps its answer whatever the counter says",
  );
  assert.equal(signboardNextAttempt(unread, 0).attempts > unread.attempts, true, "the count only ever rises");

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
 * One name, two spellings: the space inside a compound, and the professor's title (12 Oct 2026).
 *
 * Every reading below is a stored production reading. ابراهيم عبدالشافى was filed on the owner's
 * integrity board at 03:37 Cairo on 11 Oct, two readings agreeing, off a plate read clearly as
 * "إبراهيم عبد الشافى" — the same person, held as another for one space. Replaying all 389 stored
 * readings through the fix moved six, and none of them onto the board: five to a match, and one false
 * match (ابو الدهب on an ابو الوفا plate) to `unjudged`.
 */
function checkNameSpelling(): void {
  const pm = (customerName: string, personNames: string[]) =>
    signNamesCustomer({ customerName, listType: "PM", personNames, placeNames: [], signText: null }).matches;

  // 1 · 🔴 THE HOLD THAT STARTED IT, as the night read the frame: one clear plate, three partial ones.
  const shafi = judgeSignboards({
    croppedFraction: 0.18,
    customerName: "ابراهيم عبدالشافى",
    listType: "PM",
    note: null,
    signPresent: true,
    signs: [
      {
        box: null,
        kind: "medical",
        legibility: "clear",
        personNames: ["إبراهيم عبد الشافى"],
        placeNames: [],
        text: "الأستاذ الدكتور\nإبراهيم عبد الشافى\nأستاذ واستشارى\nالأنف والأذن والحنجرة\nوجراحة الرأس والرقبه\nبكلية الطب",
      },
      { box: null, kind: "medical", legibility: "partial", personNames: ["إبراهيم الأعمر"], placeNames: [], text: null },
      { box: null, kind: "medical", legibility: "partial", personNames: ["إبراهيم الأحمر"], placeNames: [], text: null },
    ],
  });
  assert.equal(shafi.verdict, "match", "عبد الشافى on the plate is عبدالشافى on the list — one space is not another person");
  assert.equal(signboardHoldsForReview(shafi), false);
  assert.equal(pm("عبدالعزيز القاضي", ["عبد العزيز القاضي محمد"]), true, "and the other way round, list split, plate joined");
  assert.equal(pm("اسامة عبد الله", ["أسامة عبدالله"]), true);
  assert.equal(pm("محمد نور الدين", ["د. محمد نورالدين"]), true, "a tail joins the word before it");
  assert.equal(pm("احمد ابو عبد الله", ["احمد ابوعبدالله"]), true, "a head swallowed by an open compound keeps it open");

  // 2 · 🔴 THE SAME SPACE MADE FALSE MATCHES. عبد and ابو counted as words of the name and spent the
  //      allowance a three-word name gets, so the head and the first name were enough.
  assert.equal(pm("د.هشام ابو الدهب", ["د/ هشام أحمد أبو الوفا"]), false, "ابو الدهب is not ابو الوفا");
  assert.equal(pm("عبد الله محمد", ["محمد عبد الرحمن"]), false, "عبد الله is not عبد الرحمن");
  assert.equal(pm("عبد الله محمد", ["عبد الله حسن"]), false, "a compound first name is still only a first name");

  // 3 · 🔴 A READER THAT DROPS THE HEAD HAS STILL READ THE NAME. Joining strictly turned the first of
  //      these from a match into a FLAG, filed by the other doctors' plates in the same frame.
  assert.equal(pm("عبد الله عفيفي", ["الله عفيفي"]), true, "the reader dropped عبد");
  assert.equal(pm("النعماني ابو نار", ["النعماني نار"]), true, "the reader dropped ابو");
  assert.equal(pm("اسامه العيلة", ["اسامة ابراهيم ابو العيلة"]), true, "the list dropped ابو");
  assert.equal(pm("محمد عبد الله", ["محمد جاد الله"]), false, "but only ALONE: the الله inside جاد الله is not عبد الله");

  // 4 · The title. The shared fold already strips د, دكتور and الدكتور; الأستاذ is the one it keeps,
  //     and on a list row it would spend the allowance and match any professor with the first name.
  assert.equal(pm("الأستاذ الدكتور محمد علي", ["الأستاذ الدكتور محمد حسن"]), false, "الأستاذ is not a word of the name");
  assert.equal(pm("أ.د. محمد علي", ["الأستاذ الدكتور محمد علي"]), true);
  assert.equal(pm("محمد علي", ["الاستاذة الدكتورة محمد علي"]), true);

  // 6 · 🔴 A FAMILY NAME WITH AND WITHOUT ITS ال IS ONE NAME. Three clear plates the re-read of 18 Oct
  //      2026 found unmatched, as the strong reader returned them.
  assert.equal(pm("ايمن بدوي", ["مركز الدكتور أيمن البدوى"]), true, "البدوى on the plate is بدوي on the list");
  assert.equal(pm("عبير الراوي", ["دكتورة عبير محمد راوي"]), true, "and the other way round");
  assert.equal(pm("إبراهيم عفيفي", ["دكتور إبراهيم عبد الله العفيفي"]), true, "a three-word plate keeps the allowance it had");
  //      Only the ال: a letter the reader got wrong is another name, and الله never sheds it.
  assert.equal(pm("محمد ابو العنيين", ["مجدي أبو العينين"]), false, "مجدي is not محمد, and العينين is not العنيين");
  assert.equal(pm("احمد البدري", ["أحمد البدوي"]), false, "البدري is not البدوي");
  assert.equal(pm("حمدي نوفل", ["مجدي أمين نوفل"]), false, "a surname alone is not the name");
  assert.equal(pm("علي الحج", ["علي حج"]), false, "a word left with two letters is not a name");

  // 7 · 🔴 THE ALLOWANCE IS NEVER HIS GIVEN NAME LOST BEHIND ANOTHER MAN'S. Three shapes the decoy check
  //      of 18 Oct 2026 found among the strong reader's confirmations.
  const onSign = (customerName: string, personNames: string[], signText: string) =>
    signNamesCustomer({ customerName, listType: "PM", personNames, placeNames: [], signText }).matches;
  assert.equal(pm("وائل محمد بلحة", ["احمد محمد بلحة"]), false, "his father's and family name behind another given name");
  assert.equal(pm("محمد الشحري", ["أحمد محمد الشحرى"]), false, "his given name standing as somebody else's father");
  assert.equal(
    onSign("وائل محمد بلحة", [], "دكتور احمد محمد بلحة استشاري الباطنة"),
    false,
    "and the same in the sign's whole text: the run must open on his given name",
  );
  assert.equal(
    onSign(
      "مجدى عبد العزيز",
      ["الدكتور مجدى", "الدكتور / محمود عبدالعزيز"],
      "يرجى من السادة المرضى مراجعة الادوية مع الدكتور مجدى بعد صرف الروشتة من الصيدلية لعدم اعطاء بديل إدارة الدكتور / محمود عبدالعزيز",
    ),
    false,
    "his words gathered from two names on one notice",
  );
  //      What stays a match: a given name the plate's damage took, the practice's kind in front, and a
  //      reader that split the name badly while the text still reads it whole.
  assert.equal(pm("محمود عبدالنبي الخولي", ["عبد النبي الخولي"]), true, "د / ... عبد النبي الخولي");
  assert.equal(pm("ايمن بدوي", ["مركز أيمن البدوى"]), true, "مركز is never a given name");
  assert.equal(pm("محمد علي", ["أ.د/ محمد علي"]), true, "nor the letter أ.د leaves behind");
  assert.equal(onSign("بسمة احمد", ["أحمد حمدى زكى"], "د/بسمة أحمد حمدى زكى إستشارى طب الأطفال"), true, "the text reads it whole");
  assert.equal(onSign("عادل البكري", [], "دكتور عادل البكاري البكري استشاري اطفال"), true, "one stray word between two of his");
  assert.equal(pm("مي احمد", ["مي احمد"]), true, "a two-letter given name is still read");
  assert.equal(pm("وائل احمد", ["مي احمد"]), false, "and is still another given name");
  //      🔴 And the other direction (code review, 19 Oct 2026): the quorum's floor never asks for "مي", so
  //      a name read off the sign that opened on her father's name matched any احمد's plate.
  assert.equal(pm("مي احمد", ["احمد سامي"]), false, "her father's name alone, as another man's given name");
  assert.equal(onSign("مي احمد", ["احمد سامي"], "د/ احمد سامي استشاري الباطنة"), false, "nor on the sign's whole text");
  assert.equal(pm("مي احمد علي", ["احمد علي حسن"]), false, "nor her father's and grandfather's names behind no given name");
  assert.equal(pm("مي احمد", ["د/ مي احمد"]), true, "her own plate still reads her");

  // 5 · A facility name is untouched: its quorum is the stemmed distinctive words, as before.
  assert.equal(
    signNamesCustomer({ customerName: "مستشفى ابو كبير المركزي", listType: "AM", personNames: [], placeNames: ["مستشفى أبو كبير"], signText: null }).matches,
    true,
    "a three-word hospital name still survives losing one",
  );
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
  // 🔴 Claude reads the signboard first since 2026-10-18: replayed on 21 production photos stored 19
  // "unreadable", Claude Sonnet confirmed 14 where the stored OpenAI readings had confirmed 1. OpenAI is
  // asked only when Claude's account is dead, with the models it read with before.
  assert.match(
    stripped,
    /PHOENIX_CRM_SIGNBOARD_STRONG_READER: SignboardReader = \{\s*anthropicModel: "claude-sonnet-5-5",\s*model: OPENAI_STRONG_MODEL,\s*\}/,
    "the night and the held re-read read with Claude Sonnet, the strong OpenAI model behind it",
  );
  assert.ok(
    stripped.includes("PHOENIX_CRM_SIGNBOARD_SWEEP_READER = PHOENIX_CRM_SIGNBOARD_STRONG_READER"),
    "the night reads with the strong reader; three of the four false holds were a board the cheap one could not read",
  );
  assert.match(
    stripped,
    /PHOENIX_CRM_SIGNBOARD_DOOR_READER: SignboardReader = \{\s*anthropicModel: "claude-(?:sonnet|haiku)-5-5",\s*model: "gpt-5\.4-mini",\s*\}/,
    "the door reads with Claude, the middle OpenAI tier behind it — never nano again without a replay",
  );
  assert.match(
    stripped,
    /DOOR_READERS = \[\s*PHOENIX_CRM_SIGNBOARD_DOOR_READER,\s*\{ anthropicModel: CLAUDE_FAST_MODEL, model: OPENAI_NANO_MODEL \},\s*\]/,
    "and falls back to the fast one only when the call is lost",
  );
  // 🔴 The door asks the two side by side (`checkSideBySideDoor`); the night and the held re-read in turn.
  assert.ok(stripped.includes("sideBySide: atTheDoor,"), "the door's first look asks both readers at once");
  assert.ok(
    /input\.sideBySide\s*\?\s*await hedgedAnswer\(input\.readers, input\.remaining, input\.callCapMs, readWhole\)\s*:\s*await firstAnswer\(/.test(stripped),
    "every other first look still asks in turn",
  );
  assert.ok(
    stripped.includes("firstInListToAnswer(readers, (reader, signal) => ask(reader, left, signal), left - DOOR_SETTLE_MARGIN_MS)"),
    "each reader gets the whole time left, and an answer in hand is taken just before the deadline",
  );
  assert.ok(
    stripped.includes("signal: input.signal,") && stripped.includes("if (input.signal?.aborted || !input.partsTimeoutMs"),
    "a stopped read reaches the model call, and is never read again in parts",
  );
  assert.ok(
    stripped.includes("atTheDoor ? DOOR_READERS : [PHOENIX_CRM_SIGNBOARD_SWEEP_READER]"),
    "while the night keeps its one strong reader",
  );
  assert.ok(
    stripped.includes('preferProvider: "anthropic" as const'),
    "every signboard call asks Claude first",
  );
  assert.ok(!/\bmodel: input\.model\b/.test(stripped), "no call names a bare model any more; each names a reader");

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
    "the customer's name is NEVER in a blind reader's prompt — a reader told what to expect finds it on a blank wall",
  );
  // 🔴 The ONE reader told the name is the held re-read's guided look (owner, 2026-10-17: "look at what
  // the rep typed"), and its answer is believed only when a BLIND close look at the spot it named reads
  // the name itself: on 40 production photos it wrote a near-miss decoy it was handed 8 times.
  const readSignsBody = stripped.slice(stripped.indexOf("async function readSigns("), stripped.indexOf("const WIDE_QUESTION"));
  assert.ok(readSignsBody.length > 0 && !/customerName|nameGiven/.test(readSignsBody), "the blind reader takes no name at all");
  assert.equal(stripped.split("readGuided(").length - 1, 2, "the guided read is declared once and called once");
  const spotCheckBody = stripped.slice(stripped.indexOf("async function spotCheck("));
  assert.ok(spotCheckBody.includes("readGuided("), "and it is called only from spotCheck");
  assert.ok(
    spotCheckBody.includes("if (!close || !signboardReadsCustomerName(close.signs, subject)) return null;"),
    "whose answer stands only when the blind close look reads the NAME — not merely a step-4 match",
  );
  const judgeBytesBody = stripped.slice(stripped.indexOf("async function judgeBytes("), stripped.indexOf("async function blindRead("));
  assert.ok(judgeBytesBody.length > 0 && !/spotCheck|readGuided/.test(judgeBytesBody), "the door and the night never take the guided read");

  // The second look: taken only when the first found nobody, and then it decides.
  assert.ok(
    stripped.includes("if (!input.secondLook || judged.verdict === \"match\") return judged;") &&
      stripped.includes("secondLook: atTheDoor ? false : input.secondLook ?? true,"),
    "one look at the door, and no second look once a sign has named him — the one-off read of the old places asks for none either",
  );
  assert.ok(stripped.includes("cropToBox(image, chosen.box)"), "the second look is the chosen sign, cropped out of the frame");
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

  // 15 · 🔴 THE NIGHT'S YIELD. Measured on the first night, 2026-10-09: 60 places read, **4** answers.
  //      42 ended `unreadable`, which was terminal, and 14 lost their model call and waited a day to
  //      be tried again. All three rules below exist to turn that 6.7% into answers, and each one is
  //      a thing the pass must still DO, not a number.
  const sweep = stripComments(readFileSync("src/lib/phoenix-crm/server/signboard-sweep.ts", "utf8"));

  // 1 · a lost call is retried inside the same night, and only a lost call.
  assert.ok(
    /first\.verdict !== "unjudged" \|\| first\.reason !== "call_failed"\) return first;[\s\S]{0,120}return readStoredPlaceSignboard\(input\)/.test(
      sweep,
    ),
    "a lost model call is retried immediately — 23% of the first night was spent on calls that answered nothing",
  );

  // 2 · an unreadable frame comes back, bounded, and the structural cases never do.
  assert.ok(
    /SIGNBOARD_REREAD_REASONS = \[[\s\S]{0,200}"unreadable",[\s\S]{0,80}"unconfirmed",/.test(sweep),
    "an unreadable frame and an unconfirmed verdict are both read again — legibility is not a property of the photograph",
  );
  assert.ok(
    !/SIGNBOARD_REREAD_REASONS = \[[\s\S]{0,260}"unreadable_final"/.test(sweep),
    "but the exhausted reason is NOT in that list, or the re-read never stops",
  );
  assert.ok(
    /signboardApplies\(place\.listType\)\) return signboardUnjudged\("name_unusable"\)/.test(sweep) &&
      /signboardNameIsUsable\(place\.customerName\)\) return signboardUnjudged\("name_unusable"\)/.test(sweep),
    "a pharmacy and a name that folds away are `name_unusable`, never `unreadable` — nothing about them changes tomorrow",
  );

  // 3 · nothing reaches the owner's board on one reading.
  assert.ok(
    /if \(first\.verdict !== "other_name" && first\.verdict !== "no_name"\) return first;/.test(sweep),
    "a match and an unjudged cost no second call — nobody is named by either",
  );
  assert.ok(
    /second\.verdict === first\.verdict\) return second;[\s\S]{0,140}reason: "unconfirmed", verdict: "unjudged"/.test(sweep),
    "a flaggable verdict is filed only when a second reading of the frame agrees; otherwise it is unconfirmed and read again",
  );
  assert.ok(
    /const check = signboardNextAttempt\(await confirmBeforeFlagging\(place, first\), place\.priorAttempts\)/.test(sweep),
    "and the confirmation runs BEFORE the verdict is recorded or counted, not after the flag is filed",
  );
  assert.ok(
    /select\(\s*"[^"]*signboard_check[^"]*"/.test(sweep) && /priorAttempts:/.test(sweep),
    "the backlog reads the stored check, because the attempt count cannot be known without it",
  );

  // 16 · 🔴 `unjudged` NOW MEANS FOUR DIFFERENT THINGS, AND THE PAGE MAY NOT SAY ONE SENTENCE FOR ALL
  //      FOUR. "Could not be read" fits a frame waiting for another attempt; it is misleading for a
  //      verdict two readings disagreed about, it hides that a place has had every attempt it gets,
  //      and it says nothing about a place there was never anything to compare. Both boards show the
  //      Super Admin the same four answers, in words — he never reads a reason code (owner's standing
  //      rule: names, never codes).
  for (const file of [
    "src/components/phoenix-crm/validated-place-list.tsx",
    "src/components/phoenix-crm/shared-place-list.tsx",
  ] as const) {
    const board = readFileSync(file, "utf8");
    const map = board.match(/SIGNBOARD_UNJUDGED_TEXT: Record<string, string> = \{([\s\S]*?)\};/);
    assert.ok(map, `${file} must tell the four unjudged answers apart`);
    for (const reason of ["name_unusable", "unconfirmed", "unreadable", "unreadable_final"]) {
      assert.ok(map[1].includes(`${reason}:`), `${file} must say in words what ${reason} means`);
    }
    const sentences = [...map[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1]);
    assert.equal(new Set(sentences).size, 4, `${file} must give each of the four its OWN sentence`);
    for (const sentence of sentences) {
      assert.ok(!/_/.test(sentence), `${file} must never show a reason code: ${sentence}`);
      assert.ok(!sentence.includes("…") && !sentence.includes("..."), `${file} must not truncate: ${sentence}`);
    }
    assert.ok(
      board.includes("function signboardText(signboard: NonNullable<") &&
        board.includes("{signboardText(row.signboard)}"),
      `${file} must RENDER through that map, not straight off the verdict`,
    );
    assert.ok(
      /SIGNBOARD_UNJUDGED_TEXT\[signboard\.reason \?\? ""\] \?\? SIGNBOARD_TEXT\.unjudged/.test(board),
      `${file} must fall back to the verdict's sentence, so a reason added later cannot render as a code`,
    );
  }
  assert.ok(
    /signboard: \{[\s\S]{0,200}reason: string \| null;/.test(
      readFileSync("src/lib/phoenix-crm/server/validation-reviews.ts", "utf8"),
    ),
    "and the row must carry the reason at all — the board cannot tell the four apart without it",
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
      + `${budgetMs / 1000} s budget and then stopped on this number, leaving 547 places for nine more nights `
      + "(owner, 2026-10-09 — raise it)",
  );
  assert.ok(
    (limit / MEASURED_READS_PER_SECOND) * 1000 >= budgetMs,
    `the BUDGET must be what ends a normal night, not the limit: ${limit} places at the measured `
      + `rate is ${Math.round((limit / MEASURED_READS_PER_SECOND) * 1000)} ms against a ${budgetMs} ms budget. `
      + "Below that line the pass stops early with the window unused, which is the state this change undid.",
  );
  // 🔴 TWO FULL PER-PLACE READS, NOT ONE — the factor this gate multiplies by changed on 2026-10-09
  // and the gate had to change with it. A place started one instant before the deadline is finished,
  // and finishing it can now mean reading the whole place a SECOND time: a lost model call is retried
  // immediately, and a verdict that would put a name on the owner's board is confirmed before it is
  // filed. The two are mutually exclusive — a lost call is `unjudged`, and only `other_name`/
  // `no_name` is ever confirmed — so the factor is 2, not 3. Leaving it at 1 would have measured a
  // worst case 25 s shorter than the real one and passed.
  const worstPlaceMs = 2 * perReadTimeoutMs;
  assert.ok(
    budgetMs + worstPlaceMs <= 150_000,
    `the pass may start a place right before the deadline and that place may cost two full reads, so its `
      + `worst case is ${budgetMs + worstPlaceMs} ms; the cron's maxDuration is 300 s and the photo and `
      + "behaviour passes share it, so half is the ceiling",
  );
  assert.ok(
    /const second = await readOne\(place\)/.test(source) && /2 × PHOENIX_CRM_SIGNBOARD_SWEEP_BUDGET_MS/.test(source),
    "and the source must still be the shape this arithmetic assumes — one place, at most two reads",
  );
  assert.ok(limit <= 500, "the in-function clamp is 500 — a default above it would be silently cut");
  assert.ok(
    /Math\.min\(options\.limit \?\? SIGNBOARD_SWEEP_LIMIT, 500\)/.test(source),
    "that clamp must stay, so a caller's limit cannot run the pass past the cron window",
  );
  assert.equal(concurrency, 4, "reads in flight are unchanged — the raise buys nights, never parallel load");
}

/**
 * A SEATED PLACE IS NEVER IN THE SIGNBOARD BACKLOG — its photo is the building's TIMETABLE.
 *
 * 🔴 THE SWEEP SWEPT THEM UNTIL 2026-10-12. Under the owner's 2026-10-10 amendment ("ask him for only
 * one timetable, not for every doctor"), a customer seated in a shared venue carries `shared_place_id`
 * and a photo of the entrance timetable — the board of clinic hours and doctors' names — captured once
 * for the venue. Its check is `schedule_check`. The backlog applied no `shared_place_id` filter, so the
 * pass was asking a timetable "does the sign name this customer?", a question the photo was never taken
 * to answer, and a confident negative FILES A CASE about a named rep.
 *
 * Measured on production the same day: 8 seated places, every one of them in the backlog and NONE yet
 * read — the pass takes 200 a night oldest-first against a 552-place backlog, so the fix landed with
 * roughly three nights to spare. The door never had the defect: `validateCustomer` and `addPlace` both
 * call the signboard read inside an `else if (place)`, with the seated branch reading the timetable
 * instead, and `validation-reviews.ts` tells the two apart the same way.
 */
function checkSeatedRowsAreNotSwept(): void {
  const sweep = stripComments(readFileSync("src/lib/phoenix-crm/server/signboard-sweep.ts", "utf8"));
  assert.ok(
    /\.is\("shared_place_id", null\)/.test(sweep),
    "the signboard backlog must exclude seated rows — their photo is the venue's timetable, not a signboard",
  );
  // At the DATABASE, not in `toPlace`: a seated row filtered in memory would still be counted against
  // the night's limit, so the pass would read fewer real places for no reason.
  assert.ok(
    /\.from\("phoenix_crm_places"\)[\s\S]{0,600}?\.is\("shared_place_id", null\)[\s\S]{0,400}?\.limit\(limit\)/.test(sweep),
    "it must be excluded in the query, before the limit, or a seated row still spends a read",
  );
  // The two kinds of photo stay told apart by the same column everywhere that judges one.
  assert.ok(
    /photoKind: text\(row\.shared_place_id\) \? "schedule" : "signboard"/.test(
      stripComments(readFileSync("src/lib/phoenix-crm/server/validation-reviews.ts", "utf8")),
    ),
    "the review board must keep telling a timetable from a signboard by `shared_place_id`",
  );
}

/**
 * THE SIGNBOARD SCANNER AT THE DOOR (owner, 2026-10-18: "fix all the unreadable", and the timetable's
 * rule of 2026-10-17 carried to the signboard). Every one of the 532 places filed "Not readable" had been
 * ACCEPTED at the door and found unreadable later, when the rep had left. A photo with no readable name is
 * refused on the spot with what to fix, twice; the third is saved and held. Another name and a lost call
 * are never refused.
 */
function checkDoorScanner(): void {
  const unreadable = (over: Partial<PhoenixCrmSignboardCheck> = {}): PhoenixCrmSignboardCheck => ({
    ...signboardUnjudged("unreadable"),
    ...over,
  });
  const named = judge({ personNames: ["د. احمد سمير"], signText: "د. احمد سمير" });
  const otherName = judge({ personNames: ["د. محمود حسن"], signText: "د. محمود حسن" });
  const noPlate = judge({ placeNames: ["مركز الشفاء الطبي"] });
  assert.equal(named.verdict, "match");
  assert.equal(noPlate.verdict, "no_name");

  assert.equal(SIGNBOARD_DOOR_MAX_TRIES, 3, "three photos, the timetable's number");
  assert.deepEqual(signboardDoorAction(named, 0, "PM"), { kind: "save" }, "a photo that names him saves at once");
  const first = signboardDoorAction(unreadable({ problem: "too_far" }), 0, "PM");
  assert.ok(first.kind === "retake", "a photo with no readable name is refused at the door");
  assert.equal(first.reason, "signboard_unreadable");
  assert.equal(first.nextTry, 2);
  assert.ok(first.message.includes("Step closer") && first.message.endsWith("Try 2 of 3."), `the rep reads what to fix and which try: ${first.message}`);
  const second = signboardDoorAction(unreadable(), 1, "PM");
  assert.ok(second.kind === "retake" && second.nextTry === 3, "refused again on the second photo");
  assert.deepEqual(signboardDoorAction(unreadable(), 2, "PM"), { kind: "hold", tries: 3 }, "🔴 the third photo is saved and held — never a fourth refusal");
  assert.deepEqual(signboardDoorAction(unreadable(), 9, "PM"), { kind: "hold", tries: 10 }, "and never refused past it");
  const plate = signboardDoorAction(noPlate, 0, "PM");
  assert.ok(plate.kind === "retake" && plate.reason === "signboard_no_plate", "no nameplate at a PM door is refused too, counted as its own reason");
  assert.deepEqual(signboardDoorAction(otherName, 0, "PM"), { kind: "hold", tries: 1 }, "🔴 a clear plate naming somebody else is evidence — held, never refused");
  for (const reason of ["call_failed", "no_api_key", "no_bytes"] as const) {
    assert.equal(signboardDoorAction(signboardUnjudged(reason), 0, "PM").kind, "hold", `${reason}: saved and held — a reader that did not answer never turns a rep away`);
    assert.equal(signboardAsksForAPhoto(signboardUnjudged(reason), "PM"), false, `${reason} never asks for a photo`);
  }
  for (const reason of ["name_unusable", "held_elsewhere"] as const) {
    assert.deepEqual(signboardDoorAction(signboardUnjudged(reason), 0, "PM"), { kind: "save" }, `${reason} saves exactly as before the scanner`);
  }

  // 🔴 A PHOTO THE READER CALLS LEGIBLE IS NEVER SENT BACK (2026-10-18, the dry run opened by eye): a
  // clear plate reading "د. محمد زكي" for محمد ذكي read the same on any new photo. Held for the Super
  // Admin instead. And on an AM capture the building's sign IS the photo, so it is not a fault there.
  const legible = unreadable({ problem: "none", signText: "د. محمد زكي" });
  assert.equal(signboardAsksForAPhoto(legible, "PM"), false, "🔴 a legible plate whose name did not confirm never asks for another photo");
  assert.deepEqual(signboardDoorAction(legible, 0, "PM"), { kind: "hold", tries: 1 }, "it is saved and held for the Super Admin");
  const hospital = unreadable({ problem: "building_sign_only" });
  assert.equal(signboardAsksForAPhoto(hospital, "AM"), false, "🔴 an AM building's sign is the AM photo — not a fault");
  assert.equal(signboardAsksForAPhoto(hospital, "PM"), true, "at a PM door the building's sign is not the clinic's plate");
  assert.equal(signboardAsksForAPhoto(unreadable({ problem: "too_far" }), "AM"), true, "a plate too far to read is a bad photo on either list");
  assert.equal(signboardAsksForAPhoto(unreadable(), "AM"), true, "a reading with no word on the problem still asks, as before");
  assert.equal(signboardAsksForAPhoto(unreadable({ problem: "none", reason: "unreadable_final" }), "PM"), false);
  assert.equal(
    signboardAsksForAPhoto(unreadable({ problem: "stylised", signText: "دكتور سلامة السيد البيودي" }), "PM"),
    false,
    "🔴 a decorative plate reads the same on any new photo — held for the Super Admin, never the rep's to retake",
  );
  assert.equal(signboardAsksForAPhoto(unreadable({ problem: "cut_off" }), "PM"), true, "a plate running out of the frame is fixed by a whole-plate photo");

  // The words: one per cause, never a code, never truncated, never the word the AM/PM test refuses.
  const advice = SIGNBOARD_PHOTO_PROBLEMS.filter((problem) => problem !== "none").map((problem) =>
    signboardRetakeAdvice({ problem, signs: [], verdict: "unjudged" }),
  );
  assert.ok(new Set(advice).size === advice.length, "each cause has its own sentence");
  for (const sentence of [...advice, signboardRetakeAdvice({ problem: null, signs: [], verdict: "unjudged" })]) {
    assert.ok(!/_/.test(sentence) && !sentence.includes("…") && !/doctor|account/i.test(sentence), `a sentence a rep can read: ${sentence}`);
  }
  assert.ok(
    signboardRetakeAdvice({ problem: "building_sign_only", signs: [], verdict: "unjudged" }).includes("building's sign"),
    "a hospital front is told it shows the building, not the customer's plate",
  );
  assert.equal(parseSignboardPhotoProblem("Too_Far"), "too_far");
  assert.equal(parseSignboardPhotoProblem("smudged"), null, "an answer outside the list is no answer");

  // Tries are counted per rep, per customer: the place, else the customer, else the new name.
  assert.equal(signboardRefusalKey({ customerId: "C-1", customerName: "x", placeId: "P-1" }), "place:p-1");
  assert.equal(signboardRefusalKey({ customerId: "C-1", customerName: "x" }), "customer:c-1");
  assert.ok(signboardRefusalKey({ customerId: null, customerName: "احمد سمير" })?.startsWith("name:"));
  assert.equal(signboardRefusalKey({ customerId: null, customerName: " " }), null);

  // Wired at both doors — a new place and a retake — with the refusal recorded BEFORE it is thrown.
  const list = stripComments(readFileSync("src/lib/phoenix-crm/server/list.ts", "utf8"));
  assert.equal((list.match(/signboardDoorAction\(check, earlierTries, (?:subject\.)?listType\)/g) ?? []).length, 2, "the new-place door and the retake both ask the scanner, with the list");
  assert.equal(list.split("throw validationError(action.message, SIGNBOARD_RETAKE_CODE)").length - 1, 2, "both refuse with the one code");
  assert.equal(
    (list.match(/await signboardRefusalRecorded\(key, action\.reason, [^\n]*\)\)\)?\s*(?:;\s*if \(refused\)|\{)\s*throw validationError\(action\.message, SIGNBOARD_RETAKE_CODE\)/g) ?? []).length,
    2,
    "🔴 each refuses only once the refusal is RECORDED — so the next photo is the next try, and an unrecorded one is never 'try 2 of 3' for ever",
  );
  assert.ok(/const id = await recordSignboardRefusal\([\s\S]{0,300}return id !== null;/.test(list), "recorded means the row landed");
  assert.ok(list.includes('holds: action.kind !== "save"'), "a refusal that could not be recorded saves and holds instead");
  assert.ok(
    /: key\s*\? await countSignboardRefusals\([^)]*\)\s*: SIGNBOARD_DOOR_MAX_TRIES;/.test(list),
    "a photo with nothing to count tries against holds at once — never refused for ever",
  );
  assert.ok(SIGNBOARD_RETAKE_CODE.startsWith("phoenix_crm_photo_"), "the code the screens already return to the photo on");
  assert.ok(
    readFileSync("src/components/phoenix-crm/list-screens.tsx", "utf8").includes('code?.startsWith("phoenix_crm_photo_")'),
    "and the validate screen still does",
  );
  const migration = readFileSync("supabase/migrations/20261018230000_phoenix_crm_signboard_scanner.sql", "utf8");
  for (const reason of ["signboard_unreadable", "signboard_no_plate"]) {
    assert.ok(migration.includes(`'${reason}'`), `the refusals table accepts ${reason}`);
  }
}

/**
 * THE STRONG READER'S "UNREADABLE" IS FINAL, AND THE OLD PLACES ARE READ ONCE (owner, 2026-10-18:
 * "a total wasting of money"). The night read the same unchanged photo up to three nights at two to four
 * calls a night; the one-off pass reads each old photo once and ends it confirmed, filed, or sent back.
 */
function checkOneReadPerPhoto(): void {
  const unreadable = (over: Partial<PhoenixCrmSignboardCheck> = {}): PhoenixCrmSignboardCheck => ({
    ...signboardUnjudged("unreadable"),
    ...over,
  });
  assert.equal(signboardNextAttempt(unreadable({ strongRead: true }), 1).reason, "unreadable_final", "🔴 the strong reader's unreadable is final at once");
  assert.equal(signboardNextAttempt(unreadable(), 1).reason, "unreadable", "a fallback's answer keeps a try");
  assert.equal(signboardNextAttempt(unreadable({ reason: "call_failed", strongRead: true }), 1).reason, "call_failed", "a lost call is never final");
  assert.equal(signboardNextAttempt(judge({ personNames: ["د. احمد سمير"] }), 1).reason, null, "a match keeps no reason");

  const named = judge({ personNames: ["د. احمد سمير"], signText: "د. احمد سمير" });
  assert.equal(signboardBacklogOutcome(named, "PM"), "confirm");
  assert.equal(signboardBacklogOutcome(judge({ personNames: ["د. محمود حسن"] }), "PM"), "flag");
  assert.equal(signboardBacklogOutcome(judge({ placeNames: ["مركز الشفاء الطبي"] }), "PM"), "retake", "no nameplate: sent back");
  for (const reason of ["unreadable", "unreadable_final", "no_bytes"] as const) {
    assert.equal(signboardBacklogOutcome(signboardUnjudged(reason), "PM"), "retake", `${reason}: only a new photo can be read`);
  }
  for (const reason of ["call_failed", "no_api_key"] as const) {
    assert.equal(signboardBacklogOutcome(signboardUnjudged(reason), "PM"), "lost", `${reason}: nothing written, the old record stays`);
  }
  assert.equal(signboardBacklogOutcome(signboardUnjudged("name_unusable"), "PM"), "keep");
  // 🔴 A legible sign is kept for the Super Admin, never sent back — and kept FINAL, never re-read.
  assert.equal(signboardBacklogOutcome(unreadable({ problem: "none" }), "PM"), "keep", "🔴 a legible plate that did not confirm is not the rep's to retake");
  assert.equal(signboardBacklogOutcome(unreadable({ problem: "building_sign_only" }), "AM"), "keep", "🔴 an AM building's sign is kept, not sent back");
  assert.equal(signboardBacklogOutcome(unreadable({ problem: "blurred" }), "AM"), "retake");
  assert.equal(signboardBacklogOutcome(unreadable({ problem: "stylised" }), "PM"), "keep", "a decorative plate is kept for the Super Admin");
  const keptLegible = signboardBacklogCheckToKeep(unreadable({ problem: "none" }), 1, "keep", new Date("2026-10-18T19:00:00.000Z"));
  assert.equal(keptLegible.reason, "unreadable_final", "🔴 kept final, so no night pass reads the same legible photo again");
  assert.equal(keptLegible.retake, null, "and the rep is asked for nothing");

  const now = new Date("2026-10-18T19:00:00.000Z");
  const sentBack = signboardBacklogCheckToKeep(unreadable({ problem: "building_sign_only" }), 1, "retake", now);
  assert.equal(sentBack.reason, "unreadable_final", "🔴 written final, so the deployed night pass never reads it again");
  assert.equal(sentBack.attempts, 2, "and the count is carried, never reset");
  assert.deepEqual(sentBack.retake, {
    advice: signboardRetakeAdvice({ problem: "building_sign_only", signs: [], verdict: "unjudged" }),
    problem: "building_sign_only",
    requestedAt: now.toISOString(),
  });
  assert.deepEqual(signboardRetakeWaiting(sentBack), sentBack.retake, "the rep's list reads the same request back");
  const confirmed = signboardBacklogCheckToKeep(named, 3, "confirm", now);
  assert.equal(confirmed.retake, null, "a confirmed place asks for nothing");
  assert.equal(confirmed.attempts, 4);
  assert.equal(signboardRetakeWaiting({ retake: { advice: "  " } }), null, "a request with no sentence is no request");
  assert.equal(signboardRetakeWaiting(null), null);

  // The retake is taken at the place: a visit's 500 m, widened by the photo's own radius up to 250 m.
  assert.equal(signboardRetakeIsAtThePlace(480, null), true);
  assert.equal(signboardRetakeIsAtThePlace(520, null), false);
  assert.equal(signboardRetakeIsAtThePlace(600, 150), true, "an approximate iPhone reading at the right door");
  assert.equal(signboardRetakeIsAtThePlace(760, 5_000), false, "the slack stops at 250 m");
  assert.equal(signboardRetakeIsAtThePlace(Number.NaN, null), false);

  const sweep = stripComments(readFileSync("src/lib/phoenix-crm/server/signboard-sweep.ts", "utf8"));
  assert.ok(sweep.includes("readStoredPlaceSignboard(input, { secondLook: false })"), "one look per old photo");
  assert.ok(
    sweep.includes("return !stored || (!stored.retake && stored.strongRead !== true);"),
    "a second run reads nothing the first already read",
  );
  assert.ok(sweep.includes('if (options.apply && outcome !== "lost")'), "a dry run writes nothing, and a lost call never overwrites the old record");
  assert.ok(
    sweep.includes("Math.max(kept.attempts, SIGNBOARD_HELD_MAX_READS)"),
    "a held place's count is spent, so the hourly re-read never reads that photo again",
  );
  const pass = stripComments(readFileSync("scripts/phoenix-crm-reread-signboards.mjs", "utf8"));
  assert.ok(pass.includes("signboardNextAttempt(") && pass.includes("signboardReadsRecorded(place.signboard_check)"), "🔴 the script's --apply carries the count, never resets it to 1");
  assert.ok(/await rereadUnreadablePlacesOnce\(\{\s*apply: APPLY,/.test(pass), "and --unreadable writes only with --apply");
  assert.ok(sweep.includes("loadUnreadableBacklog(options.placeIds)"), "a person can name the places to read again");
  assert.ok(
    sweep.includes('if (named) return stored?.verdict !== "match" && stored?.verdict !== "other_name";'),
    "🔴 and a confirmed or flagged place is never read again, named or not",
  );

  // 🔴 A SIDEWAYS SCENE IS TURNED UPRIGHT AND READ ONCE MORE, OFF THE DOOR (2026-10-18): 38 of the first
  // 157 old photos were on their side, and Claude read none of their plates until the image was turned
  // (هبة المصري: "too far" on its side, confirmed upright). The door has no time, so it asks the rep to
  // hold the phone upright instead.
  const reader = stripComments(readFileSync("src/lib/phoenix-crm/server/signboard-check.ts", "utf8"));
  assert.ok(reader.includes('required: ["sign_present", "signs", "note", "problem", "upright"]'), "the reader always says how the scene stands");
  assert.ok(reader.includes("turnUpright: !atTheDoor"), "🔴 the door never spends a second call turning a photo — a rep is waiting");
  assert.ok(reader.includes("const tight = await cropToBox(image, chosen.box);"), "the close look crops the UPRIGHT image its boxes came from");
  assert.ok(/if \(again\.turn !== null\) continue;/.test(reader), "a reading still on its side tries the other way once, then stops");
  const sideways = unreadable({ problem: "sideways" });
  assert.equal(signboardAsksForAPhoto(sideways, "PM"), true, "a photo nobody turned upright is the rep's to retake");
  assert.ok(signboardRetakeAdvice(sideways).includes("Hold the phone upright"), "and he is told to hold the phone upright");
}

/**
 * 🔴 A BOARD TOO FULL FOR ONE ANSWER IS READ IN FOUR QUARTERS (2026-10-18). Two places were a hospital
 * wall of about forty plates, د. طلعت فواد among them; the whole-photo answer ran out of room on every
 * call, so a lost call would have been paid for nightly and never read. Read in quarters, it confirmed.
 */
function checkBoardTooFullForOneAnswer(): void {
  const parts = signboardQuarters();
  assert.equal(parts.length, 4, "four parts");
  for (const part of parts) {
    assert.ok(part.left >= 0 && part.top >= 0 && part.left + part.width <= 1 + 1e-9 && part.top + part.height <= 1 + 1e-9, "each part lies inside the photo");
  }
  // A plate of the forty-plate wall's size (about 13% of the photo tall and 18% wide), anywhere in the
  // photo, is whole inside one part — the number is the photo's, never derived from the overlap.
  const plate = 0.19;
  for (let x = 0; x + plate <= 1; x += 0.01) {
    for (let y = 0; y + plate <= 1; y += 0.01) {
      assert.ok(
        parts.some((part) => x >= part.left - 1e-9 && y >= part.top - 1e-9 && x + plate <= part.left + part.width + 1e-9 && y + plate <= part.top + part.height + 1e-9),
        `🔴 a plate at ${x.toFixed(2)},${y.toFixed(2)} is whole in one quarter — none is cut by the split`,
      );
    }
  }

  const plateSign = (name: string, box: PhoenixCrmSign["box"]): PhoenixCrmSign => ({
    box,
    kind: "medical",
    legibility: "clear",
    personNames: [name],
    placeNames: [],
    text: `د. ${name}`,
  });
  const reading = (signs: PhoenixCrmSign[], over: Partial<{ problem: "none" | "cut_off" | null; turn: "clockwise" | null; signPresent: boolean | null; note: string | null }> = {}) => ({
    note: over.note ?? null,
    problem: over.problem ?? "cut_off",
    signPresent: over.signPresent ?? true,
    signs,
    turn: over.turn ?? null,
  });
  const merged = mergeSignboardParts(
    [
      reading([plateSign("ريمون صالح", { height: 0.2, left: 0.1, top: 0.1, width: 0.3 })]),
      reading([]),
      reading([]),
      reading([plateSign("طلعت فؤاد", { height: 0.5, left: 0, top: 0, width: 0.5 })], { problem: "none" }),
    ],
    parts,
  );
  const talaat = merged.signs.find((sign) => sign.personNames.includes("طلعت فؤاد"));
  const far = 1 - (1 + SIGNBOARD_PART_OVERLAP) / 2;
  const size = (1 + SIGNBOARD_PART_OVERLAP) / 2;
  assert.ok(talaat?.box, "a plate read in the last quarter keeps its box");
  assert.ok(Math.abs(talaat.box.left - far) < 1e-9 && Math.abs(talaat.box.top - far) < 1e-9, "🔴 and its box is put back where it sits in the WHOLE photo");
  assert.ok(Math.abs(talaat.box.width - 0.5 * size) < 1e-9 && Math.abs(talaat.box.height - 0.5 * size) < 1e-9, "at the whole photo's scale");
  assert.equal(merged.signs.length, 2, "every quarter's plates are kept");
  assert.equal(merged.problem, "none", "one quarter with a legible plate makes the photo's word \"none\"");
  assert.equal(merged.turn, null, "a turn stands only when every quarter says it");
  assert.equal(
    mergeSignboardParts([0, 1, 2, 3].map(() => reading([], { turn: "clockwise" })), parts).turn,
    "clockwise",
    "and all four saying it is a turn",
  );
  assert.equal(mergeSignboardParts([0, 1, 2, 3].map(() => reading([], { signPresent: false })), parts).signPresent, false, "no sign only when no quarter has one");
  assert.ok(merged.note?.startsWith("A board of many plates, read in four parts."), "the stored note says how it was read");

  // The judge sees the merged plates exactly as it sees one photo's.
  const verdict = judgeSignboards({ croppedFraction: 0.1, customerName: "د.طلعت فؤاد", listType: "PM", note: merged.note, problem: merged.problem, signPresent: merged.signPresent, signs: merged.signs });
  assert.equal(verdict.verdict, "match", "the customer's plate among forty is a match");

  const fallback = readFileSync("src/lib/ai/anthropic-fallback.ts", "utf8").match(/"(Claude ran out of room[^"]*)"/)?.[1] ?? "";
  assert.ok(fallback.length > 0, "the Anthropic leg still names an answer that ran out of room");
  assert.equal(readerRanOutOfRoom(new Error(fallback)), true, "🔴 an answer that ran out of room is the one failure read again in parts");
  assert.equal(readerRanOutOfRoom(new Error("Response incomplete: max_output_tokens")), true, "the OpenAI leg's spelling too");
  assert.equal(readerRanOutOfRoom(new Error("The AI request timed out.")), false, "a timeout is a lost call, never four more");

  const reader = stripComments(readFileSync("src/lib/phoenix-crm/server/signboard-check.ts", "utf8"));
  assert.ok(
    reader.includes("if (input.signal?.aborted || !input.partsTimeoutMs || !readerRanOutOfRoom(error)) return null;"),
    "only a whole-photo read that ran out of room, and was not stopped, is read again in parts",
  );
  assert.ok(
    reader.includes("return readInParts({ ...input, timeoutMs: input.partsTimeoutMs() });"),
    "🔴 the quarters get the PLACE's time left, capped like one call — never the leftover of the whole read's cap",
  );
  assert.ok(
    reader.includes("const partsTimeoutMs = (): number => signboardPartsTimeoutMs(input.remaining(), input.callCapMs);"),
    "measured off the place's own deadline when the whole read runs out of room",
  );
  assert.equal(
    (reader.match(/readSigns\(\{ jpeg: (?:cropped\.jpeg|turned), partsTimeoutMs, question: WIDE_QUESTION,/g) ?? []).length,
    2,
    "both whole-photo reads, upright and turned, fall back to the quarters",
  );
  assert.ok(!/partsTimeoutMs[^\n]*CLOSE_QUESTION/.test(reader), "a single plate's close look never splits into four calls");

  // 🔴 20 Oct 2026, 16:49–19:49 Cairo: the held re-read's whole-photo answer filled up after 13.7–15.7 s
  // of its 20 s per-call cap, and the quarters got the 4.3–6.3 s left over and timed out, every hour.
  const heldBudget = 45_000;
  const heldCallCap = 20_000;
  for (const wholeReadMs of [13_700, 14_900, 15_700]) {
    assert.equal(
      signboardPartsTimeoutMs(heldBudget - wholeReadMs, heldCallCap),
      heldCallCap,
      `🔴 a held board that filled up after ${wholeReadMs} ms gives its quarters a full call's time, not ${heldCallCap - wholeReadMs} ms`,
    );
  }
  assert.equal(signboardPartsTimeoutMs(6_000, heldCallCap), 6_000, "never more than the place has left, so a place still costs at most its budget");
  assert.equal(signboardPartsTimeoutMs(8_000 - 5_000, 8_000), 3_000, "the door is unchanged: its one call's cap IS its place budget");
  assert.equal(signboardPartsTimeoutMs(-50, heldCallCap), 0, "a place past its deadline gives the quarters nothing");
  assert.ok(reader.includes("if (answered.length !== parts.length) return null;"), "a board read three-quarters is a lost call, never a reading");
}

/**
 * 🔴 THE OWNER'S RULINGS OF 18 OCT 2026, asked one by one after each was measured on the stored readings:
 * ؤ/ئ are و/ي, ذ/ز/د are one letter and ح/خ are one; long vowels are NOT forgiven; and a paper photo on a
 * PM capture is sent back for a nameplate, however clearly it names him.
 */
function checkOwnersSpellingRulings(): void {
  const pm = (customerName: string, personNames: string[]) =>
    signNamesCustomer({ customerName, listType: "PM", personNames, placeNames: [], signText: null }).matches;
  assert.equal(pm("د.طلعت فؤاد", ["طلعت فواد"]), true, "🔴 فؤاد and فواد are one name");
  assert.equal(pm("ناشى نبيل", ["ناشئ نبيل"]), true, "ناشئ and ناشي are one name");
  assert.equal(pm("احمد دكى", ["أحمد ذكي"]), true, "🔴 ذ, ز and د are one letter");
  assert.equal(pm("اسامة ذكي", ["أسامه زكى"]), true, "ذكي and زكى are one name");
  assert.equal(pm("شريف مصطفي ابوخشبه", ["شريف أبو حشبة"]), true, "ح and خ are one letter");
  assert.equal(pm("محمود السيد", ["محمد السيد"]), false, "🔴 a long vowel is never forgiven: محمود is not محمد");
  assert.equal(pm("سعيد علي حسن", ["سعد علي"]), false, "nor سعيد سعد");
  assert.equal(pm("محمد ابو العنيين", ["مجدي أبو العينين"]), false, "and another given name is still another person");
  assert.equal(spelledOneWay("فؤاد ذكي خليل"), "فواد دكي حليل", "the comparison writes each ruled pair one way");

  const plate: PhoenixCrmSign = {
    box: null,
    kind: "medical",
    legibility: "clear",
    personNames: ["أسامة عبد الحميد عبد النبي"],
    placeNames: [],
    text: "دكتور أسامة عبد الحميد عبد النبي للأمراض الصدرية والباطنية",
  };
  const paper = judgeSignboards({ croppedFraction: 0.18, customerName: "د.اسامه عبدالنبي", listType: "PM", note: "a prescription held in a hand", problem: "no_plate", signPresent: true, signs: [plate] });
  assert.equal(paper.verdict, "unjudged", "🔴 a prescription naming him is not a nameplate — it never confirms the place");
  assert.equal(signboardAsksForAPhoto(paper, "PM"), true, "and the rep is asked for a photo of the nameplate");
  const onTheDoor = judgeSignboards({ croppedFraction: 0.18, customerName: "د.اسامه عبدالنبي", listType: "PM", note: null, problem: "none", signPresent: true, signs: [plate] });
  assert.equal(onTheDoor.verdict, "match", "the same name on his plate is a match");
  const hospital: PhoenixCrmSign = { ...plate, personNames: [], placeNames: ["مستشفى حميات منوف"], text: "مستشفى حميات منوف" };
  assert.equal(
    judgeSignboards({ croppedFraction: 0.18, customerName: "مستشفي حميات منوف", listType: "AM", note: null, problem: "no_plate", signPresent: true, signs: [hospital] }).verdict,
    "match",
    "AM keeps its own rule: a hospital signs itself",
  );
  checkPlaceShortForms();
}

/**
 * 🔴 AN AM LIST WRITES SHORT FORMS ITS BUILDINGS SPELL OUT (owner, 2026-10-19, "teach the matcher"):
 * صدر for الأمراض الصدرية, كهربا for الكهرباء, and تعاقد in front of a company it holds a contract with.
 * Every case here is a stored production reading from the replay of that night.
 */
function checkPlaceShortForms(): void {
  const am = (customerName: string, text: string) =>
    signNamesCustomer({ customerName, listType: "AM", personNames: [], placeNames: [], signText: text }).matches;
  assert.equal(am("مستشفى صدر منوف", "مستشفى الأمراض الصدرية بمنوف"), true, "🔴 the list's صدر منوف is the board's chest hospital in Menouf");
  assert.equal(am("مستوصف صدر المحلة", "مديرية الشئون الصحية بالغربية مركز الأمراض الصدرية بالمحلة"), true, "and صدر المحلة the Mahalla chest centre");
  assert.equal(am("كهربا بشتيل", "جنوب القاهرة لتوزيع الكهرباء خدمات الكهرباء بشتيل"), true, "🔴 كهربا is the electricity company's الكهرباء");
  assert.equal(am("تعاقد الغزل", "شركة مصر شبين الكوم للغزل والنسيج"), true, "🔴 تعاقد is the list's word for a contract, never on a board");
  assert.equal(am("مستشفى صدر منوف", "مستشفى الأمراض الصدرية ببنها"), false, "a chest hospital in another town is not this one");
  assert.equal(am("كهربا المرج", "شمال القاهرة لتوزيع الكهرباء"), false, "the company alone does not name the branch the list names");
  assert.equal(
    am("تعاقد الكهرباء كفر الشيخ", "مستشفى حميات كفر الشيخ"),
    false,
    "🔴 a contract row never spends the one-word allowance on its company: the town alone is the fever hospital's board",
  );
  assert.equal(am("مستشفى الحميات", "مستشفى الأمراض الصدرية"), false, "and nothing else about the place axis moved");
  // Read by eye on 2026-10-19, two of the 31 left in Not readable: the list's spelling, the board's word.
  assert.equal(am("تعاقد المقاولين العرب", "شركة المقاولون العرب"), true, "🔴 the list's المقاولين is the board's المقاولون");
  assert.equal(am("مستشفي الصحه النفسه", "مستشفى الصحة النفسية"), true, "🔴 and the list's النفسه the board's النفسية");

  // 🔴 THE PHOTO'S OWN BRICK ANSWERS FOR THE TOWN (owner, 2026-10-19: "brick counts").
  const inBrick = (customerName: string, text: string, photoBrick: string | null) =>
    signNamesCustomer({ customerName, listType: "AM", personNames: [], placeNames: [], signText: text, photoBrick }).matches;
  assert.equal(inBrick("كهربا المرج", "شمال القاهرة لتوزيع الكهرباء", "المرج"), true, "🔴 the company on the sign, the town from where the photo was taken");
  assert.equal(inBrick("تعاقد الماليه كفر الزيات", "مصلحة الضرائب المصرية مأمورية المالية", "كفر الزيات"), true, "and the finance office in the brick كفر الزيات");
  assert.equal(inBrick("كهربا المرج", "شمال القاهرة لتوزيع الكهرباء", "شبرا"), false, "a photo taken in another brick supplies nothing");
  assert.equal(inBrick("كهربا المرج", "شمال القاهرة لتوزيع الكهرباء", null), false, "no brick, no town: the old answer");
  assert.equal(inBrick("كهربا المرج", "صيدلية المرج", "المرج"), false, "🔴 the town alone, on the sign or from the brick, never names the place");
  assert.equal(
    inBrick("تعاقد الكهرباء كفر الشيخ", "مستشفى حميات كفر الشيخ", "كفر الشيخ"),
    false,
    "🔴 the brick never stands in for the COMPANY: the Kafr El Sheikh fever hospital's board stays refused",
  );
  // Replayed before the first apply (2026-10-19): four confirms the brick must not make.
  assert.equal(
    inBrick("مستشفي صحة بشتيل", "إعلان هام تعلن الإدارة الصحية بأسيوم مبادرة 100 يوم صحة", "بشتيل"),
    false,
    "🔴 صحة beside the brick says nothing about WHICH place: a health poster from Asyum is not the Bashtil hospital",
  );
  assert.equal(inBrick("مستشفي جامعة اكتوبر", "مستشفى جامعة الكبير", "6 اكتوبر"), false, "🔴 nor جامعة in a city with several universities");
  assert.equal(inBrick("مستشفى النصر حلوان", "عيادة النصر الشاملة", "حلوان"), false, "🔴 a board that calls itself a clinic is not the hospital on the list");
  assert.equal(
    signNamesCustomer({ customerName: "مستشفى النصر حلوان", listType: "AM", personNames: [], placeNames: ["النصر"], signText: "عيادة النصر الشاملة", photoBrick: "حلوان" }).matches,
    false,
    "🔴 even when the place name the reader split out has lost the word عيادة",
  );
  assert.equal(inBrick("مستشفي تبارك المريوطيه", "مستشفى تبارك للولادة والأطفال", "المريوطيه"), true, "a name that says which place still takes its town from the brick");
  assert.equal(inBrick("مستشفى حميات منوف", "مستشفى حميات مدرف", "منوف"), true, "and the fever hospital in the brick منوف");

  // 🔴 A WORD THAT SAYS WHAT KIND OF PLACE IT IS NEVER SAYS WHICH ONE BESIDE THE BRICK (code review,
  // 19 Oct 2026). Every stored AM reading was replayed first: two confirmations moved, both below.
  assert.equal(
    inBrick("مستشفى المنيا الجامعي", "مستشفى النور الجامعي", "المنيا"),
    false,
    "🔴 another hospital's الجامعي in the brick المنيا is not Minya University Hospital",
  );
  assert.equal(inBrick("مستشفي بنها التعليمي", "التعليمي", "بنها"), false, "🔴 nor a board reading only التعليمي in بنها");
  assert.equal(
    inBrick("مستشفي القناطر الخيريه المركزي", "وزارة الصحة المصرية مستشفى القناطر البيطري المركزي", "القناطر الخيريه"),
    false,
    "🔴 and the town's VETERINARY central hospital is not its central hospital",
  );
  assert.equal(inBrick("مستشفى الرحمة التخصصي", "مستشفى الرحمة التخصصي", "بنها"), true, "a board that carries the name still matches");
  assert.equal(inBrick("مستشفى المنيا الجامعي", "مستشفى المنيا الجامعي", "المنيا"), true, "and so does the hospital's own board");
  assert.equal(inBrick("مستشفي صدر أشمون", "مدير مستشفى الصدر", "أشمون"), true, "a SPECIALTY still says which: the chest hospital in أشمون");
}

/**
 * 🔴 THE RULINGS REACH THE PLACES ALREADY READ THROUGH THEIR STORED READINGS, WITH NO MODEL CALL — and
 * only two changes are ever written: a stored plate that now names him confirms, and a PM confirm on a
 * photo with no nameplate is sent back for one. A case on his board is listed, never settled.
 */
function checkStoredReadingsRejudged(): void {
  const now = new Date("2026-10-18T21:30:00.000Z");
  const plate = (text: string, personNames: string[]): PhoenixCrmSign => ({ box: null, kind: "medical", legibility: "clear", personNames, placeNames: [], text });
  const stored = (customerName: string, listType: "AM" | "PM", signs: PhoenixCrmSign[], over: Partial<PhoenixCrmSignboardCheck>): PhoenixCrmSignboardCheck => ({
    ...judgeSignboards({ croppedFraction: 0.12, customerName, listType, note: null, problem: "none", signPresent: true, signs }),
    attempts: 2,
    checkedAt: "2026-10-18T19:05:00.000Z",
    strongRead: true,
    ...over,
  });

  const fawad = [plate("عيادة د / طلعت فواد", ["طلعت فواد"])];
  const was = stored("د.طلعت فؤاد", "PM", fawad, { reason: null, verdict: "other_name" });
  const confirm = signboardRejudge(was, { customerName: "د.طلعت فؤاد", listType: "PM" }, now);
  assert.equal(confirm?.outcome, "confirm", "🔴 a stored plate that names him under the rulings confirms the place");
  assert.equal(confirm?.check.verdict, "match", "and the kept record is a match");
  assert.equal(confirm?.check.retake, null, "with no retake left waiting");
  assert.equal(confirm?.check.attempts, 2, "🔴 a re-judge is not a read: the count stays as stored");
  assert.equal(confirm?.check.checkedAt, "2026-10-18T19:05:00.000Z", "and so does the time the photo was read");
  assert.equal(confirm?.check.strongRead, true, "and who read it");
  assert.equal(
    signboardRejudge({ ...was, attempts: 0 }, { customerName: "د.طلعت فؤاد", listType: "PM" }, now)?.check.attempts,
    1,
    "a row written before the count existed has had one read",
  );

  const prescription = [plate("دكتور أسامة عبد الحميد عبد النبي", ["أسامة عبد الحميد عبد النبي"])];
  const paperConfirm = stored("د.اسامه عبدالنبي", "PM", prescription, { problem: "no_plate", reason: null, verdict: "match" });
  const retake = signboardRejudge(paperConfirm, { customerName: "د.اسامه عبدالنبي", listType: "PM" }, now);
  assert.equal(retake?.outcome, "retake", "🔴 a PM confirm on a photo with no nameplate is sent back for one");
  assert.equal(retake?.check.verdict, "unjudged", "it no longer stands as a match");
  assert.equal(retake?.check.reason, "unreadable_final", "and is final, so no night or held pass reads that photo again");
  assert.equal(retake?.check.retake?.problem, "no_plate", "the rep is told why");
  assert.ok(retake?.check.retake?.advice, "with the sentence the rep reads");
  assert.equal(retake?.check.retake?.requestedAt, now.toISOString(), "and when it was asked");
  assert.equal(retake?.check.attempts, 2, "the count stays as stored");

  assert.equal(
    signboardRejudge({ ...paperConfirm, problem: "none" }, { customerName: "د.اسامه عبدالنبي", listType: "PM" }, now),
    null,
    "a confirm on his own plate is left alone",
  );
  const hospital = [{ ...prescription[0], personNames: [], placeNames: ["مستشفى حميات منوف"], text: "مستشفى حميات منوف" }];
  assert.equal(
    signboardRejudge(stored("مستشفي حميات منوف", "AM", hospital, { problem: "no_plate", verdict: "match" }), { customerName: "مستشفي حميات منوف", listType: "AM" }, now),
    null,
    "AM is never sent back by the paper ruling",
  );
  const mahmoud = [plate("د / محمد السيد", ["محمد السيد"])];
  assert.equal(
    signboardRejudge(stored("محمود السيد", "PM", mahmoud, { reason: null, verdict: "other_name" }), { customerName: "محمود السيد", listType: "PM" }, now),
    null,
    "🔴 a long vowel is still not forgiven: another name stays another name",
  );
  assert.equal(
    signboardRejudge({ ...was, signs: [] }, { customerName: "د.طلعت فؤاد", listType: "PM" }, now),
    null,
    "a record with no stored reading has nothing to judge again",
  );

  const sweep = stripComments(readFileSync("src/lib/phoenix-crm/server/signboard-sweep.ts", "utf8"));
  const pass = sweep.slice(sweep.indexOf("export async function rejudgeStoredSignboardsOnce"));
  assert.ok(pass.length > 100, "the re-judge pass exists");
  assert.ok(!/readStoredPlaceSignboard|rereadHeldPlaceSignboard/.test(pass), "🔴 the re-judge reads no photo: it costs no model call");
  assert.ok(!/settled_at:|settleIntegrityCase|\.delete\(/.test(pass), "🔴 it never settles or removes a case on the board: that is his click");
  assert.ok(pass.includes(`.is("settled_at", null)`), "it lists the open cases the confirms no longer support");
  const script = readFileSync("scripts/phoenix-crm-reread-signboards.mjs", "utf8");
  assert.ok(script.includes(`"--rejudge"`), "the script takes --rejudge");
  assert.ok(script.includes("if (!REJUDGE && !process.env.ANTHROPIC_API_KEY"), "and the re-judge needs no AI key");
}

/**
 * 🔴 THE DOOR ASKS BOTH READERS AT ONCE (2026-10-19). Asked in turn, a Sonnet read that ran its 8 s
 * left nothing for Haiku, and the place was saved unchecked: 4 times that day. Replayed on 56 production
 * place photos: Sonnet ran past 8 s on 4, and Haiku answered all 4 inside 8 s.
 */
async function checkSideBySideDoor(): Promise<void> {
  type Read = { aborted: boolean; started: boolean };
  const reads = new Map<string, Read>();
  // A reader that answers `value` after `ms`, or stops (and answers nothing) when told to.
  const after = (ms: number, value: string | null | Error) => (name: string, signal: AbortSignal) => {
    const read: Read = { aborted: false, started: true };
    reads.set(name, read);
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => (value instanceof Error ? reject(value) : resolve(value)), ms);
      signal.addEventListener("abort", () => {
        read.aborted = true;
        clearTimeout(timer);
        resolve(null);
      });
    });
  };
  const ask = (plan: Record<string, ReturnType<typeof after>>) => (name: string, signal: AbortSignal) => plan[name](name, signal);

  // The strong reader's answer wins even when the fast one is quicker: nothing a match rests on changes.
  reads.clear();
  assert.equal(
    await firstInListToAnswer(["sonnet", "haiku"], ask({ haiku: after(5, "haiku"), sonnet: after(40, "sonnet") }), 1_000),
    "sonnet",
    "Sonnet's answer stands whenever it comes inside the deadline",
  );
  assert.ok(reads.get("sonnet")?.started && reads.get("haiku")?.started, "both readers were asked");

  // The fast one is used when the strong one comes back empty, or fails.
  reads.clear();
  assert.equal(await firstInListToAnswer(["sonnet", "haiku"], ask({ haiku: after(5, "haiku"), sonnet: after(20, null) })), "haiku");
  reads.clear();
  assert.equal(
    await firstInListToAnswer(["sonnet", "haiku"], ask({ haiku: after(5, "haiku"), sonnet: after(20, new Error("timeout")) })),
    "haiku",
  );

  // Once the answer is settled the read nobody needs is STOPPED, so it never runs on into a failure row.
  reads.clear();
  const startedAt = Date.now();
  assert.equal(await firstInListToAnswer(["sonnet", "haiku"], ask({ haiku: after(500, "haiku"), sonnet: after(5, "sonnet") })), "sonnet");
  assert.ok(Date.now() - startedAt < 300, "it does not wait for the slower reader");
  assert.equal(reads.get("haiku")?.aborted, true, "and the slower read is stopped");

  // Just before the deadline an answer in hand is taken and the strong read stopped: the slow Sonnet case.
  reads.clear();
  const late = Date.now();
  assert.equal(
    await firstInListToAnswer(["sonnet", "haiku"], ask({ haiku: after(5, "haiku"), sonnet: after(2_000, "sonnet") }), 40),
    "haiku",
  );
  assert.ok(Date.now() - late < 1_000, "the fast reader's answer is taken at the deadline, not after Sonnet runs out");
  assert.equal(reads.get("sonnet")?.aborted, true, "and Sonnet is stopped rather than left to time out");

  // At the deadline with nothing in hand, the readers still reading are left to answer.
  reads.clear();
  assert.equal(
    await firstInListToAnswer(["sonnet", "haiku"], ask({ haiku: after(5, null), sonnet: after(60, "sonnet") }), 20),
    "sonnet",
  );
  reads.clear();
  assert.equal(await firstInListToAnswer(["sonnet", "haiku"], ask({ haiku: after(5, null), sonnet: after(10, null) }), 20), null);
  assert.equal(await firstInListToAnswer<string, string>([], () => Promise.resolve("never")), null, "no readers, no answer");
}

export async function runPhoenixCrmSignboardCheckTests(): Promise<void> {
  await checkSideBySideDoor();
  checkOwnersSpellingRulings();
  checkStoredReadingsRejudged();
  checkBoardTooFullForOneAnswer();
  checkStampBand();
  checkDoorScanner();
  checkOneReadPerPhoto();
  checkVerdicts();
  checkRecords();
  checkServerAndSweep();
  checkManySigns();
  checkNameSpelling();
  checkTwoReaders();
  checkSweepRate();
  checkSeatedRowsAreNotSwept();
  console.log("phoenix-crm signboard check: OK");
}
