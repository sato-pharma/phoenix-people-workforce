import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ticketTileKind, ticketTileLabel } from "../src/lib/outstation/ticket-tile.ts";
import { approverTripPhotos } from "../src/lib/outstation/trip-evidence-photos.ts";
import type { OutstationDepartureEvidenceMetadata } from "../src/lib/outstation/types.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The outstation approver must see BOTH photos, the arrival and the departure.
//
// Owner report (2026-09-18): "The system administrator, he is the approver for the outstation
// expenses and now he can't see any of the photos. You must make him able to see the both
// photos." The Super Admin is the one approver (canDecideOutstationExpenseApprovals). Neither of
// his screens could show the departure photo: no admin read path ever signed
// departure_evidence_image_path, so its review (the "taken far from the trip" flag, which only
// works if a human reads it) had been visible to the employee alone. And Expense Approvals showed
// the arrival photo as one 160px cropped tile labelled "Car evidence".
//
// Production on the day: 115 requests, 75 with an arrival photo, 48 with a departure photo that
// no approver screen could display.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE = "src/lib/outstation/service.ts";
const ATTACHMENTS_ROUTE = "app/api/admin/outstation/[id]/attachments/route.ts";
const TRIP_ATTACHMENTS = "src/components/outstation/trip-attachments.tsx";
const EXPENSE_CENTER = "src/components/outstation/outstation-requests-admin.tsx";
const PHOTOS_COMPONENT = "src/components/outstation/trip-evidence-photos.tsx";
const PHOTOS_MODULE = "src/lib/outstation/trip-evidence-photos.ts";

const code = (path: string) => stripComments(readFileSync(path, "utf8"));

/** The body of a top-level function, from its signature to the first column-0 closing brace. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} was not found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${signature} has no closing brace`);
  return source.slice(start, end);
}

const ARRIVAL_URL = "https://storage.example/arrival.jpg?token=a";
const DEPARTURE_URL = "https://storage.example/departure.jpg?token=d";

function departureMeta(overrides: Partial<OutstationDepartureEvidenceMetadata> = {}): OutstationDepartureEvidenceMetadata {
  return {
    capturedAt: "2026-09-01T14:30:00.000Z",
    capturedLatitude: 31.2,
    capturedLocationLabel: "Mahatet El Raml, Alexandria",
    capturedLongitude: 29.9,
    distanceFromArrivalKm: 0.4,
    flags: [],
    minutesAfterArrival: 201,
    source: "live_camera",
    summary: "Departure photo captured 0.4 km from the arrival photo, 201 minute(s) after it.",
    version: 1,
    ...overrides,
  };
}

const BOTH = {
  carEvidenceImagePath: "requests/112/arrival.jpg",
  carEvidenceImageUrl: ARRIVAL_URL,
  carEvidenceMetadata: {
    capturedAt: "2026-09-01T11:09:00.000Z",
    capturedLatitude: 31.203317,
    capturedLocationLabel: "Mahatet El Raml, Alex Center",
    capturedLongitude: 29.903411,
    employeeHrId: "EMP-1",
    requestDraftId: null,
    requestId: "112",
    source: "live_camera" as const,
  },
  departureEvidenceImagePath: "requests/112/departure.jpg",
  departureEvidenceImageUrl: DEPARTURE_URL,
  departureEvidenceMetadata: departureMeta(),
  employeeRole: "Medical Rep",
  evidenceGateStatus: "complete" as const,
};

const notTakenPosition = () =>
  approverTripPhotos({ ...BOTH, departureEvidenceImagePath: null, departureEvidenceImageUrl: null, departureEvidenceMetadata: null })[1];

export function runOutstationApproverTripPhotosTests() {
  // ── 1. The headline: the departure photo reaches the approver ──────────────
  const [arrival, departure] = approverTripPhotos(BOTH);
  assert.equal(departure.url, DEPARTURE_URL, "the approver must be handed the departure photo, not the arrival alone");
  assert.equal(arrival.url, ARRIVAL_URL);
  assert.deepEqual([arrival.kind, departure.kind], ["arrival", "departure"], "arrival first, then departure");
  assert.deepEqual([arrival.label, departure.label], ["Arrival photo", "Departure photo"]);
  assert.equal(departure.review, BOTH.departureEvidenceMetadata.summary, "the stored departure review is shown with it");
  assert.equal(departure.locationLabel, "Mahatet El Raml, Alexandria");
  assert.equal(arrival.locationLabel, "Mahatet El Raml, Alex Center");
  assert.equal(departure.capturedAt, "2026-09-01T14:30:00.000Z");
  assert.equal(departure.isFlagged, false);
  assert.equal(arrival.missingNote, null);
  assert.equal(departure.missingNote, null);
  assert.equal(arrival.sourceNote, null);
  // The captured position travels with the photo (2026-11-07: the trip page pins both photos on
  // its one map and prints the GPS under each card).
  assert.deepEqual([arrival.latitude, arrival.longitude], [31.203317, 29.903411], "the arrival photo carries its captured GPS");
  assert.deepEqual([departure.latitude, departure.longitude], [31.2, 29.9], "and so does the departure photo");
  assert.equal(notTakenPosition().latitude, null, "no photo, no position");

  // ── 2. A flag is carried, and it is a look, never a block ──────────────────
  const flagged = approverTripPhotos({
    ...BOTH,
    departureEvidenceMetadata: departureMeta({
      distanceFromArrivalKm: 212,
      flags: ["far_from_arrival"],
      summary: "Review: departure photo 212 km from the arrival photo, 201 minute(s) after it — taken well away from where the trip was.",
    }),
  })[1];
  assert.equal(flagged.isFlagged, true);
  assert.match(flagged.review ?? "", /212 km/);

  // ── 3. A missing photo is said in words, and the words are true ────────────
  const unsigned = approverTripPhotos({ ...BOTH, departureEvidenceImageUrl: null })[1];
  assert.equal(unsigned.url, null);
  assert.match(unsigned.missingNote ?? "", /on file but could not be opened/);

  const notTaken = approverTripPhotos({ ...BOTH, departureEvidenceImagePath: null, departureEvidenceImageUrl: null, departureEvidenceMetadata: null })[1];
  assert.equal(notTaken.missingNote, "No departure photo has been taken.");
  assert.equal(notTaken.review, null);
  assert.equal(notTaken.isFlagged, false);

  const waived = approverTripPhotos({ employeeRole: " product manager ", evidenceGateStatus: "complete" });
  assert.equal(waived[0].missingNote, "Not required: this role owes no trip photos.", "a waived role owes no photo, so none is missing");
  assert.equal(waived[1].missingNote, "Not required: this role owes no trip photos.");

  const preRule = approverTripPhotos({ employeeRole: "Medical Rep", evidenceGateStatus: "grandfathered" });
  assert.equal(preRule[1].missingNote, "Not required: submitted before the two-photo rule.");

  // ── 4. Retakes and uploads are told to the approver ────────────────────────
  assert.equal(approverTripPhotos({ ...BOTH, departureEvidenceMetadata: departureMeta({ version: 3 }) })[1].retakeCount, 2);
  assert.equal(approverTripPhotos({ ...BOTH, departureEvidenceMetadata: departureMeta({ version: undefined }) })[1].retakeCount, 0);
  const uploaded = approverTripPhotos({ ...BOTH, carEvidenceMetadata: { ...BOTH.carEvidenceMetadata, source: "upload" } })[0];
  assert.match(uploaded.sourceNote ?? "", /not captured with the live camera/);

  // ── 5. Both admin read paths sign the departure photo ──────────────────────
  const service = code(SERVICE);
  for (const signature of ["async function attachCarEvidenceSignedUrls(", "export async function getOutstationRequestById("]) {
    const body = functionBody(service, signature);
    assert.match(
      body,
      /createOutstationCarEvidenceSignedUrl\(request\.departureEvidenceImagePath\)/,
      `${signature} must sign the departure photo, or no approver screen can show it`,
    );
    assert.match(body, /departureEvidenceImageUrl,/, `${signature} must return the signed departure URL`);
  }

  // ── 6. Expense Approvals, where the approve and reject buttons are ─────────
  const route = code(ATTACHMENTS_ROUTE);
  assert.match(route, /photos: approverTripPhotos\(requestRow\)/, "the attachments route must send both photos");
  assert.match(route, /departureEvidenceImageUrl: requestRow\.departureEvidenceImageUrl/);
  assert.match(route, /assertOutstationAdminAccess\(access, "approve"\)/, "the photos stay behind the approver's own gate");

  const tripAttachments = code(TRIP_ATTACHMENTS);
  assert.match(tripAttachments, /<TripEvidencePhotos\b/, "Expense Approvals must render both photos");
  assert.doesNotMatch(tripAttachments, /Car evidence/, "the arrival photo is needed on every trip, not only a car trip");
  assert.doesNotMatch(tripAttachments, /\btruncate\b/, "never truncate a label with an ellipsis");
  assert.doesNotMatch(tripAttachments, /\brounded(-|\b)/, "square edges only");

  // ── 7. The Expense Center request panel ────────────────────────────────────
  const expenseCenter = code(EXPENSE_CENTER);
  assert.match(expenseCenter, /<TripEvidencePhotos\b/, "the Expense Center panel must render both photos");
  assert.match(expenseCenter, /approverTripPhotos\(request\)/);
  assert.doesNotMatch(expenseCenter, /<img\b/, "a photo there must open in the shared zoom viewer");

  // ── 8. The shared component and module ─────────────────────────────────────
  const component = code(PHOTOS_COMPONENT);
  assert.match(component, /<ZoomablePhoto\b/);
  assert.match(component, /object-contain/, "the approver sees the whole frame, never a crop");
  assert.doesNotMatch(component, /object-cover/);
  assert.match(component, /photo\.review/, "the departure review is shown under the photo");
  assert.match(component, /never blocks payment/, "a flag asks for a look; the owner's rule says so on screen");
  assert.doesNotMatch(component, /\btruncate\b/, "never truncate with an ellipsis");
  assert.doesNotMatch(component, /\brounded(-|\b)/, "square edges only");
  assert.doesNotMatch(component, /min-w-\[|overflow-x-auto/, "the two photos must fit the screen with no sideways scroll");

  const photosModule = code(PHOTOS_MODULE);
  assert.doesNotMatch(
    photosModule,
    /departure-evidence|geo-validate/,
    "the client-side photo module must not pull the sales geo code into the browser bundle",
  );

  // Tickets and receipts (owner's review, 2026-11-07, 5 of 10): a broken thumbnail, a black frame
  // and a raw file name all read as a ticket with nothing to say why.
  assert.equal(ticketTileKind({ contentType: "application/pdf", url: "https://x/t.pdf" }), "pdf");
  assert.equal(ticketTileKind({ contentType: "image/jpeg", url: "https://x/a" }), "image");
  assert.equal(ticketTileKind({ contentType: "", url: "https://x/receipt.PNG?token=1" }), "image");
  assert.equal(ticketTileKind({ contentType: "image/heic", url: "https://x/IMG_0042.HEIC" }), "file", "HEADLINE: an iPhone HEIC is a file tile, never a broken <img>");
  assert.equal(ticketTileKind({ contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", url: "https://x/a" }), "file");
  assert.equal(ticketTileKind({ contentType: "", url: "https://x/scan.docx" }), "file");
  assert.equal(ticketTileKind({ contentType: "", url: "https://x/opaque" }), "image", "unknown stays an image, as before — the load-failure tile catches the rest");
  assert.equal(ticketTileLabel(0), "Ticket 1", "HEADLINE: tickets are numbered, the file name is the tooltip");
  const attachments = code("src/components/outstation/trip-attachments.tsx");
  assert.match(attachments, /onError=\{\(\) => setFailed\(true\)\}/, "HEADLINE: a thumbnail that fails to load says so");
  assert.match(attachments, /Could not load — open the file/, "and offers the file");
  assert.match(attachments, /onLoad=\{\(event\) => setFrame\(measureImageFrame\(event\.currentTarget\)\)\}/, "the ticket frame is measured like the photos");
  assert.match(attachments, /classifyPhotoFrame\(frame\)\.verdict === "no-image"/, "HEADLINE: and a black frame reads Blank image");
  assert.match(attachments, /label=\{ticketTileLabel\(index\)\}/, "the tile label is Ticket N");

  // The pictures a manager uploads (owner, 2026-11-07: "in the expense approvals the photos uploaded
  // from managers I cannot see the photos"). They were on file and signed; the screen buried them.
  assert.match(attachments, /const notOwed = photos\.length > 0 && photos\.every\(\(photo\) => !photo\.url && Boolean\(photo\.missingNote\?\.startsWith\("Not required"\)\)\);/, "HEADLINE: a role that owes no photo gets one line, not two empty boxes");
  assert.match(attachments, /\{anyLivePhoto \? null : uploads\}/, "HEADLINE: with no live photo on file, the uploads come first");
  assert.match(attachments, /large \? "h-72 bg-slate-900" : "h-28 bg-slate-100"\)\} data-turnable-ticket>/, "HEADLINE: each upload shown whole, never a 112px crop");
  assert.match(attachments, /<ZoomablePhoto\b(?:=>|[^>])*?\brotatable\b(?:=>|[^>])*?src=\{url\}/, "HEADLINE: a ticket photographed sideways can be turned upright");
  const photosFile = code("src/components/outstation/trip-evidence-photos.tsx");
  assert.match(photosFile, /<div className="relative h-80 w-full bg-slate-900" data-turnable-photo>\s*<ZoomablePhoto\b(?:=>|[^>])*?\brotatable\b/, "HEADLINE: and so can an arrival or departure photo");
  assert.match(attachments, /const uploads = tickets\.length > 0 \? <UploadedPictures large tickets=\{tickets\} \/> : null;/);
  const signals = code("src/components/outstation/expense-review/review-deck/deck-signals.ts");
  assert.match(signals, /line: `No trip photos owed · \$\{uploaded\} to look at\.`/, "HEADLINE: the findings count the uploads, never hide them behind Not required");
  assert.match(signals, /const withUploads = \(line: string\) =>/, "every photo sentence carries the upload count");
  const fieldWork = code("src/components/outstation/expense-review/review-deck/deck-days.tsx");
  assert.match(fieldWork, /<UploadedPictures large=\{false\} tickets=\{attachments\.tickets\} \/>/, "HEADLINE: and the view the reviewer opens on shows them too");
  assert.doesNotMatch(component, /font-mono/, "no monospace on the photo card");
  assert.match(attachments, /title=\{title\}/, "the stored file name rides in the tooltip");
}
