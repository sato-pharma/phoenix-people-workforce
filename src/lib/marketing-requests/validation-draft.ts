/**
 * Crash/refresh recovery for the field validation form.
 *
 * WHY THIS EXISTS. On 2026-08-23 a Product Manager captured two doctors at one clinic in Kafr
 * Selim. The first saved at 18:00; the second was still on screen when the page was refreshed, and
 * it was gone — not "hard to find", gone. A full-text sweep of every table in production and of the
 * `marketing-evidence` bucket found no trace of it, because the workspace held the entire capture
 * in React state and wrote nothing anywhere until submit. The only recovery was to drive back to
 * the clinic, since a live photo cannot be recreated from a desk.
 *
 * WHAT THIS MUST NOT BECOME. Persisting the form is easy; persisting it SAFELY is the whole
 * problem, because `evidenceStatusFromInput` in service.ts grants `complete` — and therefore
 * `system_validated` — on the mere PRESENCE of a GPS fix and a timestamped photo. It never compares
 * that timestamp to now. Today the only thing stopping a week-old photo being submitted as proof of
 * a visit is that the photo dies with the browser tab. Restore it naively and this module becomes a
 * machine for laundering stale evidence into the validated customer list: a data-loss bug traded
 * for a data-integrity one, which is the worse of the two.
 *
 * So the rules below are the point of this file, not the storage:
 *
 *   1. EVIDENCE EXPIRES, typing does not. A capture (GPS fix + live photo) older than
 *      `MARKETING_DRAFT_EVIDENCE_MAX_AGE_MS` is stripped on restore and the rep is told to take it
 *      again. The Arabic name, the area, the distributor codes and the venue type carry no claim
 *      about where anybody stood, so they survive for `MARKETING_DRAFT_MAX_AGE_MS`. That preserves
 *      the tedious half of the work — which is what was actually lost — while refusing to vouch for
 *      the half that is a factual assertion about a visit.
 *   2. AGE IS MEASURED FROM THE CAPTURE, not from when the draft was written. A draft that is
 *      re-saved on every keystroke would otherwise refresh its own evidence forever.
 *   3. A DRAFT BELONGS TO ONE PERSON. Field phones are shared. A draft records the hr_id that
 *      created it and is refused for anyone else, so one rep can never inherit another's half-built
 *      capture and save it under his own name.
 *
 * Everything here is pure and synchronous. The IndexedDB half lives in `validation-draft-store.ts`;
 * localStorage is not an option because a single evidence photo is allowed up to 2 MB
 * (`MARKETING_EVIDENCE_MAX_UPLOAD_BYTES`) and one submission can carry many.
 */

/**
 * How long a capture stays usable as evidence across a reload.
 *
 * Six hours. Sized from real production captures rather than taste: the two most recent field
 * sessions ran 14:56→15:00 and 13:17→13:32 UTC, so an actual capture is minutes long, and six hours
 * covers a phone lock, a lost signal, a drive between towns and a lunch break while staying far
 * inside the same working day. It is deliberately far too short to span a night, which is the case
 * that matters — a photo restored the next morning would assert a visit that did not happen.
 *
 * One constant, one place. Widening this widens what Phoenix will call proof of a visit.
 */
export const MARKETING_DRAFT_EVIDENCE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** How long the typed half of a draft is offered back. Carries no evidence claim, so it is generous. */
export const MARKETING_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Bumped whenever the persisted shape changes. A draft written by an older build is discarded
 * rather than migrated: the payload is one in-flight form, so throwing it away costs a rep a few
 * minutes of typing, while mis-reading an old shape into the capture fields could put wrong
 * coordinates on a record that claims to be evidence.
 */
export const MARKETING_DRAFT_VERSION = 1;

/**
 * The parts of a capture this module reasons about.
 *
 * Structural on purpose — the workspace's own `CaptureState` carries more (address, accuracy, the
 * burned-in location lines) and satisfies this by having these fields. Keeping the contract minimal
 * means adding a field to the form does not require touching the expiry rules.
 */
export type DraftCapture = {
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  photoCapturedAt: string | null;
  photoDataUrl: string | null;
  photoName: string;
};

export type DraftPharmacy = {
  capture: DraftCapture;
  name: string;
};

export type DraftCustomer = {
  capture: DraftCapture;
  name: string;
  pharmacies: DraftPharmacy[];
};

export type MarketingValidationDraft<TCustomer extends DraftCustomer = DraftCustomer> = {
  customers: TCustomer[];
  /** Whose draft this is. Never restored for a different login. */
  ownerHrId: string;
  /** Desk-mode target, preserved so a Super Admin does not silently re-own a restored capture. */
  onBehalfHrId: string;
  savedAt: string;
  version: number;
};

/** What a restore attempt produced, and what the rep has to be told about it. */
export type MarketingDraftRestore<TCustomer extends DraftCustomer = DraftCustomer> = {
  customers: TCustomer[];
  /** Names of customers whose GPS + photo were dropped because they aged out. */
  expiredEvidenceFor: string[];
  onBehalfHrId: string;
  savedAt: string;
};

function isFilled(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** A capture is "started" once any part of the evidence pair exists. */
export function hasCaptureEvidence(capture: DraftCapture): boolean {
  return (
    capture.latitude !== null ||
    capture.longitude !== null ||
    isFilled(capture.capturedAt) ||
    isFilled(capture.photoDataUrl) ||
    isFilled(capture.photoCapturedAt) ||
    isFilled(capture.photoName)
  );
}

/**
 * When this capture's evidence was taken.
 *
 * The PHOTO timestamp wins when both exist, because the photo is the thing a person could stage;
 * a GPS fix without a photo can never reach `complete` on its own. Falling back to `capturedAt`
 * means a location-only capture still ages out rather than living forever.
 */
function capturedAtMs(capture: DraftCapture): number | null {
  for (const stamp of [capture.photoCapturedAt, capture.capturedAt]) {
    if (!isFilled(stamp)) continue;
    const parsed = Date.parse(stamp as string);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Whether this capture may still be presented as evidence of a visit.
 *
 * An unparseable or absent timestamp on a capture that HAS evidence counts as expired. A stamp we
 * cannot read is not a stamp we may vouch for, and the cost of being wrong is asymmetric: refusing
 * a good photo costs one retake, accepting a bad one puts a false `system_validated` customer into
 * the marketing request list where sales get attributed against it.
 */
export function isCaptureEvidenceFresh(capture: DraftCapture, nowMs: number): boolean {
  const takenAt = capturedAtMs(capture);
  if (takenAt === null) return false;
  const age = nowMs - takenAt;
  // A stamp from the future is a wrong clock, not fresh evidence.
  if (age < 0) return false;
  return age <= MARKETING_DRAFT_EVIDENCE_MAX_AGE_MS;
}

/**
 * Blank every evidence field, leaving the record itself intact so the typing survives.
 *
 * The three conditional keys are the workspace's own extras (`CaptureState` carries an address, an
 * accuracy and the burned-in location lines). They are cleared when present rather than named in
 * `DraftCapture`, because they are display detail rather than something the expiry rules reason
 * about — but leaving a stale street address on screen beside a blank photo would read as if the
 * capture were still half-valid.
 *
 * The cast is the standard escape for widening a generic: TypeScript cannot prove that a spread of
 * `T` plus these keys is still exactly `T`, though every field written here is declared on
 * `DraftCapture` and therefore present on every `T`.
 */
function clearedCapture<T extends DraftCapture>(capture: T): T {
  return {
    ...capture,
    capturedAt: null,
    latitude: null,
    longitude: null,
    photoCapturedAt: null,
    photoDataUrl: null,
    photoName: "",
    ...("address" in capture ? { address: "" } : {}),
    ...("accuracy" in capture ? { accuracy: null } : {}),
    ...("locationLines" in capture ? { locationLines: [] } : {}),
  } as T;
}

/**
 * Strip every capture that has aged out, keeping everything the rep typed.
 *
 * Returns the names it stripped so the caller can say which customers need photographing again
 * instead of showing a form that has quietly lost its pins.
 */
export function stripExpiredEvidence<TCustomer extends DraftCustomer>(
  customers: TCustomer[],
  nowMs: number,
): { customers: TCustomer[]; expiredEvidenceFor: string[] } {
  const expiredEvidenceFor: string[] = [];

  const next = customers.map((customer) => {
    let expired = false;

    const capture =
      hasCaptureEvidence(customer.capture) && !isCaptureEvidenceFresh(customer.capture, nowMs)
        ? ((expired = true), clearedCapture(customer.capture))
        : customer.capture;

    const pharmacies = customer.pharmacies.map((pharmacy) =>
      hasCaptureEvidence(pharmacy.capture) && !isCaptureEvidenceFresh(pharmacy.capture, nowMs)
        ? ((expired = true), { ...pharmacy, capture: clearedCapture(pharmacy.capture) })
        : pharmacy,
    );

    if (expired) {
      expiredEvidenceFor.push(customer.name.trim() || "an unnamed customer");
    }
    // Cast for the same reason as `clearedCapture`: only `capture` and `pharmacies` are replaced,
    // both with values of their own declared types, so the result is still a `TCustomer`.
    return { ...customer, capture, pharmacies } as TCustomer;
  });

  return { customers: next, expiredEvidenceFor };
}

/**
 * Is there anything here worth keeping?
 *
 * A pristine form is one empty customer with one empty pharmacy. Writing that to disk would mean
 * every visit to the page leaves a "draft" behind and the recovery banner would fire on a form
 * nobody had touched, which trains people to dismiss it — so the banner has to mean something.
 */
export function isDraftWorthKeeping(customers: DraftCustomer[]): boolean {
  return customers.some(
    (customer) =>
      isFilled(customer.name) ||
      hasCaptureEvidence(customer.capture) ||
      customer.pharmacies.some(
        (pharmacy) => isFilled(pharmacy.name) || hasCaptureEvidence(pharmacy.capture),
      ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCaptureShape(value: unknown): boolean {
  return isRecord(value) && "photoDataUrl" in value && "capturedAt" in value;
}

/**
 * Structural check on whatever came back out of storage.
 *
 * Deliberately shallow: it confirms the envelope and that each customer carries a capture and a
 * pharmacy array, then trusts the interior. Storage here is same-origin IndexedDB written by this
 * same build, so the realistic failure is a shape change between versions — which `version` already
 * catches — not a hostile payload. The one thing a malformed interior could do is crash the form on
 * mount, and the caller discards the draft on any throw.
 */
export function parseStoredDraft(value: unknown): MarketingValidationDraft | null {
  if (!isRecord(value)) return null;
  if (value.version !== MARKETING_DRAFT_VERSION) return null;
  if (typeof value.ownerHrId !== "string" || !value.ownerHrId) return null;
  if (typeof value.savedAt !== "string") return null;
  if (!Array.isArray(value.customers) || value.customers.length === 0) return null;

  for (const customer of value.customers) {
    if (!isRecord(customer)) return null;
    if (typeof customer.name !== "string") return null;
    if (!isCaptureShape(customer.capture)) return null;
    if (!Array.isArray(customer.pharmacies)) return null;
    for (const pharmacy of customer.pharmacies) {
      if (!isRecord(pharmacy) || !isCaptureShape(pharmacy.capture)) return null;
    }
  }

  return {
    customers: value.customers as DraftCustomer[],
    onBehalfHrId: typeof value.onBehalfHrId === "string" ? value.onBehalfHrId : "",
    ownerHrId: value.ownerHrId,
    savedAt: value.savedAt,
    version: MARKETING_DRAFT_VERSION,
  };
}

/**
 * The whole restore decision in one place: is this draft mine, is it recent enough to offer at all,
 * and which of its captures may still be called evidence.
 *
 * Returns null when there is nothing to offer, so the caller has a single falsy check rather than a
 * ladder of conditions it could get subtly wrong.
 */
export function restoreDraft<TCustomer extends DraftCustomer = DraftCustomer>(input: {
  draft: MarketingValidationDraft<TCustomer> | null;
  nowMs: number;
  viewerHrId: string;
}): MarketingDraftRestore<TCustomer> | null {
  const { draft, nowMs, viewerHrId } = input;
  if (!draft) return null;

  // Shared field phones: a draft is only ever offered back to the person who typed it.
  if (!viewerHrId || draft.ownerHrId.toLowerCase() !== viewerHrId.toLowerCase()) return null;

  const savedAtMs = Date.parse(draft.savedAt);
  if (!Number.isFinite(savedAtMs)) return null;
  if (nowMs - savedAtMs > MARKETING_DRAFT_MAX_AGE_MS) return null;

  const { customers, expiredEvidenceFor } = stripExpiredEvidence(draft.customers, nowMs);
  if (!isDraftWorthKeeping(customers)) return null;

  return {
    customers,
    expiredEvidenceFor,
    onBehalfHrId: draft.onBehalfHrId,
    savedAt: draft.savedAt,
  };
}

/** The banner text. Kept here so the wording is tested rather than buried in JSX. */
export function describeRestoredDraft(restore: MarketingDraftRestore): string {
  const count = restore.customers.length;
  const subject = count === 1 ? "an unsaved capture" : `${count} unsaved captures`;

  if (restore.expiredEvidenceFor.length === 0) {
    return `Recovered ${subject} from before the page closed. Check it, then save.`;
  }

  const names = restore.expiredEvidenceFor.join(", ");
  return `Recovered ${subject} from before the page closed, but the live photo and location on ${names} were too old to keep as evidence — take them again before saving.`;
}

/**
 * The banner for offline submissions found on the device that can no longer be sent, or null when
 * there are none. The two reasons are told apart because they are different facts: `tooOld` are the
 * viewer's own, whose evidence aged out; `noOwner` were queued before entries said whose they are, so
 * nobody's session may send them — however fresh they are, "too old" would be a false reason.
 */
export function describeUnsendableQueue(counts: { noOwner: number; tooOld: number }): string | null {
  const sentences: string[] = [];
  const { noOwner, tooOld } = counts;
  if (tooOld > 0) {
    const many = tooOld > 1;
    sentences.push(
      `${tooOld} offline submission${many ? "s were" : " was"} waiting to sync, but the live photo and location on ${many ? "them" : "it"} are now too old to count as evidence of the visit. Capture ${many ? "them" : "it"} again.`,
    );
  }
  if (noOwner > 0) {
    const many = noOwner > 1;
    sentences.push(
      `${noOwner} offline submission${many ? "s" : ""} on this device ${many ? "were" : "was"} saved without the name of the person who saved ${many ? "them" : "it"}, so ${many ? "they" : "it"} cannot be sent under anyone's name. If ${many ? "they were" : "it was"} yours, capture ${many ? "them" : "it"} again.`,
    );
  }
  return sentences.length > 0 ? sentences.join(" ") : null;
}
