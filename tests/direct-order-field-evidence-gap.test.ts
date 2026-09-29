import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DIRECT_ORDER_FIELD_EVIDENCE_GAP_LABELS,
  DIRECT_ORDER_FIELD_EVIDENCE_GAP_SENTENCES,
  directOrderFieldEvidenceGap,
  type DirectOrderFieldEvidenceGap,
} from "@/lib/direct-orders/field-evidence-gap";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// "Not GPS field-validated" on a direct-order approval window (owner, 2026-09-29).
//
// He opened a held order for حضانة د. عبدالكريم السبكى (`DOP-000135`, 86,625 EGP) and asked how a
// photo could carry no timestamp and no location when validation is a live capture. It could
// because the photo was the DISTRIBUTOR INVOICE — a document, by design, offered from the camera OR
// the gallery — while the venue under it had never been captured at all: no photo, no pin, no
// validation row. The screen said neither thing, and the invoice sat full width at the top exactly
// where venue evidence would be. His instruction: "add a not-field-validated line to the direct
// order screen."
//
// Measured on production the same day, by the gap this module returns: 130 direct-order venues, of
// which 7 hold a field capture and 123 carry a line — 91 `catalogue`, 31 `hand_entered`, 1
// `invoice`. 104 of those 123 read `verified` while nobody had ever stood in front of them.
// ─────────────────────────────────────────────────────────────────────────────

const KINDS: DirectOrderFieldEvidenceGap[] = ["catalogue", "hand_entered", "invoice"];

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

const GAP = "../src/lib/direct-orders/field-evidence-gap.ts";
const VALIDATION = "../src/lib/direct-orders/pharmacy-validation.ts";
const SERVICE = "../src/lib/direct-orders/service.ts";
const LINE = "../src/components/validation/not-field-validated-line.tsx";
const DETAIL = "../src/components/approvals-hub/direct-order-request-detail.tsx";
const TYPES = "../src/lib/direct-orders/types.ts";

/**
 * The one rule that matters: a venue somebody DID capture never carries the line. A false "nobody
 * stood in front of this" accuses a rep of work he actually did, which is worse than no line at all.
 */
function aFieldCaptureSilencesIt() {
  for (const entrySource of ["catalogue", "manual", "marketing_transfer", "", null]) {
    for (const validatedByInvoice of [true, false]) {
      assert.equal(
        directOrderFieldEvidenceGap({ entrySource, hasFieldCapture: true, validatedByInvoice }),
        null,
        `a field capture must silence the line (entrySource=${String(entrySource)}, invoice=${validatedByInvoice})`,
      );
    }
  }
}

/** Which gap, when there is no capture — the invoice fact is the more specific one, so it wins. */
function theThreeKinds() {
  assert.equal(
    directOrderFieldEvidenceGap({ entrySource: "catalogue", hasFieldCapture: false, validatedByInvoice: false }),
    "catalogue",
  );
  assert.equal(
    directOrderFieldEvidenceGap({ entrySource: "manual", hasFieldCapture: false, validatedByInvoice: false }),
    "hand_entered",
  );
  assert.equal(
    directOrderFieldEvidenceGap({ entrySource: "manual", hasFieldCapture: false, validatedByInvoice: true }),
    "invoice",
  );
  // An invoice-validated venue is USUALLY hand-entered, and an invoice claim on a catalogue venue is
  // possible too. Either way "validated by invoice" is what the approver needs, not where the row
  // came from — so the invoice fact is read first.
  assert.equal(
    directOrderFieldEvidenceGap({ entrySource: "catalogue", hasFieldCapture: false, validatedByInvoice: true }),
    "invoice",
  );
  // A MARKETING TRANSFER is hand-captured work, not a distributor list. `DirectOrderPharmacy`'s own
  // mapper folds it into "catalogue", which is exactly why this helper takes the RAW entry source —
  // telling an approver a transferred venue came off a catalogue would be false.
  assert.equal(
    directOrderFieldEvidenceGap({
      entrySource: "marketing_transfer",
      hasFieldCapture: false,
      validatedByInvoice: false,
    }),
    "hand_entered",
  );
  // An unknown or missing entry source is hand-entered, never catalogue: catalogue is the ONE claim
  // here that says a distributor vouched for the venue, so it is never the default.
  for (const unknown of ["", null, undefined, "something_new"]) {
    assert.equal(
      directOrderFieldEvidenceGap({ entrySource: unknown, hasFieldCapture: false, validatedByInvoice: false }),
      "hand_entered",
      `an unrecognised entry source must not read as the distributor catalogue (${String(unknown)})`,
    );
  }
}

/**
 * A RUNTIME check that every kind has words, because an exhaustive `Record` does not gate the build
 * here — `ignoreBuildErrors` lets a missing key compile, build and deploy (AGENTS.md §2.1).
 */
function everyKindHasWords() {
  for (const kind of KINDS) {
    const label = DIRECT_ORDER_FIELD_EVIDENCE_GAP_LABELS[kind];
    const sentence = DIRECT_ORDER_FIELD_EVIDENCE_GAP_SENTENCES[kind];
    assert.ok(label && label.trim().length > 0, `${kind} must have a label`);
    assert.ok(sentence && sentence.trim().length > 0, `${kind} must have a sentence`);
    // The whole point of the line is the phrase the owner can recognise on the screen.
    assert.match(label, /not GPS field-validated/, `${kind}'s label must say what is missing`);
    // Flagged, never blocked — the standing rule, and the reason this is neutral and not a refusal.
    assert.match(sentence, /Flagged for your attention, not blocked\./, `${kind} must not read as a refusal`);
    // No ellipsis anywhere in owner-facing text (owner rule).
    assert.ok(!label.includes("…") && !sentence.includes("…"), `${kind} must never truncate with an ellipsis`);
  }
  assert.equal(Object.keys(DIRECT_ORDER_FIELD_EVIDENCE_GAP_LABELS).length, KINDS.length);
  assert.equal(Object.keys(DIRECT_ORDER_FIELD_EVIDENCE_GAP_SENTENCES).length, KINDS.length);
  // The invoice sentence is the one that answers his actual question, so it says the two things the
  // screen never said: an invoice is a document, and the venue itself was never captured.
  assert.match(DIRECT_ORDER_FIELD_EVIDENCE_GAP_SENTENCES.invoice, /no location and no capture time/);
}

/** What the loader counts as a field capture, pinned on the source it is decided in. */
function loaderRules() {
  const source = stripComments(read(VALIDATION));
  assert.match(source, /export async function loadDirectOrderVenueFieldEvidence\(/);
  const start = source.indexOf("export async function loadDirectOrderVenueFieldEvidence(");
  const body = source.slice(start, source.indexOf("\n}", start) + 2);

  // The CAPTURE, not the decision: a photo AND both coordinates, on the field route, not rejected.
  assert.match(body, /normalizeDirectOrderValidationRoute\(row\.validation_route\) === "field"/);
  assert.match(body, /String\(row\.status \?\? ""\) !== "rejected"/);
  assert.match(body, /Boolean\(String\(row\.storage_path \?\? ""\)\.trim\(\)\)/);
  assert.match(body, /row\.captured_latitude != null/);
  assert.match(body, /row\.captured_longitude != null/);
  // A PENDING field claim still counts — a marketing transfer arrives as one, carrying the rep's
  // photo and pin, and calling that venue uncaptured would be false.
  assert.ok(
    !/=== "approved_new" \|\| String\(row\.status \?\? ""\) === "matched_existing"[\s\S]{0,200}hasFieldCapture/.test(body),
    "a field capture must not be gated on a decision",
  );
  // The invoice half IS gated on a decision: an undecided invoice claim has validated nothing.
  assert.match(body, /=== "invoice" &&\s*\(String\(row\.status \?\? ""\) === "approved_new"/);

  // Asked of the WHOLE venue, and bounded — an unbounded PostgREST select stops at 1000 silently.
  assert.match(body, /\.eq\("pharmacy_id", pharmacyId\)/);
  assert.match(body, /\.limit\(200\)/);
  // The RAW entry source, read from the table rather than taken off the mapped pharmacy.
  assert.match(body, /\.from\("direct_order_pharmacies"\)\s*\.select\("entry_source"\)/);
  // It decorates a screen, so a read failure must never cost the approver the whole order.
  assert.match(body, /if \(error\) return \{ \.\.\.empty, entrySource \}/);
}

/** The service asks the VENUE, not the single most-recent claim, and hands the answer to the screen. */
function serviceWiring() {
  const source = stripComments(read(SERVICE));
  assert.match(source, /loadDirectOrderVenueFieldEvidence,/);
  assert.match(source, /import \{ directOrderFieldEvidenceGap \} from "@\/lib\/direct-orders\/field-evidence-gap"/);
  assert.match(source, /const venueFieldEvidence = await loadDirectOrderVenueFieldEvidence\(request\.pharmacyId\)/);
  assert.match(source, /const pharmacyFieldEvidenceGap = directOrderFieldEvidenceGap\(venueFieldEvidence\)/);
  assert.match(source, /\n {4}pharmacyFieldEvidenceGap,\n/);
  // NEVER derived from `pharmacyEvidence` — that is the most recent claim only, so a venue captured
  // in the field earlier and re-filed on an invoice would read as uncaptured.
  assert.ok(
    !/directOrderFieldEvidenceGap\(\s*pharmacyEvidence/.test(source),
    "the gap must be decided from the venue's whole evidence, never the one loaded claim",
  );
  assert.match(stripComments(read(TYPES)), /pharmacyFieldEvidenceGap\?: DirectOrderFieldEvidenceGap \| null;/);
}

/** The line itself: where it sits, what gates it, and the house rules it must keep. */
function theLineOnTheScreen() {
  const detail = stripComments(read(DETAIL));
  assert.match(detail, /import \{ NotFieldValidatedLine \} from "@\/components\/validation\/not-field-validated-line"/);
  assert.match(detail, /pharmacyFieldEvidenceGap = null,/);
  assert.match(detail, /\{pharmacyFieldEvidenceGap \? <NotFieldValidatedLine gap=\{pharmacyFieldEvidenceGap\} \/> : null\}/);

  // ABOVE the invoice panel: the invoice is the thing being mistaken for venue evidence, so the
  // sentence has to arrive before it.
  const lineAt = detail.indexOf("<NotFieldValidatedLine");
  const invoiceAt = detail.indexOf('<PanelSection title="Invoice used for this order">');
  assert.ok(lineAt >= 0 && invoiceAt >= 0, "both blocks must exist");
  assert.ok(lineAt < invoiceAt, "the line must render above the invoice panel");

  // NOT nested inside the "already validated" stamp, and not gated on it: the loudest case in
  // production is a venue with no validation row at all, which carries no stamp.
  const validatedAt = detail.indexOf("<ValidatedEvidenceLink");
  assert.ok(validatedAt >= 0 && validatedAt < lineAt, "the stamp comes first, the line beneath it");
  assert.ok(
    !/pharmacyValidation \?[\s\S]{0,400}NotFieldValidatedLine/.test(detail),
    "the line must not be gated on the already-validated stamp",
  );

  const line = stripComments(read(LINE));
  // The square-edge golden rule, and the no-ellipsis rule. `rounded-*` anywhere here is the bug.
  assert.ok(!/\brounded(-|\b)/.test(line), "no rounded corners (square-edge golden rule)");
  assert.ok(!/truncate|text-ellipsis|line-clamp|…/.test(line), "never truncate owner-facing text");
  // The fits-the-screen rule: the sentence wraps on a phone, it does not scroll and it does not
  // force a nowrap line wider than the viewport.
  assert.ok(!/whitespace-nowrap|overflow-x-auto|min-w-\[/.test(line), "the line must wrap, never scroll");
  // Neutral by choice — nothing is broken and nothing is blocked.
  assert.ok(!/(amber|rose|red)-\d{2,3}/.test(line), "the line is neutral, not a warning colour");
  // The words come from the domain, so the screen and any other reader can never disagree.
  assert.match(line, /DIRECT_ORDER_FIELD_EVIDENCE_GAP_LABELS\[gap\]/);
  assert.match(line, /DIRECT_ORDER_FIELD_EVIDENCE_GAP_SENTENCES\[gap\]/);
}

export async function runDirectOrderFieldEvidenceGapTests() {
  aFieldCaptureSilencesIt();
  theThreeKinds();
  everyKindHasWords();
  loaderRules();
  serviceWiring();
  theLineOnTheScreen();
}
