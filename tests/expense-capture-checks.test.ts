/**
 * The expense capture checks (owner, 2026-11-23, after the District Manager expense inspection), pinned.
 * Each rule below closes a gap the inspection opened a photo or an invoice to find.
 *
 *   1. A BLANK PHOTO is refused where it is taken (blank-frame.ts): calibrated on the 378 arrival and
 *      departure photos of July–November — a black, white or covered frame is blank; the darkest real
 *      night shot and a floor photographed close are NOT.
 *   2. THE ODOMETER IS READ from a car trip's photo, never typed (136 of 207 car claims had typed 0 or
 *      nothing): a model's answer is made safe, a photo it cannot read is refused with what to do, a
 *      reader that is down refuses nothing, and a photo taken before the rule carries no reading.
 *   3. ONE INSPECTION for both photos (evidence-photo-inspection.ts): blank first, then the odometer;
 *      an offline replay and a role that owes no photo keep it, marked; the system's own failure
 *      never costs the employee his claim.
 *   4. THE RETURN TICKET: a return fare is paid on a read return ticket, asked with the departure photo.
 *   5. What the desk reads back from a stored row: the frame, the odometer and the return ticket.
 */
import assert from "node:assert/strict";

import { claimFactsFromRow, odometerReadingsOfRow, oneWayKmOfRow } from "@/lib/outstation/approvals/claim-row";
import {
  BLANK_EDGE_BELOW,
  BLANK_FLAT_SPREAD_BELOW,
  BLANK_SPREAD_BELOW,
  blankFrameRefusal,
  blankFrameSentence,
  FRAME_SAMPLE_SIZE,
  FRAME_TOP_SHARE,
  frameOfMetadata,
  greyFromRgba,
  isBlankFrame,
  OutstationPhotoRefusedError,
  photoRefusalCode,
  readFrame,
  type FrameReading,
} from "@/lib/outstation/blank-frame";
import { inspectEvidencePhoto } from "@/lib/outstation/evidence-photo-inspection";
import { odometerScanRequest, odometerViewsOf } from "@/lib/outstation/odometer-scan";
import {
  canAttachMissingOutstationTicket,
  missingTicketAttachedSentence,
  returnTicketAskIsDue,
} from "@/lib/outstation/missing-ticket";
import {
  departureBelowArrivalMessage,
  kmLabel,
  normalizeOdometerScan,
  ODOMETER_GUIDANCE,
  ODOMETER_NEEDS,
  ODOMETER_NEXT_PHOTO_KEPT,
  ODOMETER_PROBLEMS,
  ODOMETER_REFUSALS_BEFORE_KEEPING,
  ODOMETER_SCAN_MAX_OUTPUT_TOKENS,
  odometerFromValue,
  odometerOfMetadata,
  odometerRecordOf,
  odometerRefusalMessage,
  odometerRefusedTriesOf,
  ODOMETER_VIEW_NAMES,
  ODOMETER_VIEW_TURNS,
  type OdometerRead,
} from "@/lib/outstation/odometer-scan-rules";
import { legOnClaim, returnFareLabel, returnTicketState, sameLegAgainRefusal } from "@/lib/outstation/return-ticket";

const SIZE = FRAME_SAMPLE_SIZE;
const flat = (value: number) => new Uint8Array(SIZE * SIZE).fill(value);

async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    assert.ok(error instanceof OutstationPhotoRefusedError, `a refused photo is a 400 the employee acts on, not a fault: ${String(error)}`);
    return error.message;
  }
}

export async function runExpenseCaptureChecksTests() {
  // ── 1. A blank photo ──────────────────────────────────────────────────────────────────────────
  assert.equal(FRAME_TOP_SHARE, 0.55, "the part above the stamp panel");
  assert.equal(SIZE, 64);
  assert.deepEqual([BLANK_EDGE_BELOW, BLANK_SPREAD_BELOW, BLANK_FLAT_SPREAD_BELOW], [1, 20, 5], "the calibration of 23 Nov");

  for (const [name, value] of [["black", 0], ["white", 255], ["grey", 128]] as const) {
    const reading = readFrame(flat(value), SIZE, SIZE);
    assert.equal(reading?.blank, true, `a ${name} frame is blank`);
    assert.equal(reading?.sd, 0);
  }
  // A real scene: a gradient with texture is never blank.
  const scene = new Uint8Array(SIZE * SIZE).map((_, index) => (index % SIZE) * 3 + ((index * 7) % 11) * 4);
  assert.equal(readFrame(scene, SIZE, SIZE)?.blank, false);
  // The calibrated readings themselves.
  assert.equal(isBlankFrame({ edge: 0.9, sd: 19.9 }), true, "a covered lens: no edges, little spread");
  assert.equal(isBlankFrame({ edge: 6, sd: 4.9 }), true, "one flat colour whatever its sensor noise");
  assert.equal(isBlankFrame({ edge: 7, sd: 27.9 }), false, "HEADLINE: the darkest real night shot is not blank");
  assert.equal(isBlankFrame({ edge: 1.5, sd: 12 }), false, "a floor or a wall photographed close is a real photo of the wrong thing");
  assert.equal(isBlankFrame({ edge: 0.9, sd: 20 }), false, "the spread bound is strict");
  assert.equal(isBlankFrame({ edge: 1, sd: 19 }), false, "the edge bound is strict");
  // A frame that cannot be read is never called blank.
  assert.equal(readFrame(flat(0), 1, SIZE), null);
  assert.equal(readFrame(new Uint8Array(10), SIZE, SIZE), null);
  // The canvas grey uses the same weights as the server's.
  assert.deepEqual([...greyFromRgba([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])], [54, 182, 18]);
  // What the employee and the approver are told.
  assert.equal(
    blankFrameRefusal("arrival", { mean: 3 }),
    "Nothing can be seen in this arrival photo: it is black — the lens is covered or the place is too dark. Take it again with the lens clear and the place in view.",
  );
  assert.match(blankFrameRefusal("departure", { mean: 250 }), /^Nothing can be seen in this departure photo: it is white/);
  assert.match(blankFrameRefusal("arrival", { mean: 120 }), /one flat colour/);
  assert.equal(blankFrameSentence("departure"), "The departure photo is blank: nothing can be seen in it.");
  assert.deepEqual(frameOfMetadata({ frame: { blank: true, edge: 0.2, sd: 1.1 } }), { blank: true, edge: 0.2, mean: 0, sd: 1.1 });
  assert.equal(frameOfMetadata({ capturedAt: "x" }), null, "a photo taken before the rule was never measured");
  assert.equal(frameOfMetadata({ frame: { blank: "yes", edge: 0, sd: 0 } }), null, "a value the phone could have written is not a reading");

  // ── 2. The odometer, read ─────────────────────────────────────────────────────────────────────
  assert.deepEqual(normalizeOdometerScan({ is_dashboard: true, odometer_km: 52612, problems: [], trip_km: 183.46 }), {
    km: 52612,
    status: "read",
    tripKm: 183.5,
  });
  assert.deepEqual(normalizeOdometerScan({ is_dashboard: true, odometer_km: "52,612", trip_km: null }), { km: 52612, status: "read", tripKm: null });
  assert.deepEqual(
    normalizeOdometerScan({ is_dashboard: true, odometer_km: 1_200_000, problems: ["glare", "made_up"] }),
    { problems: ["glare"], status: "unreadable" },
    "a seven-digit odometer is a misread, and a problem off the list is dropped",
  );
  assert.deepEqual(normalizeOdometerScan({ is_dashboard: false, odometer_km: 52612, problems: [] }), {
    problems: ["not_a_dashboard"],
    status: "unreadable",
  }, "a number read off something that is not a dashboard is not an odometer");
  assert.deepEqual(normalizeOdometerScan({ odometer_km: null }), { problems: ["blurry"], status: "unreadable" }, "a refusal always says what to do");
  assert.deepEqual([...ODOMETER_PROBLEMS].sort(), Object.keys(ODOMETER_GUIDANCE).sort(), "every problem has its instruction");
  const refused = odometerRefusalMessage("departure", { problems: ["too_far", "glare"], status: "unreadable" });
  assert.equal(
    refused,
    `Not accepted: the system could not read the kilometres on this departure photo. ${ODOMETER_GUIDANCE.too_far} ${ODOMETER_GUIDANCE.glare} ${ODOMETER_NEEDS} ${ODOMETER_NEXT_PHOTO_KEPT}`,
  );
  assert.match(odometerRefusalMessage("arrival", { problems: ["not_a_dashboard"], status: "unreadable" }), /^Not accepted: this arrival photo does not show the car's odometer\./);
  assert.deepEqual(odometerRecordOf({ km: 52612, status: "read", tripKm: null }, "T"), { km: 52612, readAt: "T", status: "read", tripKm: null });
  assert.deepEqual(odometerRecordOf({ status: "unavailable" }, "T"), { km: null, readAt: "T", status: "not_read", tripKm: null }, "the reader down is NOT the photo unreadable");
  assert.equal(odometerOfMetadata({ capturedAt: "x" }), undefined, "HEADLINE: a photo taken before the rule carries no reading at all");
  assert.equal(odometerOfMetadata(null), undefined);
  assert.deepEqual(odometerOfMetadata({ odometer: { km: 52612, readAt: "T", status: "read", tripKm: null } })?.km, 52612);
  assert.equal(odometerFromValue({ km: null, status: "read" }), undefined, "a read reading must carry its kilometres");
  assert.equal(odometerFromValue({ km: 5, status: "guessed" }), undefined);
  assert.equal(odometerFromValue({ km: 99, readAt: "T", status: "not_read" })?.km, null, "kilometres only on a read reading");
  assert.equal(kmLabel(52612.4), "52,612");

  // ── 3. One inspection for both photos ─────────────────────────────────────────────────────────
  const BLANK: FrameReading = { blank: true, edge: 0.1, mean: 2, sd: 0.8 };
  const REAL: FrameReading = { blank: false, edge: 9, mean: 120, sd: 45 };
  const readerCalls: string[] = [];
  const reader = (answer: OdometerRead) => async () => {
    readerCalls.push(answer.status);
    return answer;
  };
  const inspect = (over: Partial<Parameters<typeof inspectEvidencePhoto>[0]>) =>
    inspectEvidencePhoto({
      bytes: Buffer.from("jpeg"),
      car: true,
      mayRefuse: true,
      measure: async () => REAL,
      now: "2026-11-23T08:00:00.000Z",
      photo: "arrival",
      readOdometer: reader({ km: 52612, status: "read", tripKm: null }),
      ...over,
    });

  assert.deepEqual(await inspect({}), {
    frame: REAL,
    odometer: { km: 52612, readAt: "2026-11-23T08:00:00.000Z", status: "read", tripKm: null },
  });
  readerCalls.length = 0;
  assert.equal(
    await refusal(() => inspect({ measure: async () => BLANK })),
    blankFrameRefusal("arrival", BLANK),
    "HEADLINE: a blank frame is refused where it is taken",
  );
  assert.deepEqual(readerCalls, [], "a blank frame is never sent to the reader");
  assert.match(
    (await refusal(() => inspect({ photo: "departure", readOdometer: reader({ problems: ["blurry"], status: "unreadable" }) }))) ?? "",
    /^Not accepted: the system could not read the kilometres on this departure photo/,
    "an odometer the system cannot read is refused with what to do",
  );
  // The system's own failure costs nothing.
  assert.deepEqual(await inspect({ measure: async () => null }), {
    frame: null,
    odometer: { km: 52612, readAt: "2026-11-23T08:00:00.000Z", status: "read", tripKm: null },
  }, "a photo the server could not open is not a blank photo");
  assert.equal((await inspect({ readOdometer: reader({ status: "unavailable" }) })).odometer?.status, "not_read", "the reader down refuses nothing");
  // A replay and a waived role keep the photo, marked.
  const kept = await inspect({ mayRefuse: false, measure: async () => BLANK });
  assert.deepEqual(kept.frame, BLANK, "kept, and the approver reads it is blank");
  assert.equal(kept.odometer?.status, "unreadable");
  assert.equal((await inspect({ mayRefuse: false, readOdometer: reader({ problems: ["dark"], status: "unreadable" }) })).odometer?.status, "unreadable");
  // Refused for its odometer ONCE, never twice (owner, 2026-11-25, after Dina Hamdy retook a sharp night
  // photo of 481,456 km for half an hour): the refusal is coded, so the phone can count it.
  const unreadable = reader({ problems: ["dark"], status: "unreadable" });
  let coded: unknown = null;
  try {
    await inspect({ photo: "departure", readOdometer: unreadable });
  } catch (error) {
    coded = error;
  }
  assert.equal(photoRefusalCode(coded), "odometer_refused", "an odometer refusal is answered as odometer_refused");
  assert.equal(photoRefusalCode(new OutstationPhotoRefusedError("blank")), null, "a blank-frame refusal is not counted as one");
  assert.match(odometerRefusalMessage("departure", { problems: ["dark"], status: "unreadable" }), new RegExp(`${ODOMETER_NEXT_PHOTO_KEPT}$`), "the refusal says the next photo is kept");
  const secondTry = await inspect({ odometerRefusedTries: 1, photo: "departure", readOdometer: unreadable });
  assert.deepEqual(
    secondTry.odometer,
    { km: null, readAt: "2026-11-23T08:00:00.000Z", refusedTries: 1, status: "unreadable", tripKm: null },
    "HEADLINE: after one odometer refusal the next photo is KEPT, marked, for the approver",
  );
  assert.equal(ODOMETER_REFUSALS_BEFORE_KEEPING, 1);
  assert.ok(await refusal(() => inspect({ measure: async () => BLANK, odometerRefusedTries: 3 })), "a blank frame is still refused every time");
  assert.equal(odometerOfMetadata({ odometer: secondTry.odometer })?.refusedTries, 1, "the count travels with the stored reading");
  assert.equal(odometerRefusedTriesOf("2"), 2);
  assert.equal(odometerRefusedTriesOf(-1), 0);
  assert.equal(odometerRefusedTriesOf(1.5), 0);
  assert.equal(odometerRefusedTriesOf(99), 20);
  assert.equal(odometerRefusedTriesOf(null), 0);
  // A departure reading below the same trip's arrival is a misread (claim 423: 57,108 then 51,109).
  const arrivalRead = { km: 57108, readAt: "T", status: "read" as const, tripKm: null };
  assert.match(
    (await refusal(() => inspect({ arrivalOdometer: arrivalRead, photo: "departure", readOdometer: reader({ km: 51109, status: "read", tripKm: null }) }))) ?? "",
    /^Not accepted: this departure photo reads 51,109 km, less than the 57,108 km on your arrival photo/,
    "HEADLINE: a departure reading below the arrival is refused as a misread",
  );
  assert.equal(
    (await inspect({ arrivalOdometer: arrivalRead, odometerRefusedTries: 1, photo: "departure", readOdometer: reader({ km: 51109, status: "read", tripKm: null }) })).odometer?.km,
    51109,
    "kept on the second photo — the desk then fails 'went down during the trip'",
  );
  assert.equal(
    (await inspect({ arrivalOdometer: arrivalRead, photo: "departure", readOdometer: reader({ km: 57290, status: "read", tripKm: null }) })).odometer?.km,
    57290,
    "a departure above the arrival is accepted",
  );
  assert.equal(
    (await inspect({ arrivalOdometer: { ...arrivalRead, km: null, status: "not_read" }, photo: "departure", readOdometer: reader({ km: 100, status: "read", tripKm: null }) })).odometer?.km,
    100,
    "an arrival never read cannot make a departure a misread",
  );
  assert.equal(departureBelowArrivalMessage(arrivalRead, { status: "unavailable" }), null);
  // The reader gets room to finish: 600 stopped the second provider mid-answer on 24 and 25 Nov 2026.
  assert.ok(ODOMETER_SCAN_MAX_OUTPUT_TOKENS >= 2_000, "the odometer reader's answer room");
  // Digits on their side (owner, 2026-11-25: "make the odometer reader read sideways digits"): the photo goes to
  // the reader four ways in one look — as taken, a quarter clockwise, a quarter anticlockwise, upside down. A
  // photo 4 wide and 2 high with one white corner shows each turn: sideways it is 2 wide, and the corner moves.
  const { default: sharp } = await import("sharp");
  const raw = Buffer.alloc(4 * 2 * 3, 0);
  raw.fill(255, 0, 3); // the top-left pixel white
  const photo = await sharp(raw, { raw: { channels: 3, height: 2, width: 4 } }).jpeg({ quality: 100 }).toBuffer();
  const views = await odometerViewsOf(photo);
  assert.ok(views, "a photo the server can open is turned");
  assert.equal(views.length, 4, "four views of the one photo");
  assert.equal(views[0], photo, "the first view is the photo as taken, untouched");
  const shapes = await Promise.all(views.map(async (view) => {
    const { data, info } = await sharp(view).raw().toBuffer({ resolveWithObject: true });
    const brightest = [...Array(info.width * info.height).keys()].reduce((best, index) => (data[index * info.channels] > data[best * info.channels] ? index : best), 0);
    return { corner: [brightest % info.width, Math.floor(brightest / info.width)], size: [info.width, info.height] };
  }));
  assert.deepEqual(shapes, [
    { corner: [0, 0], size: [4, 2] }, // as taken
    { corner: [1, 0], size: [2, 4] }, // a quarter clockwise: the top-left corner goes to the top-right
    { corner: [0, 3], size: [2, 4] }, // a quarter anticlockwise: it goes to the bottom-left
    { corner: [3, 1], size: [4, 2] }, // upside down: it goes to the bottom-right
  ], "each view is the photo turned the way the reader is told it is");
  assert.equal(await odometerViewsOf(Buffer.from("not a photo")), null, "a photo the server cannot open is not read (kept as not read)");
  const request = odometerScanRequest(views);
  const images = request.input[0].content.filter((part) => part.type === "input_image");
  assert.equal(images.length, 4, "all four views go in the one look");
  assert.deepEqual(images.map((part) => ("image_url" in part ? part.image_url : "")), views.map((view) => `data:image/jpeg;base64,${view.toString("base64")}`), "in the order the instructions name them");
  ODOMETER_VIEW_NAMES.forEach((name, index) => assert.ok(request.instructions.includes(`image ${index + 1} ${name}`), `the instructions name image ${index + 1} as ${name}`));
  assert.deepEqual([...ODOMETER_VIEW_TURNS], [0, 90, 270, 180]);
  assert.equal(request.model, "gpt-5.4", "the strong tier reads it (the cheap one refused a sharp sideways photo four times out of four)");
  assert.ok(request.text.format.schema.required.includes("upright_image"), "the reader says which view it read");
  // A train or bus photo is measured, never read for an odometer.
  readerCalls.length = 0;
  assert.deepEqual(await inspect({ car: false }), { frame: REAL, odometer: null });
  assert.deepEqual(readerCalls, []);
  assert.ok(await refusal(() => inspect({ car: false, measure: async () => BLANK })), "a blank train photo is refused too");

  // ── 4. The return ticket ──────────────────────────────────────────────────────────────────────
  const leg = (matchedTo: string, fromStation = "Cairo", toStation = "Asyut") => ({ scan: { fromStation, matchedTo, toStation, travelDate: "2026-11-18" } });
  const state = (tickets: unknown, over: { returnAmount?: number | null; transportation?: string } = {}) =>
    returnTicketState({ returnAmount: 270, tickets, transportation: "train", ...over });
  assert.equal(state([leg("arrival")]), "missing", "HEADLINE: the return paid on the outbound ticket alone");
  assert.equal(state([leg("arrival"), leg("departure", "Asyut", "Cairo")]), "present");
  assert.equal(state([leg("departure")]), "present", "a ticket matched to the departure is the return");
  assert.equal(state([leg("arrival"), leg("arrival", "Asyut", "Cairo")]), "present", "a same-day return is dated the arrival day; the opposite way is the return");
  assert.equal(state([leg("arrival"), leg("arrival")]), "missing", "two copies of the outbound are not a return");
  assert.equal(state([leg("arrival"), leg("arrival", "", "")]), "present", "a leg with no stations read is still a second leg");
  assert.equal(state([{ name: "ticket.jpg" }]), "unread", "a ticket that was never read proves nothing either way");
  assert.equal(state([leg("unmatched")]), "unread");
  assert.equal(state([leg("arrival")], { returnAmount: 0 }), "not_claimed");
  assert.equal(state([leg("arrival")], { transportation: "car" }), "not_claimed");
  assert.equal(state([leg("arrival")], { transportation: "Bus" }), "missing");
  // A second photo of the leg already on the claim is refused at the pick (2026-11-28: Weaam Gweed's
  // Cairo → Luxor ticket went on three times and the card came back after each "Return ticket attached").
  const again = (candidates: unknown[], tickets: unknown = [leg("arrival", "Cairo", "Luxor")], returnAmount = 520) =>
    sameLegAgainRefusal({ candidates: candidates as never, returnAmount, tickets, transportation: "train" });
  const copy = again([leg("arrival", "Cairo", "Luxor").scan]);
  assert.ok(copy, "HEADLINE: the same leg again is refused, never taken as the return");
  assert.match(copy.reason, /same ticket already on this claim \(Cairo to Luxor, Wed,? 18 Nov 2026\)/);
  assert.match(copy.guidance[0], /the one you travelled on to Cairo/, "it names the way the missing leg runs");
  assert.equal(again([leg("arrival", "Sohag", "Cairo").scan]), null, "the other way is the second leg");
  assert.equal(again([leg("departure", "Cairo", "Luxor").scan]), null, "a ticket matched to the departure is the return");
  assert.equal(again([{ matchedTo: "not_read" }]), null, "a ticket the reader could not reach is never refused");
  assert.equal(again([leg("arrival", "Cairo", "Luxor").scan], [leg("arrival", "Cairo", "Luxor")], 0), null, "no return fare, nothing owed");
  assert.equal(again([leg("arrival").scan], [leg("arrival"), leg("departure", "Asyut", "Cairo")]), null, "a claim with both legs is left alone");
  assert.equal(again([]), null);
  const onClaim = legOnClaim([leg("arrival", "Cairo", "Luxor")]);
  assert.deepEqual({ ...onClaim, day: undefined }, { day: undefined, fromStation: "Cairo", toStation: "Luxor" });
  assert.match(String(onClaim?.day), /^Wed,? 18 Nov 2026$/);
  assert.equal(legOnClaim([{ name: "ticket.jpg" }]), null);
  assert.equal(returnFareLabel(270), "EGP 270");
  assert.equal(returnFareLabel(92.5), "EGP 92.5");

  // Asked with the departure photo, or once the last day has come.
  assert.equal(returnTicketAskIsDue({ hasDeparturePhoto: true, today: "2026-11-17", tripEndDate: "2026-11-18" }), true);
  assert.equal(returnTicketAskIsDue({ hasDeparturePhoto: false, today: "2026-11-17", tripEndDate: "2026-11-18" }), false, "not before he has come back");
  assert.equal(returnTicketAskIsDue({ hasDeparturePhoto: false, today: "2026-11-18", tripEndDate: "2026-11-18T00:00:00" }), true);
  assert.equal(returnTicketAskIsDue({ hasDeparturePhoto: false, today: "2026-11-18", tripEndDate: null }), false);
  // A second ticket may be attached only for the missing return.
  const attach = (over: Partial<Parameters<typeof canAttachMissingOutstationTicket>[0]>) =>
    canAttachMissingOutstationTicket({ status: "submitted", ticketAttachmentCount: 1, transportationType: "train", ...over });
  assert.equal(attach({}), false, "a claim with its ticket is not asked again");
  assert.equal(attach({ returnTicketMissing: true }), true);
  assert.equal(attach({ returnTicketMissing: true, status: "accepted_by_admin" }), false, "nothing is added once the claim is decided");
  assert.equal(attach({ returnTicketMissing: true, transportationType: "car" }), false);
  assert.equal(
    missingTicketAttachedSentence("23 Nov 2026, 10:00", 1, "return"),
    "The employee attached the return ticket on 23 Nov 2026, 10:00 (1 file).",
  );
  assert.match(missingTicketAttachedSentence("23 Nov 2026, 10:00", 2), /after the claim arrived without it/);

  // ── 5. What the desk reads back from a stored row ─────────────────────────────────────────────
  const odometer = (km: number) => ({ km, readAt: "T", status: "read", tripKm: null });
  const row = {
    car_evidence_image_path: "arrival.jpg",
    car_evidence_metadata: { capturedAt: "2026-11-18T07:00:00Z", capturedLatitude: 27.18, capturedLongitude: 31.18, frame: BLANK, odometer: odometer(52612) },
    departure_evidence_image_path: "departure.jpg",
    departure_evidence_metadata: { capturedAt: "2026-11-18T15:00:00Z", frame: REAL, odometer: odometer(52790) },
    distance_from_residence_km: 180,
    employee_hr_id: "PD-0015",
    expense_type: "traveling",
    id: 163,
    return_ticket_amount: 270,
    status: "submitted",
    ticket_attachment_metadata: [leg("arrival")],
    transportation_type: "car",
    trip_end_date: "2026-11-18",
    trip_start_date: "2026-11-18",
  };
  const read = claimFactsFromRow(row, {
    odometerChain: { anchor: { date: "2026-11-10", km: 52605 }, paidKmSinceAnchor: 360 },
    sharedTripDays: ["18 Nov with the waiting claim of 17 Nov"],
    today: "2026-11-23",
  });
  assert.equal(read.arrival.blank, true, "the stored frame reaches the desk");
  assert.equal(read.departure.blank, false);
  assert.deepEqual(read.odometer, {
    anchor: { date: "2026-11-10", km: 52605 },
    arrival: { km: 52612, status: "read" },
    departure: { km: 52790, status: "read" },
    paidKmSinceAnchor: 360,
  });
  assert.deepEqual(read.sharedTripDays, ["18 Nov with the waiting claim of 17 Nov"]);
  assert.equal(read.returnTicket, "not_claimed", "a car trip owes no return ticket");
  const train = claimFactsFromRow({ ...row, transportation_type: "train" }, { today: "2026-11-23" });
  assert.equal(train.returnTicket, "missing");
  assert.equal(train.returnAmount, 270);
  // A photo removed from the claim takes its reading with it; a row from before the rule has none.
  assert.equal(claimFactsFromRow({ ...row, car_evidence_image_path: null }, { today: "2026-11-23" }).arrival.blank, undefined);
  const before = claimFactsFromRow({ ...row, car_evidence_metadata: { capturedAt: "2026-11-18T07:00:00Z" } }, { today: "2026-11-23" });
  assert.equal(before.odometer, undefined, "no odometer line for a claim the rule never saw");
  assert.equal(before.arrival.blank, undefined, "never measured is not blank");
  // A decided claim's readings come from the path-read columns.
  assert.deepEqual(odometerReadingsOfRow({ arrival_odometer: odometer(51000), departure_odometer: null }), {
    arrival: { km: 51000, readAt: "T", status: "read", tripKm: null },
    departure: undefined,
  });
  assert.equal(oneWayKmOfRow({ distance_from_residence_km: 180, distance_km: 175 }), 180, "the distance the fuel was priced on");
  assert.equal(oneWayKmOfRow({ distance_km: 175 }), 175);
  assert.equal(oneWayKmOfRow({}), null);
}
