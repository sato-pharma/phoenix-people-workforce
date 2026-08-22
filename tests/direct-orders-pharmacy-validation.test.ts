import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2: Pharmacy Validation, probation, and the did-you-mean matcher
// (spec A2/A3/B4 — docs/specs/direct-orders-v2.md).
//
// The rules under guard are the ones that make the gate hold when nobody is watching: evidence
// must be a LIVE capture, the GPS verdict must be computed on the SERVER, probation must be able
// to fail a pharmacy an admin already approved, and the suggestion record must be reproducible.
// The live paths are Supabase-bound, so these assert against the source and the migrations.
// ─────────────────────────────────────────────────────────────────────────────

export function runDirectOrdersPharmacyValidationTests() {
  const validationSource = readFileSync(new URL("../src/lib/direct-orders/pharmacy-validation.ts", import.meta.url), "utf8");
  const probationSource = readFileSync(new URL("../src/lib/direct-orders/pharmacy-probation.ts", import.meta.url), "utf8");
  const captureSource = readFileSync(
    new URL("../src/components/direct-orders/pharmacy-validation-capture.tsx", import.meta.url),
    "utf8",
  );
  const validationMigration = readFileSync(
    new URL("../supabase/migrations/20260805024500_direct_order_pharmacy_validation.sql", import.meta.url),
    "utf8",
  );
  const suggestMigration = readFileSync(
    new URL("../supabase/migrations/20260805034500_direct_order_pharmacy_suggestions.sql", import.meta.url),
    "utf8",
  );

  // ── THE HEADLINE: evidence must be a live capture, never a gallery upload ───────────────
  assert.match(
    validationSource,
    /\/\^data:\(image\\\/jpeg\);base64/,
    "EVIDENCE GATE GONE: the photo must be parsed as a live JPEG data URL — a gallery upload arrives as another MIME type and must fail",
  );
  assert.ok(
    !/type="file"|input type=.file./i.test(captureSource),
    "the capture component must offer NO file picker — the server rejects non-live JPEGs, so an upload button would only teach reps to try",
  );
  assert.match(
    captureSource,
    /if \(capture\.latitude == null\) \{/,
    "the shutter must refuse before a location exists — a photo with no coordinates is not evidence of a place",
  );
  // The stamp is burned into the pixels, so the image carries its own provenance.
  assert.match(captureSource, /GPS: \$\{capture\.latitude\?\.toFixed\(6\)\}/, "coordinates must be burned into the photo");
  assert.match(captureSource, /toDataURL\("image\/jpeg", 0\.86\)/, "same JPEG quality as the other live-capture flows");

  // ── The GPS verdict is computed SERVER-SIDE ────────────────────────────────────────────
  assert.match(
    validationSource,
    /gps_inside_requester_area: proximity\.inside/,
    "the area verdict stored must be the one the SERVER computed",
  );
  assert.ok(
    !/gps_inside_requester_area: input\./.test(validationSource),
    "the browser must never supply its own compliance verdict",
  );
  // Unknown must stay unknown — never silently 'inside'.
  assert.match(
    validationSource,
    /return \{ distanceKm: null, inside: null \}/,
    "an unresolvable distance must read as unknown, never as inside",
  );

  // ── Probation can fail a pharmacy an admin already approved (spec A3) ──────────────────
  assert.match(probationSource, /export const PROBATION_DAYS = 90;/, "the probation window is 90 days");
  assert.match(
    probationSource,
    /trust_state: "phantom_suspected"/,
    "a provisional pharmacy with no footprint must be demoted, so a wrong approval self-corrects",
  );
  // TWO independent footprints, either sufficient.
  assert.match(probationSource, /source_of_sales_import_rows/, "distributor sales count as a footprint");
  assert.match(probationSource, /payment_date/, "a paid collection counts as a footprint");
  assert.match(
    probationSource,
    /\.eq\("trust_state", "provisional"\)/,
    "both promotion and demotion must be guarded on the CURRENT state",
  );
  // One bad pharmacy must never abort the nightly sweep.
  assert.match(probationSource, /catch \(sweepError\)/, "a single failing pharmacy must not abort the sweep");

  // ── Validation outcomes ────────────────────────────────────────────────────────────────
  // Matching to a real directory customer means the master database vouches for it: trusted
  // outright, no probation. Approving something genuinely new costs probation.
  assert.match(validationSource, /trust_state: "trusted",[\s\S]{0,200}Matched to/, "a matched pharmacy is trusted outright");
  assert.match(
    validationSource,
    /trust_state: "provisional", probation_started_at: now/,
    "approve-as-new must start the probation clock",
  );
  assert.match(
    validationSource,
    /await acknowledgeDirectOrderPharmacy\(access, \{ pharmacyId \}\)/,
    "both approve and match must reuse the ONE confirmed-pharmacy path, which is what revives held orders",
  );
  // Rejection must leave the order held — never quietly release it.
  const rejectIdx = validationSource.indexOf('if (input.decision === "reject")');
  assert.ok(rejectIdx > 0, "a reject branch must exist");
  // Bounded by the close of the reject branch itself. The branch is ~900 bytes today, so the old
  // window sat exactly on its edge: one more audit field and it would have started reading the
  // `match` branch below — which DOES confirm the pharmacy, and would have failed this check on
  // entirely correct code.
  const rejectEnd = validationSource.slice(rejectIdx).search(/^  \}$/m);
  const rejectBranch = validationSource.slice(rejectIdx, rejectEnd >= 0 ? rejectIdx + rejectEnd : validationSource.length);
  assert.ok(
    !rejectBranch.includes("acknowledgeDirectOrderPharmacy"),
    "rejecting must NOT confirm the pharmacy — the order stays held",
  );

  // ── The did-you-mean record is evidence, so it must be server-resolved (spec B4) ───────
  assert.match(
    validationSource,
    /suggestions_shown: suggestions\.length > 0 \? suggestions : null/,
    "what Phoenix offered must be recorded on the claim",
  );
  assert.ok(
    !/suggestions_shown: input\./.test(validationSource),
    "the shown-and-refused record must be computed server-side, not taken from the client",
  );
  assert.match(
    suggestMigration,
    /create extension if not exists pg_trgm/,
    "suggestions use trigram similarity — deterministic, so the record reproduces identically later",
  );
  assert.match(
    suggestMigration,
    /phx_normalize_arabic\(m\.customer_name\)/,
    "similarity must run on the NORMALIZED name, so orthography and typos are handled by one path",
  );
  assert.match(
    suggestMigration,
    /btrim\(m\.customer_name\) <> ''/,
    "a nameless customer cannot be suggested by name — the rep would have nothing to recognise",
  );

  // ── Migration hygiene ──────────────────────────────────────────────────────────────────
  assert.match(
    validationMigration,
    /where status = 'pending'/,
    "only ONE open validation per pharmacy, or a rejected claim could be re-opened by asking again",
  );
  assert.match(validationMigration, /'direct-order-evidence', false, 2097152, array\['image\/jpeg'\]/,
    "the evidence bucket must be PRIVATE, capped, and JPEG-only — a second wall behind the parser");
  assert.ok(
    !/set\s+version/i.test(validationMigration),
    "workflow_registry_modules.version is trigger-owned — a migration must never set it",
  );
  const updates = validationMigration.match(/update public\.workflow_registry_modules/g) ?? [];
  assert.equal(updates.length, 1, "exactly ONE registry update — N updates = N version bumps");

  // ── Invisible AI (owner rule D4) ───────────────────────────────────────────────────────
  // Nothing user-facing may name a mechanism. Phoenix speaks in its own voice.
  for (const [label, source] of [["capture", captureSource]] as const) {
    assert.ok(
      !/\bAI\b|GPT|OpenAI|model suggests|powered by/i.test(source),
      `${label}: no user-facing surface may announce AI or a model (owner rule D4)`,
    );
  }
  assert.match(captureSource, /Phoenix already knows/, "suggestions must speak as Phoenix itself");
}
