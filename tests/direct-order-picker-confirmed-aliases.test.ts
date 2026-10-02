import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { othersOnMaster } from "../src/lib/customer-identity/suggestions.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * "Also known as" on the direct-order pharmacy picker.
 *
 * The picker is where someone chooses which shop an order is for, so the rules are about the two
 * ways a footnote can stop being a footnote: by changing the list, or by stating a maybe.
 */
export function runDirectOrderPickerAliasTests() {
  const service = stripComments(readFileSync("src/lib/direct-orders/service.ts", "utf8"));
  const box = stripComments(readFileSync("src/components/direct-orders/pharmacy-combo-box.tsx", "utf8"));

  // ── A label, never a filter ──────────────────────────────────────────────────────────────────
  // 🔴 IT MUST RUN AFTER THE TWO FILTERS. The wholesaler guard and the area scope decide WHICH
  //    hits exist; annotating before them would let a lookup reorder or drop a row, which is a
  //    filter wearing a label's clothes. The call site is pinned, not just the function.
  const search = service.slice(service.indexOf("export async function searchDirectOrderPharmacyDirectory"));
  const body = search.slice(0, search.indexOf("\n}\n") + 1);
  assert.ok(body.length > 0 && body.length < service.length / 4, "the search slice must find its markers");
  assert.ok(
    body.indexOf("isCertainWholesalerVenue") < body.indexOf("attachConfirmedAliases(hits)"),
    "the aliases are attached AFTER the wholesaler guard, so a label can never resurrect a blocked venue",
  );
  assert.ok(
    body.indexOf("allowedAreaCodes.has") < body.indexOf("attachConfirmedAliases(hits)"),
    "and after the area scope, so a label can never widen a picker past its viewer",
  );

  const attach = service.slice(service.indexOf("async function attachConfirmedAliases"));
  const attachBody = attach.slice(0, attach.indexOf("\n}\n") + 1);
  assert.ok(attachBody.length > 0, "the attach slice must find its markers");
  // Every early exit hands the hits back untouched, and the mapping only ever spreads a hit.
  assert.match(attachBody, /if \(codes\.length === 0\) return hits;/, "no linkable hit means the list is returned as it was");
  assert.match(attachBody, /\{ \.\.\.hit, alsoKnownAs:/, "a hit is only ever extended, never replaced or dropped");
  // Scoped to `hits` on purpose: the step DOES filter the list of codes it looks up, which changes
  // nothing a user sees. What it must never do is filter, reorder or trim the hits themselves.
  assert.doesNotMatch(
    attachBody,
    /hits\s*\.\s*(?:filter|sort|slice|splice|reverse)\(/,
    "the annotation step must not filter, reorder or trim the hits",
  );

  // ── It never fails the search ────────────────────────────────────────────────────────────────
  // Someone typing a pharmacy name needs the list far more than he needs the footnote.
  assert.match(attachBody, /catch \{\s*return hits;\s*\}/, "a failure in the identity module costs the footnote, never the list");

  // ── Confirmed only ───────────────────────────────────────────────────────────────────────────
  // 🔴 A MAYBE SHOWN AT THE MOMENT SOMEONE IS CHOOSING A PHARMACY IS A MAYBE THEY WILL ACT ON.
  assert.match(service, /loadAlsoKnownAsBatch/, "the picker reads confirmed links through the batch reader");
  assert.doesNotMatch(
    service,
    /suggestIdentityPairs|judgePair|customer-identity\/suggestions/,
    "the direct-order service must never reach the suggestion engine",
  );

  const reader = stripComments(readFileSync("src/lib/customer-identity/server/profile.ts", "utf8"));
  const batch = reader.slice(reader.indexOf("export async function loadAlsoKnownAsBatch"));
  const batchBody = batch.slice(0, batch.indexOf("\n}\n") + 1);
  assert.ok(batchBody.length > 0, "the batch reader slice must find its markers");
  assert.match(batchBody, /customer_identity_links/, "it answers from the confirmed links table");
  assert.doesNotMatch(batchBody, /suggestIdentityPairs|judgePair/, "and never from the engine");
  // The same rule the single-row reader uses, not a second copy of it — a shop listed as one of
  // its own aliases reads as a confirmed cross-system match when nothing was matched to it.
  assert.match(batchBody, /othersOnMaster\(/, "the batch reader drops the row asked about through the shared rule");
  assert.equal(
    othersOnMaster([{ source: "direct_order", sourceId: "A" }], "direct_order", "A").length,
    0,
    "and that shared rule leaves a one-link master with no aliases at all",
  );

  // ── Only the Phoenix side can carry a link ───────────────────────────────────────────────────
  // A directory row is a distributor's own customer record with no Phoenix pharmacy behind it, so
  // there is no id for a master to hold — keying on the NAME instead is how a label lands on the
  // wrong shop.
  assert.match(attachBody, /phoenix_pharmacy_code/, "the lookup is keyed on the Phoenix pharmacy code");
  assert.doesNotMatch(attachBody, /customerName|pharmacy_name/, "never on the name, which is exactly what does not match across the two books");

  // ── The screen says it is confirmed, and shows nothing otherwise ─────────────────────────────
  assert.match(box, /hit\.alsoKnownAs\.length > 0 \?/, "the line renders only when there is a confirmed link");
  assert.match(box, /also known as/, "and says what it is in plain words");
  assert.match(box, /dir="auto"/, "an Arabic shop name carries its own direction, like every other name on this row");
}
