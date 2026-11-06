import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Venues waiting for a capture nobody has filed (owner, 2026-09-29: "add a stuck-venues list to the
// validation desk").
//
// The desk lists CLAIMS, so a venue nobody ever captured has no row there at all — not unflagged,
// structurally invisible, on the one screen built to look at venue evidence. Measured on production
// that day: five `pending_review` venues with no live claim, 307,441 EGP of direct orders behind
// them, found only by a hand-written SQL query. زمزم (`DOP-000131`, 133,056 EGP) had been sitting
// there since before that day with nobody looking.
// ─────────────────────────────────────────────────────────────────────────────

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

const LOADER = "../src/lib/direct-orders/stuck-venues.ts";
const PANEL = "../src/components/direct-orders/stuck-venues-panel.tsx";
const PAGE = "../app/(admin)/admin/direct-orders/(desks)/validations/page.tsx";

/** What counts as stuck, and the traps in asking the database for it. */
function loaderRules() {
  const source = stripComments(read(LOADER));

  // Active, still pending_review — the venue's own state, which is the question the panel asks.
  assert.match(source, /\.eq\("active", true\)/);
  assert.match(source, /\.eq\("verification_status", "pending_review"\)/);

  // "No LIVE claim", not "no claim at all": a venue whose only claim was REJECTED is back to having
  // nothing in front of the desk, which is exactly the stuck state this panel exists to show.
  assert.match(source, /if \(String\(claim\.status \?\? ""\) !== "rejected"\) venuesWithLiveClaim\.add\(/);
  assert.match(source, /!venuesWithLiveClaim\.has\(String\(venue\.id\)\)/);

  // Chunked at 50. An `.in()` whose header outgrows PostgREST returns zero rows and NO error, and an
  // empty claims answer here would list every venue as stuck — including ones the desk is working.
  assert.match(source, /index \+= 50/);

  // Gated to the viewers who decide every claim; an SFE Manager's desk is invoice claims only.
  assert.match(source, /if \(!canDecideDirectOrderPharmacyValidations\(access\)\) return \[\];/);

  // Never throws — a panel must not cost the desk its real work.
  assert.match(source, /if \(error\) return \[\];/);

  // Money first: the panel's job is to put the largest unwatched thing at the top.
  assert.match(source, /\.sort\(\(a, b\) => b\.ordersValue - a\.ordersValue/);

  // Names, never HR ids (owner's standing rule), and the join must survive mixed-case ids — the
  // column holds both spellings and an exact-cased `.in()` silently returns nothing.
  assert.match(source, /raisedByName/);
  assert.match(source, /toLowerCase\(\)\), \.\.\.hrIds\.map\(\(id\) => id\.toUpperCase\(\)\)/);
}

/** The panel is a LIST, not a queue — and it keeps the house rules. */
function panelRules() {
  const panel = stripComments(read(PANEL));

  // 🔴 NO ACTION CONTROL, EVER. What is missing is a rep standing in front of the venue; only the
  // order's own requester may capture, because the GPS check runs against THEIR area. A button here
  // would invite a photograph of a place the admin never stood — evidence that looks like proof.
  assert.ok(!/<button|onClick|<form/.test(panel), "the stuck-venues panel must offer no action control");
  assert.ok(!/"use client"/.test(panel), "it is a read-only server component");

  // Square edges, no ellipsis, no horizontal scroll: the two golden rules.
  assert.ok(!/\brounded(-|\b)/.test(panel), "no rounded corners (square-edge golden rule)");
  assert.ok(!/truncate|text-ellipsis|line-clamp|…/.test(panel), "never truncate owner-facing text");
  assert.ok(!/overflow-x-auto|min-w-\[|whitespace-nowrap/.test(panel), "fit by merging columns, never by scrolling");

  // Desktop tables, mobile cards — the admin shell's rule — over ONE fixed grid with its own colgroup.
  assert.match(panel, /table-fixed/);
  assert.match(panel, /<colgroup>/);
  assert.match(panel, /hidden w-full table-fixed md:table/);
  assert.match(panel, /md:hidden/);

  // Cairo, never raw UTC, and Arabic venue names need their own direction.
  assert.match(panel, /timeZone: "Africa\/Cairo"/);
  assert.match(panel, /dir="auto"/);

  // An empty list says so in words rather than rendering a frame that reads as a failed load.
  assert.match(panel, /Nothing is sitting here/);
}

/** It hangs under the desk's real work, and only for the viewer who can act on the whole desk. */
function deskPageWiring() {
  const page = stripComments(read(PAGE));
  assert.match(page, /import \{ StuckVenuesPanel \} from "@\/components\/direct-orders\/stuck-venues-panel"/);
  assert.match(page, /listDirectOrderStuckVenues\(access\)/);
  // Loaded beside the claims, not after them — the desk already makes several round trips.
  assert.match(page, /const \[rows, stuckVenues\] = await Promise\.all\(\[/);
  // SFE Manager's desk is invoice claims only; a missing FIELD capture is not theirs to chase.
  assert.match(page, /\{decidesEveryClaim \? <StuckVenuesPanel venues=\{stuckVenues\} \/> : null\}/);
  // BELOW the desk: a claim awaiting a decision is the job; this is the blind spot beside it.
  const deskAt = page.indexOf("<ValidationDesk");
  const panelAt = page.indexOf("<StuckVenuesPanel");
  assert.ok(deskAt >= 0 && panelAt > deskAt, "the panel must render under the desk, never above it");
}

export async function runDirectOrderStuckVenuesTests() {
  loaderRules();
  panelRules();
  deskPageWiring();
}
