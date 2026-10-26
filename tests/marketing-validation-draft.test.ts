import { strict as assert } from "node:assert";

import {
  describeRestoredDraft,
  describeUnsendableQueue,
  isCaptureEvidenceFresh,
  isDraftWorthKeeping,
  MARKETING_DRAFT_EVIDENCE_MAX_AGE_MS,
  MARKETING_DRAFT_VERSION,
  parseStoredDraft,
  restoreDraft,
  stripExpiredEvidence,
  type DraftCustomer,
} from "../src/lib/marketing-requests/validation-draft.ts";
import { evidenceStatusFromInput } from "../src/lib/marketing-requests/service.ts";

const NOW = Date.parse("2026-08-23T18:00:00.000Z");
const MINUTES_AGO = new Date(NOW - 5 * 60 * 1000).toISOString();
const YESTERDAY = new Date(NOW - 26 * 60 * 60 * 1000).toISOString();

const jpeg = `data:image/jpeg;base64,${Buffer.from("a-real-jpeg-frame").toString("base64")}`;

function emptyCapture() {
  return {
    accuracy: null as number | null,
    address: "",
    capturedAt: null as string | null,
    latitude: null as number | null,
    longitude: null as number | null,
    locationLines: [] as string[],
    photoCapturedAt: null as string | null,
    photoDataUrl: null as string | null,
    photoName: "",
  };
}

/**
 * A capture in the shape the workspace holds it, complete enough to reach `system_validated`.
 *
 * `null` yields a genuinely untouched capture rather than coordinates with no timestamp — the form
 * writes `capturedAt` in the same step it writes the fix, so a lat/long without a stamp is a state
 * the real UI cannot produce and a fixture that invents it tests nothing.
 */
function capture(stamp: string | null) {
  if (!stamp) return emptyCapture();
  return {
    accuracy: 12 as number | null,
    address: "44JC+6P9, Kafr Selim, Kafr El Dawwar, Beheira Governorate",
    capturedAt: stamp as string | null,
    latitude: 31.1303563 as number | null,
    longitude: 30.1226590 as number | null,
    locationLines: ["Kafr Selim", "Beheira"],
    photoCapturedAt: stamp as string | null,
    photoDataUrl: jpeg as string | null,
    photoName: "customer-live.jpg",
  };
}

/** GPS fixed, photo not taken yet — the real state between pressing Locate and opening the camera. */
function locationOnlyCapture(stamp: string) {
  return { ...capture(stamp), photoCapturedAt: null, photoDataUrl: null, photoName: "" };
}

function customer(stamp: string | null, name = "احمد محارب") {
  return {
    area: "Kafr El Dawar",
    capture: capture(stamp),
    governorate: "Beheira",
    mobile: "01000000000",
    name,
    pharmacies: [
      { capture: capture(stamp), name: "صيدلية النيل", vendorCodes: [{ distributorCode: "376057" }] },
    ],
  };
}

function draft(customers: ReturnType<typeof customer>[], overrides: Partial<{ ownerHrId: string; savedAt: string }> = {}) {
  return {
    customers,
    onBehalfHrId: "",
    ownerHrId: overrides.ownerHrId ?? "A-10",
    savedAt: overrides.savedAt ?? new Date(NOW - 60 * 1000).toISOString(),
    version: MARKETING_DRAFT_VERSION,
  };
}

export async function runMarketingValidationDraftTests() {
  /* ----------------------------------------------------------------------
   * THE HEADLINE. A restored capture must never be able to claim a visit
   * that did not happen today. This is the reason the module exists in the
   * shape it does, so it is asserted against the REAL server gate rather
   * than against a local re-implementation of it.
   * -------------------------------------------------------------------- */

  const stale = stripExpiredEvidence([customer(YESTERDAY)], NOW);
  const staleCustomer = stale.customers[0];

  assert.equal(
    evidenceStatusFromInput({
      capturedAt: staleCustomer.capture.capturedAt,
      capturedLatitude: staleCustomer.capture.latitude,
      capturedLongitude: staleCustomer.capture.longitude,
      evidenceHasTimestamp: Boolean(staleCustomer.capture.photoCapturedAt),
      evidencePhotoCapturedAt: staleCustomer.capture.photoCapturedAt,
      evidencePhotoDataUrl: staleCustomer.capture.photoDataUrl,
      evidencePhotoName: staleCustomer.capture.photoName || null,
    }),
    "missing",
    "a capture restored from yesterday must reach the server as NO evidence — the server grants system_validated on the presence of a photo and never checks its age, so anything less than a full strip lets a draft launder a stale visit into the validated customer list",
  );

  // ...while the typing it was attached to survives, which is the whole point of recovering at all.
  assert.equal(staleCustomer.name, "احمد محارب", "the customer's name must survive an evidence strip");
  assert.equal(staleCustomer.area, "Kafr El Dawar", "the typed area must survive an evidence strip");
  assert.equal(staleCustomer.pharmacies[0].name, "صيدلية النيل", "the pharmacy name must survive an evidence strip");
  assert.equal(
    staleCustomer.pharmacies[0].vendorCodes[0].distributorCode,
    "376057",
    "distributor codes must survive an evidence strip — retyping them is the tedious half of the work",
  );
  assert.deepEqual(stale.expiredEvidenceFor, ["احمد محارب"], "the rep must be told WHICH customer needs photographing again");

  /* ---------------------------------------- Fresh evidence is kept ---------------------------------------- */

  const fresh = stripExpiredEvidence([customer(MINUTES_AGO)], NOW);
  assert.equal(fresh.customers[0].capture.photoDataUrl, jpeg, "a capture from five minutes ago must be restored intact");
  assert.equal(fresh.customers[0].capture.latitude, 31.1303563, "a fresh GPS fix must be restored intact");
  assert.deepEqual(fresh.expiredEvidenceFor, [], "nothing to warn about when the evidence is fresh");

  assert.equal(
    evidenceStatusFromInput({
      capturedAt: fresh.customers[0].capture.capturedAt,
      capturedLatitude: fresh.customers[0].capture.latitude,
      capturedLongitude: fresh.customers[0].capture.longitude,
      evidenceHasTimestamp: true,
      evidencePhotoCapturedAt: fresh.customers[0].capture.photoCapturedAt,
      evidencePhotoDataUrl: fresh.customers[0].capture.photoDataUrl,
      evidencePhotoName: fresh.customers[0].capture.photoName,
    }),
    "complete",
    "recovery must not damage a capture that is still valid — otherwise the rep re-photographs a shop he is standing in front of",
  );

  /* ---------------------------------------- The window boundary ---------------------------------------- */

  const justInside = new Date(NOW - (MARKETING_DRAFT_EVIDENCE_MAX_AGE_MS - 60_000)).toISOString();
  const justOutside = new Date(NOW - (MARKETING_DRAFT_EVIDENCE_MAX_AGE_MS + 60_000)).toISOString();
  assert.equal(isCaptureEvidenceFresh(capture(justInside), NOW), true, "a minute inside the window is still evidence");
  assert.equal(isCaptureEvidenceFresh(capture(justOutside), NOW), false, "a minute outside the window is not");

  assert.equal(
    isCaptureEvidenceFresh(capture(new Date(NOW + 60 * 60 * 1000).toISOString()), NOW),
    false,
    "a timestamp from the future is a wrong device clock, not fresh evidence",
  );

  // Mid-capture: the fix is in, the camera has not opened yet. `capturedAt` is the only stamp there
  // is, and it must still both preserve a fresh half-capture and age out a stale one.
  assert.equal(
    isCaptureEvidenceFresh(locationOnlyCapture(MINUTES_AGO), NOW),
    true,
    "a fresh GPS fix with no photo yet must survive a reload — otherwise the rep loses the pin he just took",
  );
  assert.equal(
    isCaptureEvidenceFresh(locationOnlyCapture(YESTERDAY), NOW),
    false,
    "a GPS fix ages out on its own stamp — a location-only capture must not live forever waiting for a photo",
  );
  assert.equal(
    isCaptureEvidenceFresh({ ...capture(MINUTES_AGO), capturedAt: "not-a-date", photoCapturedAt: "not-a-date" }, NOW),
    false,
    "an unreadable stamp must count as expired — a stamp we cannot read is not one we may vouch for",
  );

  /* ---------------------------------------- A draft belongs to one person ---------------------------------------- */

  assert.equal(
    restoreDraft({ draft: draft([customer(MINUTES_AGO)]), nowMs: NOW, viewerHrId: "B-177" }),
    null,
    "field phones are shared — one rep must never be offered another rep's half-built capture to save under his own name",
  );
  assert.equal(
    restoreDraft({ draft: draft([customer(MINUTES_AGO)]), nowMs: NOW, viewerHrId: "" }),
    null,
    "an unidentified viewer gets nothing back",
  );
  assert.ok(
    restoreDraft({ draft: draft([customer(MINUTES_AGO)]), nowMs: NOW, viewerHrId: "a-10" }),
    "hr ids compare case-insensitively — the directory stores both casings",
  );

  /* ---------------------------------------- Whole-draft expiry ---------------------------------------- */

  assert.equal(
    restoreDraft({
      draft: draft([customer(MINUTES_AGO)], { savedAt: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString() }),
      nowMs: NOW,
      viewerHrId: "A-10",
    }),
    null,
    "a draft older than the retention window is not offered at all",
  );

  // A day-old draft still has its typing offered back, with the evidence stripped out of it.
  const yesterdayRestore = restoreDraft({
    draft: draft([customer(YESTERDAY)], { savedAt: YESTERDAY }),
    nowMs: NOW,
    viewerHrId: "A-10",
  });
  assert.ok(yesterdayRestore, "a day-old draft is still worth offering for its typing");
  assert.equal(yesterdayRestore.customers[0].capture.photoDataUrl, null, "but never with its photo");
  assert.deepEqual(yesterdayRestore.expiredEvidenceFor, ["احمد محارب"]);

  /* ---------------------------------------- Nothing worth keeping ---------------------------------------- */

  const pristine: DraftCustomer[] = [
    { capture: emptyCapture(), name: "", pharmacies: [{ capture: emptyCapture(), name: "" }] },
  ];
  assert.equal(
    isDraftWorthKeeping(pristine),
    false,
    "an untouched form must not be stored — otherwise every visit to the page leaves a draft and the recovery banner fires on nothing, which teaches people to ignore it",
  );
  assert.equal(isDraftWorthKeeping([customer(null, "احمد")]), true, "a typed name alone is worth keeping");
  assert.equal(isDraftWorthKeeping([customer(MINUTES_AGO, "")]), true, "a capture with no name yet is worth keeping");

  assert.equal(
    restoreDraft({
      draft: draft([{ ...customer(null), name: "", pharmacies: [{ capture: emptyCapture(), name: "", vendorCodes: [] }] }]),
      nowMs: NOW,
      viewerHrId: "A-10",
    }),
    null,
    "a draft that strips down to nothing is not offered",
  );

  // A pharmacy name alone still counts: it is typing the rep would otherwise redo.
  assert.equal(
    isDraftWorthKeeping([{ ...customer(null), name: "" }]),
    true,
    "a named pharmacy under an unnamed customer is still work worth recovering",
  );

  /* ---------------------------------------- Stored shape ---------------------------------------- */

  assert.equal(parseStoredDraft(null), null);
  assert.equal(parseStoredDraft("nonsense"), null);
  assert.equal(
    parseStoredDraft({ ...draft([customer(MINUTES_AGO)]), version: MARKETING_DRAFT_VERSION + 1 }),
    null,
    "a draft written by a different build is discarded, never migrated — mis-reading an old shape could put wrong coordinates on a record that claims to be evidence",
  );
  assert.equal(parseStoredDraft({ ...draft([customer(MINUTES_AGO)]), ownerHrId: "" }), null, "a draft with no owner is unusable");
  assert.equal(parseStoredDraft({ ...draft([]), customers: [] }), null, "an empty draft is nothing to restore");
  assert.equal(
    parseStoredDraft({ ...draft([customer(MINUTES_AGO)]), customers: [{ name: "x" }] }),
    null,
    "a customer with no capture block is a shape we do not understand",
  );
  assert.ok(parseStoredDraft(draft([customer(MINUTES_AGO)])), "a well-formed draft parses");

  /* ---------------------------------------- What the rep is told ---------------------------------------- */

  const cleanNotice = describeRestoredDraft({
    customers: [customer(MINUTES_AGO)],
    expiredEvidenceFor: [],
    onBehalfHrId: "",
    savedAt: MINUTES_AGO,
  });
  assert.match(cleanNotice, /Recovered an unsaved capture/, "one customer reads in the singular");
  assert.ok(!cleanNotice.includes("too old"), "no expiry warning when nothing expired");

  const expiredNotice = describeRestoredDraft({
    customers: [customer(YESTERDAY), customer(YESTERDAY, "احمد بحيري")],
    expiredEvidenceFor: ["احمد محارب", "احمد بحيري"],
    onBehalfHrId: "",
    savedAt: YESTERDAY,
  });
  assert.match(expiredNotice, /2 unsaved captures/, "two customers read in the plural");
  assert.match(
    expiredNotice,
    /احمد محارب, احمد بحيري/,
    "the customers needing a fresh photo are named — a rep cannot act on a count",
  );
  assert.match(expiredNotice, /take them again before saving/, "the banner says what to do, not just what went wrong");

  const unnamed = stripExpiredEvidence([customer(YESTERDAY, "   ")], NOW);
  assert.deepEqual(
    unnamed.expiredEvidenceFor,
    ["an unnamed customer"],
    "a capture taken before the name was typed still has to be reported, not silently skipped",
  );

  // The offline queue's banner. An entry with no owner was refused for that reason alone — the live
  // check of 26 Oct 2026 found a fresh one reported as "too old", which sent a rep to re-shoot a
  // photo for the wrong reason.
  assert.equal(describeUnsendableQueue({ noOwner: 0, tooOld: 0 }), null, "nothing unsendable, no banner");
  const ownerless = describeUnsendableQueue({ noOwner: 1, tooOld: 0 }) ?? "";
  assert.doesNotMatch(ownerless, /too old/, "an entry with no owner is never said to be too old");
  assert.match(ownerless, /^1 offline submission on this device was saved without the name of the person who saved it/, "it says the owner is missing");
  assert.match(ownerless, /If it was yours, capture it again.$/, "and what to do about it");
  const aged = describeUnsendableQueue({ noOwner: 0, tooOld: 2 }) ?? "";
  assert.match(aged, /^2 offline submissions were waiting to sync, but the live photo and location on them are now too old/, "the viewer's own aged entries keep their reason");
  assert.doesNotMatch(aged, /without the name/, "and are not called ownerless");
  const both = describeUnsendableQueue({ noOwner: 2, tooOld: 1 }) ?? "";
  assert.match(both, /^1 offline submission was waiting to sync, .* on it are now too old .* Capture it again. 2 offline submissions on this device were saved without the name of the person who saved them, so they cannot be sent under anyone's name. If they were yours, capture them again.$/, "both reasons, each with its own count");
}
