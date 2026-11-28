/**
 * The October expense audit's guards (owner, 23 Nov 2026: "Build the guards"), pinned.
 *
 *   1. One ticket, one parking cost and one receipt photo are claimed once. Three real copies passed
 *      the same-trip guard because their destinations were worded differently: Ali Elsayed's
 *      OUTSTATION-318/320 (same 130 + 220 train and 200 parking, one day), Mohamed Ramadan's
 *      401/402 (same 230 + 230 fare, overlapping days) and Nahed's 164/175 (the same bus-ticket
 *      photo, IMG_1649.jpg, 361,687 bytes). Submission refuses the copy naming the earlier claim;
 *      the approvals screen flags every stored pair. A refused claim never blocks.
 *   2. A departure photo after the trip's last Cairo day is REFUSED — the first capture as well as a
 *      retake ("Refuse after last day"). 17 of 170 were taken after the trip. The portal card says
 *      so instead of offering a camera; HR releases the claim with a reason.
 *   3. An uploaded arrival photo carries its own time: the wizard reads the file's EXIF before the
 *      canvas re-encode drops it, burns it into the watermark, and the approver reads it under the
 *      photo. A file with no time says so in words; it is never refused for it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseCarEvidenceMetadata } from "../app/api/outstation/request-body.ts";
import { exifDateTimeToIso, photoFileTimeCaption, readPhotoFileTakenAt } from "@/lib/evidence/photo-file-time";
import { departurePhotoWindowClosedMessage, isWithinDepartureWindow } from "@/lib/outstation/departure-evidence";
import {
  duplicateTicketMessage,
  findDuplicateTicket,
  flagDuplicateTicketRows,
  readTicketKey,
  sameTicketTwice,
  ticketReceiptFingerprint,
  type DuplicateTicketExisting,
} from "@/lib/outstation/duplicate-ticket-guard";
import { uploadedArrivalSourceNote } from "@/lib/outstation/trip-evidence-photos";

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

// ── A JPEG with an EXIF block, built byte by byte ────────────────────────────────────────────────
function asciiBytes(value: string) {
  return [...value].map((char) => char.charCodeAt(0)).concat(0);
}

function exifJpeg(options: { dateTimeOriginal?: string; dateTime?: string; offset?: string; bigEndian?: boolean }) {
  const little = !options.bigEndian;
  const tiff: number[] = [];
  const u16 = (value: number) => (little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff]);
  const u32 = (value: number) =>
    little
      ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
      : [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];

  const ifd0Entries = (options.dateTime ? 1 : 0) + 1;
  const ifd0Size = 2 + ifd0Entries * 12 + 4;
  const exifEntries = (options.dateTimeOriginal ? 1 : 0) + (options.offset ? 1 : 0);
  const exifOffset = 8 + ifd0Size;
  const exifSize = 2 + exifEntries * 12 + 4;
  let dataAt = exifOffset + exifSize;
  const data: number[] = [];
  const asciiEntry = (tag: number, value: string) => {
    const bytes = asciiBytes(value);
    const entry = [...u16(tag), ...u16(2), ...u32(bytes.length), ...u32(dataAt)];
    data.push(...bytes);
    dataAt += bytes.length;
    return entry;
  };

  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(0x2a), ...u32(8));
  const ifd0: number[] = [...u16(ifd0Entries)];
  if (options.dateTime) ifd0.push(...asciiEntry(0x0132, options.dateTime));
  ifd0.push(...u16(0x8769), ...u16(4), ...u32(1), ...u32(exifOffset), ...u32(0));
  const exif: number[] = [...u16(exifEntries)];
  if (options.dateTimeOriginal) exif.push(...asciiEntry(0x9003, options.dateTimeOriginal));
  if (options.offset) exif.push(...asciiEntry(0x9011, options.offset));
  exif.push(...u32(0));
  tiff.push(...ifd0, ...exif, ...data);

  const app1Body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = app1Body.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...app1Body, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

export async function runOutstationClaimGuardsTests() {
  // ═══ 1 · The same ticket is claimed once ═══════════════════════════════════════════════════════
  const ali318: DuplicateTicketExisting = {
    employeeHrId: "AI-0318",
    goTicketAmount: 130,
    id: 318,
    otherAmount: 200,
    returnTicketAmount: 220,
    status: "accepted_by_admin",
    toCity: "Kafr El-Sheikh",
    tripEndDate: "2026-10-28",
    tripStartDate: "2026-10-28",
  };
  // OUTSTATION-320 as it was submitted: the HR id in another casing, everything else the same.
  const copy320 = {
    employeeHrId: "ai-0318",
    goTicketAmount: 130,
    otherAmount: 200,
    returnTicketAmount: 220,
    toCity: "Kafr El Sheikh",
    tripEndDate: "2026-10-28",
    tripStartDate: "2026-10-28",
  };
  const aliMatch = findDuplicateTicket(copy320, [ali318]);
  assert.ok(aliMatch, "OUTSTATION-320 repeats 318's tickets and parking on the same day and must be refused");
  assert.deepEqual(aliMatch.repeats, ["tickets", "other"], "both the tickets and the other cost repeat");
  const aliMessage = duplicateTicketMessage(aliMatch);
  assert.ok(aliMessage.includes("OUTSTATION-318") && aliMessage.includes("28 Oct 2026"), "the refusal names the earlier claim and its day");
  assert.ok(aliMessage.includes("was not submitted"), "the refusal says nothing was submitted");

  const ramadan401: DuplicateTicketExisting = {
    employeeHrId: "MR-0401",
    goTicketAmount: 230,
    id: 401,
    returnTicketAmount: 230,
    status: "pending_admin_review",
    toCity: "New Cairo",
    tripEndDate: "2026-11-19",
    tripStartDate: "2026-11-18",
  };
  const ramadanMatch = findDuplicateTicket(
    { employeeHrId: "MR-0401", goTicketAmount: 230, returnTicketAmount: 230, toCity: "Cairo", tripStartDate: "2026-11-19" },
    [ramadan401],
  );
  assert.equal(ramadanMatch?.earlier.id, 401, "402 (19 Nov) overlaps 401 (18-19 Nov) with the same 230 + 230 fare, whatever the city is called");
  assert.deepEqual(ramadanMatch?.repeats, ["tickets"]);

  const nahed164: DuplicateTicketExisting = {
    employeeHrId: "PD-0164",
    goTicketAmount: 110,
    id: 164,
    receipts: [{ name: "1-IMG_1649.jpg", size: 361687 }],
    returnTicketAmount: 110,
    status: "accepted_by_admin",
    toCity: "Minya",
    tripEndDate: "2026-09-23",
    tripStartDate: "2026-09-20",
  };
  const nahedMatch = findDuplicateTicket(
    {
      employeeHrId: "PD-0164",
      goTicketAmount: 95,
      receipts: [{ name: "IMG_1649.JPG", size: 361687 }],
      returnTicketAmount: 125,
      toCity: "First Al Minya",
      tripStartDate: "2026-10-05",
    },
    [nahed164],
  );
  assert.deepEqual(nahedMatch?.repeats, ["receipt"], "the same ticket photo is refused on its own, whatever the dates and amounts");
  assert.ok(duplicateTicketMessage(nahedMatch!).includes("the same ticket photo"));
  assert.equal(ticketReceiptFingerprint({ name: "IMG_0001.jpg", size: 0 }), null, "a file with no size has no fingerprint");
  // The approvals screen carries receipts as text fingerprints (ExpenseTripRecord.ticketReceipts).
  assert.equal(ticketReceiptFingerprint({ name: "1-IMG_1649.jpg", size: 361687 }), "img_1649.jpg|361687");
  assert.deepEqual(
    flagDuplicateTicketRows([
      { date: "2026-09-20", hrId: "PD-0164", receipts: ["img_1649.jpg|361687"], tripId: "164" },
      { date: "2026-10-05", hrId: "PD-0164", receipts: ["img_1649.jpg|361687"], tripId: "175" },
    ]).get("175"),
    ["164"],
    "a fingerprint matches a fingerprint on the approvals screen",
  );
  assert.equal(
    findDuplicateTicket(
      { employeeHrId: "PD-0164", receipts: [{ name: "IMG_1649.jpg", size: 361000 }], tripStartDate: "2026-10-05" },
      [nahed164],
    ),
    null,
    "a same-named photo of a different size is a different photo — a new phone restarts at IMG_0001",
  );

  // What must pass.
  assert.equal(findDuplicateTicket({ ...copy320 }, [{ ...ali318, status: "rejected_by_admin" }]), null, "a rejected claim never blocks a proper one");
  assert.equal(findDuplicateTicket({ ...copy320, employeeHrId: "AI-0999" }, [ali318]), null, "another employee's fare is not his");
  assert.equal(
    findDuplicateTicket({ ...copy320, goTicketAmount: 140, otherAmount: 0 }, [ali318]),
    null,
    "a different fare with no parking is a different journey",
  );
  assert.equal(
    findDuplicateTicket({ ...copy320, tripEndDate: "2026-11-04", tripStartDate: "2026-11-04" }, [ali318]),
    null,
    "the same fare on another week is a repeated commute, not a copy",
  );
  assert.equal(
    findDuplicateTicket({ ...copy320, goTicketAmount: 0, otherAmount: 200, returnTicketAmount: 0, toCity: "Tanta" }, [ali318]),
    null,
    "the same parking in another city is another car park",
  );
  assert.equal(findDuplicateTicket(copy320, [ali318], 318), null, "a request re-submitted is not a copy of itself");

  // The approvals screen pairs stored copies, and leaves a rejected row out.
  const flags = flagDuplicateTicketRows([
    { date: "2026-10-28", goTicketAmount: 130, hrId: "AI-0318", otherAmount: 200, returnTicketAmount: 220, status: "accepted", toCity: "Kafr El-Sheikh", tripId: "318" },
    { date: "2026-10-28", goTicketAmount: 130, hrId: "AI-0318", otherAmount: 200, returnTicketAmount: 220, status: "pending", toCity: "Kafr El-Sheikh", tripId: "320" },
    { date: "2026-10-28", goTicketAmount: 130, hrId: "AI-0318", otherAmount: 200, returnTicketAmount: 220, status: "rejected", toCity: "Kafr El-Sheikh", tripId: "321" },
  ]);
  assert.deepEqual(flags.get("318"), ["320"]);
  assert.deepEqual(flags.get("320"), ["318"]);
  assert.equal(flags.has("321"), false, "a rejected row is no copy and is not flagged");

  // ── A READ ticket is claimed once: the same train or bus number on the same day (owner, 2026-11-28, zero
  // leniency, "مفيش فيها تهاون"). Weaam Gweed's two claims, as stored: claim 368 carried Superjet 2244150 twice
  // (two photos of one ticket — different files, so the receipt print never saw it), claim 399 train 976
  // three times (one file, sent again on 23, 24 and 25 Nov).
  const superjet = { fromStation: "سوهاج", matchedTo: "arrival", toStation: "الغردقة", trainNumber: "2244150", travelDate: "2026-11-11" };
  const train976 = { fromStation: "Cairo", matchedTo: "arrival", toStation: "Luxor", trainNumber: "976", travelDate: "2026-11-19" };
  assert.equal(readTicketKey(superjet), "2026-11-11|2244150");
  assert.equal(readTicketKey({ ...train976, trainNumber: "٠٩٧٦" }), "2026-11-19|976", "Arabic digits and a leading zero read as the same number");
  assert.equal(readTicketKey({ ...train976, matchedTo: "not_read" }), null, "a ticket the reader did not read has no identity");
  assert.equal(readTicketKey({ ...train976, trainNumber: "" }), null, "nor one whose number was not read");

  const onClaim368 = [{ name: "image.jpg", scan: superjet, size: 225788 }];
  const rePhoto = sameTicketTwice({ candidates: [{ ...superjet, matchedTo: "departure" }], onThisClaim: onClaim368 });
  assert.ok(rePhoto, "a second photo of the ticket already on the claim is refused, whichever photo it was matched to");
  assert.match(rePhoto.reason, /same ticket \(train or bus number 2244150 on 11 Nov 2026\) already on this claim/);
  assert.ok(sameTicketTwice({ candidates: [train976, train976] }), "the same ticket chosen twice in one upload is refused");
  assert.equal(
    sameTicketTwice({ candidates: [{ ...train976, fromStation: "Luxor", toStation: "Cairo", trainNumber: "981" }], onThisClaim: [{ scan: train976 }] }),
    null,
    "the ticket of the other way — another train — is accepted",
  );
  assert.equal(sameTicketTwice({ candidates: [{ ...train976, matchedTo: "not_read" }], onThisClaim: [{ scan: train976 }] }), null, "an unread ticket is left to the approver, as everywhere");

  // On another live claim of hers: refused whatever the amounts or the dates of the two trips say.
  const weaam399: DuplicateTicketExisting = {
    employeeHrId: "AI-0013",
    goTicketAmount: 429,
    id: 399,
    readTickets: [{ name: "IMG_9772.jpg", scan: train976, size: 515199 }],
    returnTicketAmount: 520,
    status: "submitted",
    tripStartDate: "2026-11-19",
  };
  const reused = findDuplicateTicket({ employeeHrId: "ai-0013", readTickets: [train976], tripStartDate: "2026-11-20" }, [weaam399]);
  assert.deepEqual(reused?.repeats, ["read_ticket"], "train 976 of 19 Nov on a new claim repeats claim 399");
  assert.match(duplicateTicketMessage(reused!), /the same ticket \(the same train or bus number on the same day\) already claimed on OUTSTATION-399/);
  assert.equal(findDuplicateTicket({ employeeHrId: "AI-0013", readTickets: [train976], tripStartDate: "2026-11-20" }, [{ ...weaam399, status: "rejected_by_admin" }]), null, "a rejected claim paid nothing, so its ticket may be claimed properly");
  assert.equal(findDuplicateTicket({ employeeHrId: "AI-0013", readTickets: [{ ...train976, travelDate: "2026-11-26" }], tripStartDate: "2026-11-26" }, [weaam399]), null, "the same train another day is another ticket");
  assert.equal(findDuplicateTicket({ employeeHrId: "AI-0999", readTickets: [train976], tripStartDate: "2026-11-19" }, [weaam399]), null, "another employee on the same train holds her own ticket");
  const readFlags = flagDuplicateTicketRows([
    { date: "2026-11-19", goTicketAmount: 429, hrId: "AI-0013", readTickets: [{ scan: train976 }], returnTicketAmount: 520, status: "submitted", tripId: "399" },
    { date: "2026-11-20", goTicketAmount: 100, hrId: "AI-0013", readTickets: [{ scan: train976 }], returnTicketAmount: 0, status: "submitted", tripId: "410" },
  ]);
  assert.deepEqual(readFlags.get("410"), ["399"], "the desk flags a stored pair that shares a read ticket");

  // Asked at the pick, at the submit and at the late upload — never a claim rejected by it.
  const scanRoute = read("app/api/outstation/ticket-scan/route.ts");
  assert.ok(scanRoute.includes("await readTicketReuseRefusal({"), "the ticket-scan route refuses a reused ticket at the pick");
  const serviceSource = read("src/lib/outstation/service.ts");
  const mainSubmitAt = serviceSource.indexOf("export async function submitOutstationRequest(");
  const mainScanAt = serviceSource.indexOf("trainTicketScans = await checkTrainTicketsOnServer(", mainSubmitAt);
  const mainReuseAt = serviceSource.indexOf("await assertReadTicketsNotReused({", mainScanAt);
  const mainUploadAt = serviceSource.indexOf("uploadedTicketAttachments = await uploadOutstationTicketAttachments(", mainSubmitAt);
  assert.ok(mainScanAt > 0 && mainReuseAt > mainScanAt && mainUploadAt > mainReuseAt, "the submit refuses a reused ticket after it is read and before it is stored");
  const attachAt = serviceSource.indexOf("export async function attachMissingTicketsToOwnOutstationRequest(");
  const attachReuseAt = serviceSource.indexOf("await assertReadTicketsNotReused({", attachAt);
  const attachUploadAt = serviceSource.indexOf("const uploaded = await uploadOutstationTicketAttachments(", attachAt);
  assert.ok(attachAt > 0 && attachReuseAt > attachAt && attachUploadAt > attachReuseAt, "the late upload refuses a reused ticket before it is stored");

  // The service refuses BEFORE any file is stored, on both submit paths.
  const service = read("src/lib/outstation/service.ts");
  const submitAt = service.indexOf("export async function submitOutstationRequest(");
  const guardAt = service.indexOf("await assertNoDuplicateTicket({", submitAt);
  const uploadAt = service.indexOf("uploadedTicketAttachments = await uploadOutstationTicketAttachments(", submitAt);
  assert.ok(submitAt > 0 && guardAt > submitAt && uploadAt > guardAt, "submitOutstationRequest refuses a copied ticket before the tickets are uploaded");
  const simpleAt = service.indexOf("export async function submitMedicalRepSimpleExpenseRequest(");
  assert.ok(simpleAt > 0 && service.indexOf("await assertNoDuplicateTicket({", simpleAt) > simpleAt, "the medical rep's simple claim is guarded too");
  // The approvals desk words the pair: the queue asks the one guard, the check says whose claim it repeats.
  const deskQueue = read("src/lib/outstation/approvals/queue.ts");
  assert.ok(deskQueue.includes("const tickets = flagDuplicateTicketRows("), "the approvals desk asks the one ticket guard");
  assert.ok(
    read("src/lib/outstation/approvals/checks.ts").includes('return check("duplicate", "fail", `Repeats a ticket, cost or receipt of ${facts.duplicateTickets.join(", ")}.`);'),
    "and the approvals screen shows the pair, as a failed check that sends the claim to Your call",
  );

  // ═══ 2 · A departure photo after the trip's last day is refused ═════════════════════════════════
  assert.equal(isWithinDepartureWindow({ capturedAt: "2026-10-23T08:00:00.000Z", tripEndDate: "2026-10-22" }), false);
  const closed = departurePhotoWindowClosedMessage("2026-10-22");
  assert.ok(closed.includes("can only be taken") && closed.includes("2026-10-22") && closed.includes("HR can release"), "the first capture's refusal");
  assert.ok(departurePhotoWindowClosedMessage("2026-10-22", true).includes("can only be retaken"), "the retake's refusal");
  assert.ok(
    /const stillOpen = isWithinDepartureWindow\(\{[\s\S]{0,120}\}\);\s*if \(!stillOpen\) \{\s*throw new Error\(departurePhotoWindowClosedMessage\(/.test(service),
    "the window is checked for EVERY capture, not only inside a retake branch",
  );
  assert.ok(!/if \(isRetake\) \{\s*const stillOpen/.test(service), "the window must not go back to binding a retake only");
  assert.ok(
    /canCaptureDeparturePhoto:\s*gate\.blocker === "departure_photo" &&\s*isWithinDepartureWindow\(/.test(service),
    "My submissions offers the camera only while the window is open",
  );
  assert.ok(service.includes("windowClosed: !isWithinDepartureWindow("), "the pending card is told the window closed");
  const card = read("src/components/outstation/departure-photo-card.tsx");
  assert.ok(card.includes("!done && !request.windowClosed"), "a closed card shows no camera button");
  assert.ok(card.includes("so the departure photo can no longer be taken"), "a closed card says why, in words");

  // ═══ 3 · An uploaded arrival photo carries its own time ════════════════════════════════════════
  assert.equal(
    readPhotoFileTakenAt(exifJpeg({ dateTimeOriginal: "2026:01:15 08:30:00" })),
    "2026-01-15T06:30:00.000Z",
    "a time with no offset is the phone's wall clock in Cairo (UTC+2 in January)",
  );
  assert.equal(
    readPhotoFileTakenAt(exifJpeg({ dateTimeOriginal: "2026:10:15 08:30:00", offset: "+03:00", bigEndian: true })),
    "2026-10-15T05:30:00.000Z",
    "the file's own offset is honoured, big-endian TIFF included",
  );
  assert.equal(
    readPhotoFileTakenAt(exifJpeg({ dateTime: "2026:01:15 09:00:00" })),
    "2026-01-15T07:00:00.000Z",
    "with no DateTimeOriginal the file's DateTime is used",
  );
  assert.equal(readPhotoFileTakenAt(exifJpeg({ dateTimeOriginal: "0000:00:00 00:00:00" })), null, "a clock never set is no time");
  assert.equal(readPhotoFileTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), null, "a PNG screenshot carries no time");
  assert.equal(readPhotoFileTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9])), null, "a JPEG with no EXIF carries no time");
  assert.equal(readPhotoFileTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45])), null, "a broken file never throws");
  assert.equal(exifDateTimeToIso("2026:02:30 10:00:00"), null, "an impossible day is no time");

  assert.ok(photoFileTimeCaption("2026-01-15T06:30:00.000Z", () => "15 Jan 2026 08:30 (Cairo)").includes("Photo's own time: 15 Jan 2026"));
  assert.ok(photoFileTimeCaption(null, () => "x").includes("not in the file"), "the watermark says when the file has no time");

  const upload = (fileTakenAt?: unknown, source = "upload") =>
    parseCarEvidenceMetadata({
      carEvidenceMetadata: { capturedAt: "2026-10-15T19:21:00.000Z", capturedLatitude: 30.05, capturedLongitude: 31.33, employeeHrId: "MR-0260", fileTakenAt, source },
    });
  assert.equal(upload("2026-10-10T07:00:00Z")?.fileTakenAt, "2026-10-10T07:00:00.000Z", "an upload keeps the file's own time");
  assert.equal(upload("not a time")?.fileTakenAt, null, "a value that is not a time is dropped");
  assert.equal(upload("2026-10-10T07:00:00Z", "live_camera")?.fileTakenAt, undefined, "a live capture carries no file time — the shutter is its time");

  assert.equal(uploadedArrivalSourceNote(undefined), "Uploaded, not captured with the live camera.", "a claim filed before the file was read claims nothing about it");
  assert.ok(uploadedArrivalSourceNote(null).includes("carries no time of its own"));
  const dated = uploadedArrivalSourceNote("2026-01-15T06:30:00.000Z");
  assert.ok(dated.includes("The file says it was taken at") && dated.includes("8:30 AM"), "the approver reads the file's own time in Cairo");

  const wizard = read("src/components/outstation/mobile-outstation-wizard.tsx");
  const readAt = wizard.indexOf("readPhotoFileTakenAt(await file.arrayBuffer())");
  const drawAt = wizard.indexOf("context.drawImage(image, 0, 0, canvas.width, canvas.height);", readAt);
  assert.ok(readAt > 0 && drawAt > readAt, "the file's time is read BEFORE the canvas re-encode drops it");
  assert.ok(wizard.includes("photoFileTimeCaption(fileTakenAt, formatEvidenceDateTimeStamp)"), "the upload's watermark carries the file's own time");
}
