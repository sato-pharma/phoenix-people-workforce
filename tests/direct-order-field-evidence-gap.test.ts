import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DIRECT_ORDER_FIELD_EVIDENCE_GAP_LABELS,
  DIRECT_ORDER_FIELD_EVIDENCE_GAP_SENTENCES,
  directOrderFieldEvidenceGap,
  directOrderRejectionWasOnlyRedundant,
  type DirectOrderFieldEvidenceGap,
} from "@/lib/direct-orders/field-evidence-gap";
import { canViewDirectOrderFieldEvidenceGap } from "@/lib/direct-orders/validation-visibility";
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

const VISIBILITY = "../src/lib/direct-orders/validation-visibility.ts";
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
  // The owner's superseded exception, read off the SAME row's notes — and the photo and both
  // coordinates are still required, so the note readmits a decision and never invents evidence.
  assert.match(body, /directOrderRejectionWasOnlyRedundant\(row\.decision_notes\)/);
  assert.match(body, /\.select\("validation_route, status, storage_path, captured_latitude, captured_longitude, decision_notes"\)/);
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
  assert.match(source, /loadDirectOrderVenueFieldEvidence\(request\.pharmacyId\)/);
  assert.match(source, /directOrderFieldEvidenceGap\(await loadDirectOrderVenueFieldEvidence\(/);
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

/**
 * APPROVER-ONLY, NEVER THE PORTAL (owner, 2026-09-29): "make the not-field-validated line
 * approver-only, not the portal." Withheld on two counts, either one enough — the portal shell,
 * and the order's own requester.
 */
function approverOnlyNeverThePortal() {
  const approver = { viewerHrId: "B-10", requesterHrId: "B-154", navigationMode: "admin" };
  assert.equal(canViewDirectOrderFieldEvidenceGap(approver), true, "an approver in the admin shell sees it");
  assert.equal(
    canViewDirectOrderFieldEvidenceGap({ ...approver, navigationMode: "hr" }),
    true,
    "the HR shell is not the portal",
  );

  // The PORTAL, whoever is in it — every rep and every portal-mode manager is redirected there.
  for (const viewer of ["B-10", "B-154", "A-2"]) {
    assert.equal(
      canViewDirectOrderFieldEvidenceGap({ viewerHrId: viewer, requesterHrId: "B-154", navigationMode: "employee-portal" }),
      false,
      `the portal never shows it (${viewer})`,
    );
  }

  // The order's OWN REQUESTER, even in the admin shell: he is not an approver of his own order.
  assert.equal(
    canViewDirectOrderFieldEvidenceGap({ viewerHrId: "B-154", requesterHrId: "B-154", navigationMode: "admin" }),
    false,
    "the requester never sees it on his own order",
  );
  // CASE is the spelling that varies in production — HR ids are stored mixed-case and a plain `.eq`
  // has under-returned by 28% before, so both sides go through `canonicalHrIdKey`. It lowercases and
  // resolves aliases but does NOT strip the dash, exactly like `canViewDirectOrderEvidenceAiNote`
  // beside it; a dash-less "B154" is deliberately not the same key, and widening that here alone
  // would make the two predicates disagree about who the requester is.
  for (const spelling of ["b-154", "B-154"]) {
    assert.equal(
      canViewDirectOrderFieldEvidenceGap({ viewerHrId: spelling, requesterHrId: "B-154", navigationMode: "admin" }),
      false,
      `the requester is the requester however his id is spelled (${spelling})`,
    );
  }
  // An unresolvable viewer is withheld, never shown — the safe direction.
  for (const missing of ["", null, undefined]) {
    assert.equal(
      canViewDirectOrderFieldEvidenceGap({ viewerHrId: missing, requesterHrId: "B-154", navigationMode: "admin" }),
      false,
      `an unidentified viewer is withheld (${String(missing)})`,
    );
  }

  // WITHHELD, not hidden: the service decides BEFORE the read, so the fact never enters the
  // portal's payload and the rep's page pays nothing for it.
  const service = stripComments(read(SERVICE));
  assert.match(service, /const showFieldEvidenceGap = canViewDirectOrderFieldEvidenceGap\(\{/);
  assert.match(service, /navigationMode: resolveNavigationMode\(access\)/);
  assert.match(
    service,
    /const pharmacyFieldEvidenceGap = showFieldEvidenceGap\s*\?\s*directOrderFieldEvidenceGap\(await loadDirectOrderVenueFieldEvidence\(request\.pharmacyId\)\)\s*:\s*null/,
  );
  // The screen is NOT the gate. A component-level check would ship the fact to the browser and
  // hide it, which is not what "not the portal" means.
  const detail = stripComments(read(DETAIL));
  assert.ok(
    !detail.includes("canViewDirectOrderFieldEvidenceGap"),
    "the gate is the service, never the component",
  );
  // And the predicate says it in its own words, so a later reader cannot mistake it for UX.
  assert.match(stripComments(read(VISIBILITY)), /export function canViewDirectOrderFieldEvidenceGap\(/);
}

/**
 * "Count a superseded rejection as field evidence", then "widen the superseded rule to duplicate
 * rejections" (owner, 2026-09-29, in that order). The two stems he asked for, and the much larger
 * set they must still NOT readmit.
 */
function aRedundantRejectionStillCounts() {
  // The exact note on both production rows, his own words, decided by him on 19 Aug.
  const real =
    "Pharmacy already verified/trusted 2026-08-09 (Lacto Advanced orders executed); this claim is superseded, no order depends on it.";
  assert.equal(directOrderRejectionWasOnlyRedundant(real), true, "the production note must qualify");
  for (const yes of [
    "Superseded by DOP-000022.",
    "THIS CLAIM IS SUPERSEDED",
    "supersedes nothing? superseded.",
    // The widening, his second ruling: one idea in a second vocabulary.
    "Duplicate of DOP-000022.",
    "duplicate claim, the venue is already on file",
    "Rejected as a DUPLICATE.",
    // His third ruling, the loose one — he was warned it is loose and chose it anyway.
    "Already verified.",
    "already  verified on 2026-08-09",
    "ALREADY VERIFIED by the desk.",
  ]) {
    assert.equal(directOrderRejectionWasOnlyRedundant(yes), true, `must qualify: ${yes}`);
  }

  // 🔴 The price of the third marker, pinned so nobody later reads it as a bug and narrows it back:
  // "already verified" is a fact about the VENUE, not about the claim's redundancy, so it can sit
  // beside a verdict that IS about the evidence — and this now silences the line on it. His call,
  // made with this exact case put to him first.
  assert.equal(
    directOrderRejectionWasOnlyRedundant("Already verified, but this photo is of the wrong shop."),
    true,
    "his ruling admits this, and the comment above says why that is deliberate",
  );

  // A rejection on the EVIDENCE stays a rejection. These are the notes a desk actually writes, and
  // readmitting one would hide the line on a venue nobody ever visited.
  for (const no of [
    "Photo is of the wrong shop.",
    "The pin is 40km from the area.",
    "No longer required.",
    "Not relevant to this order.",
    "",
    null,
    undefined,
  ]) {
    assert.equal(directOrderRejectionWasOnlyRedundant(no), false, `must NOT qualify: ${String(no)}`);
  }
  // Three markers and no more. "not needed", "no longer required" and "not relevant" stay OUT until
  // he says otherwise — each widening of a text match that decides whether a venue looks captured is
  // his call. Missing a case SHOWS the line on a photographed venue; matching one wrongly HIDES it
  // on an unvisited one.

  // The negation guard, now over both stems — a bare substring test reads each as its opposite.
  for (const negated of [
    "This claim is not superseded — the photo is of the wrong shop.",
    "It was not superseded, the capture failed.",
    "The claim is never superseded by a later one here.",
    "This isn't superseded.",
    "Not a duplicate — the shop does not exist.",
    "This is not duplicate work; the photo is unusable.",
    "It was never a duplicate, the pin is wrong.",
    "Not already verified — this is the first claim on it.",
    "The venue is not already verified.",
  ]) {
    assert.equal(directOrderRejectionWasOnlyRedundant(negated), false, `negation must win: ${negated}`);
  }
  // Mixed signals fall to the safe side: one negated marker refuses the whole note, even when
  // another marker in it reads plainly.
  assert.equal(
    directOrderRejectionWasOnlyRedundant("Not a duplicate, though the earlier claim was superseded."),
    false,
    "a negated marker refuses the note even beside a plain one",
  );
}

export async function runDirectOrderFieldEvidenceGapTests() {
  aFieldCaptureSilencesIt();
  theThreeKinds();
  everyKindHasWords();
  loaderRules();
  serviceWiring();
  theLineOnTheScreen();
  approverOnlyNeverThePortal();
  aRedundantRejectionStillCounts();
}
