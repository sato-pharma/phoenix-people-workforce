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
  assert.match(
    attachBody,
    /if \(phoenixCodes\.length === 0 && customerCodes\.length === 0\) return hits;/,
    "no linkable hit on EITHER register means the list is returned as it was",
  );
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

  // ── Both registers, each keyed on an id and never on a name ─────────────────────────────────
  // The Phoenix side resolves through the pharmacy code; the marketing side through the resolved
  // distributor pair. Keying either on the NAME is how a label lands on the wrong shop, and the
  // names are precisely what does not meet across the two books.
  assert.match(attachBody, /phoenix_pharmacy_code/, "the Phoenix side is keyed on the pharmacy code");
  assert.match(attachBody, /marketing_pharmacy_distributor_codes/, "the marketing side is reached through its distributor codes");
  assert.match(attachBody, /loadAlsoKnownAsBatch\("marketing"/, "and read with the same confirmed-links reader");
  assert.doesNotMatch(attachBody, /pharmacy_name|display_name/, "neither side matches on a name");

  // 🔴 THE RESOLVED PAIR, NEVER THE RAW TYPED CODE (§4.1). `mapped_*` is what the capture-time
  //    resolver agreed the code means; the raw `distributor_pharmacy_code` beside it is whatever a
  //    person typed, and 33 of 479 marketing rows carry one that resolves to a different shop.
  assert.match(attachBody, /mapped_distributor_code/, "it reads the RESOLVED distributor code");
  assert.match(attachBody, /mapped_customer_code/, "and the resolved customer code");
  assert.doesNotMatch(attachBody, /distributor_pharmacy_code/, "never the raw code a person typed");

  // 🔴 KEYED ON THE PAIR, NEVER THE CUSTOMER CODE ALONE. Every distributor numbers its own
  //    customers, so one code means a different shop at a different distributor — the standing
  //    rule that a shared customer code cannot prove two venues are the same. PostgREST can only
  //    filter one column, so the second half of the key has to be matched in code, and a version
  //    that forgets to is indistinguishable from a working one until it labels the wrong shop.
  assert.match(
    attachBody,
    /marketingIdByPair\.set\(`\$\{distributor\}::\$\{customer\}`/,
    "the marketing id is keyed on distributor AND customer code together",
  );
  assert.match(
    attachBody,
    /marketingIdByPair\.get\(pair\)/,
    "and a hit is matched by that same pair, never by its customer code alone",
  );

  // ── A shop is never an alias of itself ──────────────────────────────────────────────────────
  // The directory's spelling very often equals one of the linked rows', which is how a hit ends
  // up reading "also known as" its own name.
  assert.match(attachBody, /name === own/, "an alias equal to the hit's own name is dropped");
  assert.match(attachBody, /new Set<string>\(\)/, "and the two registers' names are deduped rather than concatenated");

  // ── The screen says it is confirmed, and shows nothing otherwise ─────────────────────────────
  assert.match(box, /hit\.alsoKnownAs\.length > 0 \?/, "the line renders only when there is a confirmed link");
  assert.match(box, /also known as/, "and says what it is in plain words");
  assert.match(box, /dir="auto"/, "an Arabic shop name carries its own direction, like every other name on this row");
}
