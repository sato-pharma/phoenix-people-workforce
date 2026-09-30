import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  factInk,
  FILLED_BY_VALIDATING,
  gradeInk,
  listRowFacts,
  NO_GRADE,
  NOT_RECORDED,
  type ListRowFactsInput,
} from "../src/lib/phoenix-crm/list-row-facts.ts";

/**
 * Phoenix CRM — the List row says what the REP captured, and names what is still empty.
 *
 * 🔴 THE OWNER'S RULE, 2026-09-30: "the rep list in Phoenix CRM will be exactly the same [as the old
 * Reps List]. And when the rep validates it, the validation will OVERRIDE the iReports360 data — the
 * location and the bricks and everything. And any missing data from iReports360, you will make a
 * PLACEHOLDER for it, because when he comes to validate it he finds what he wants."
 *
 * Before this, the board read ONE source per section and never the other: a row waiting to be
 * validated printed the vendor's address only, and a validated row printed its places only. So a
 * validated customer whose captured place carried no street printed nothing at all, and a captured
 * address never replaced the vendor's — the override the owner is describing did not exist.
 */

const bare: ListRowFactsInput = {
  grade: null,
  listType: "PM",
  places: [],
  reference: null,
  speciality: null,
  validatedAt: null,
};

const place = (over: Partial<ListRowFactsInput["places"][number]> = {}) => ({
  address: null,
  areaName: null,
  brickName: null,
  label: null,
  lat: 30.5667,
  lon: 30.9833,
  zone: null,
  ...over,
});

const reference = (over: Partial<NonNullable<ListRowFactsInput["reference"]>> = {}) => ({
  address: null,
  areaName: null,
  brickName: null,
  city: null,
  zone: null,
  ...over,
});

export function runPhoenixCrmListRowFactsTests() {
  // ── The override: what he captured beats what the vendor carried ────────────────────────────────
  {
    const both = listRowFacts({
      ...bare,
      places: [place({ address: "12 Gomhoreya St", areaName: "Menoufia 2", brickName: "باجور" })],
      reference: reference({ address: "Somewhere else entirely", areaName: "Giza 3", brickName: "الكيت كات" }),
      validatedAt: "2026-09-30T08:00:00Z",
    });
    assert.equal(both.address.text, "12 Gomhoreya St", "the captured address wins");
    assert.equal(both.address.source, "validated");
    assert.equal(both.brick.text, "باجور", "and so does the captured brick — the whole point of validating");
    assert.equal(both.area.text, "Menoufia 2");
    assert.equal(both.brick.source, "validated");
  }

  // The vendor is the FALLBACK, not the loser: a customer with nothing captured still reads.
  {
    const only = listRowFacts({
      ...bare,
      reference: reference({ address: "9 Nile St", brickName: "الكيت كات", city: "Giza", zone: "Agouza" }),
    });
    assert.equal(only.address.text, "9 Nile St · Agouza · Giza", "address, part of town, city — in that order");
    assert.equal(only.address.source, "reference");
    assert.equal(only.brick.text, "الكيت كات");
    assert.equal(only.brick.source, "reference");
  }

  // A captured place with no street falls back through the rep's own words for it, then the part of
  // town — and only then to the vendor. This is the case the old board printed as blank.
  {
    const labelled = listRowFacts({ ...bare, places: [place({ label: "The clinic behind the mosque" })], validatedAt: "2026-09-30T08:00:00Z" });
    assert.equal(labelled.address.text, "The clinic behind the mosque");
    const zoned = listRowFacts({ ...bare, places: [place({ zone: "Agouza" })], validatedAt: "2026-09-30T08:00:00Z" });
    assert.equal(zoned.address.text, "Agouza");
    const fallsBack = listRowFacts({
      ...bare,
      places: [place({ brickName: "باجور" })],
      reference: reference({ address: "9 Nile St" }),
      validatedAt: "2026-09-30T08:00:00Z",
    });
    assert.equal(fallsBack.address.text, "9 Nile St", "a place with no address of its own still shows the vendor's");
    assert.equal(fallsBack.brick.text, "باجور", "while its own brick still wins");
  }

  // ── The placeholder: never a blank cell, and it names what fills it ──────────────────────────────
  {
    const empty = listRowFacts(bare);
    for (const field of ["address", "brick", "area", "speciality", "grade"] as const) {
      const fact = empty[field];
      assert.notEqual(fact.text.trim(), "", `${field}: a List row never prints an empty cell`);
      assert.doesNotMatch(fact.text, /missing|blocked|cannot|must|unknown|n\/a|—/i, `${field}: "${fact.text}" — a placeholder is an invitation, never a complaint`);
    }
    assert.equal(empty.address.text, FILLED_BY_VALIDATING, "not validated: the placeholder names the act that fills it");
    assert.equal(empty.brick.text, FILLED_BY_VALIDATING);
    assert.equal(empty.speciality.text, FILLED_BY_VALIDATING);
    assert.equal(empty.address.source, "placeholder");

    // 🔴 Once he HAS validated, telling him to validate is wrong — he already did.
    const done = listRowFacts({ ...bare, validatedAt: "2026-09-30T08:00:00Z" });
    assert.equal(done.address.text, NOT_RECORDED, "validated: the placeholder states the gap instead of repeating the act");
    assert.equal(done.brick.text, NOT_RECORDED);
    assert.equal(done.address.source, "placeholder");

    // The grade is the CRM's own and has no second source, so it reads the same either way.
    assert.equal(empty.grade.text, NO_GRADE);
    assert.equal(done.grade.text, NO_GRADE);
    assert.equal(listRowFacts({ ...bare, grade: "A" }).grade.text, "Grade A");
  }

  // 🔴 A customer met OUTSIDE the list is captured at the door and carries a place long before he is
  //    admitted. `validatedAt` is the stamp, not "has a place" — so his empty fields must not tell
  //    him to validate a customer he already validated... but he is not admitted, so the invitation
  //    is still the honest one. The stamp is what decides it, and this pins which fact is read.
  {
    const outside = listRowFacts({ ...bare, places: [place({ brickName: "باجور" })] });
    assert.equal(outside.brick.text, "باجور", "his capture still wins");
    assert.equal(outside.address.text, FILLED_BY_VALIDATING, "and the stamp, not the place, chooses the placeholder");
  }

  // ── 🔴 THE FULL ADDRESS IS CLICKABLE (owner, 2026-09-30) ────────────────────────────────────────
  //
  // "You were writing the FULL address and the full address was CLICKABLE." A captured place has an
  // exact point, so it opens a PIN; an address with only words behind it opens a SEARCH, qualified by
  // its locality because a bare Egyptian street name resolves almost anywhere and a rep who drives to
  // the wrong governorate has been actively misled.
  {
    const pinned = listRowFacts({ ...bare, places: [place({ address: "12 Gomhoreya St" })], validatedAt: "2026-09-30T08:00:00Z" });
    assert.match(pinned.mapsHref ?? "", /query=30\.5667%2C30\.9833/, "a captured place opens a pin on its own point");

    const searched = listRowFacts({ ...bare, reference: reference({ address: "9 Nile St", city: "Giza" }) });
    assert.match(searched.mapsHref ?? "", /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
    assert.match(searched.mapsHref ?? "", /Giza/, "the locality qualifies the search, or the street resolves anywhere");

    // 🔴 A PLACEHOLDER IS NEVER A LINK — there is nothing to drive to, and a search on the words
    //    "Set when you validate" would send him to the middle of nowhere.
    assert.equal(listRowFacts(bare).mapsHref, null);
    assert.equal(listRowFacts({ ...bare, validatedAt: "2026-09-30T08:00:00Z" }).mapsHref, null);

    // The POINT wins for the link even when the WORDS came from the vendor: an exact fix beats a
    // text search every time.
    const mixed = listRowFacts({
      ...bare,
      places: [place({ brickName: "باجور" })],
      reference: reference({ address: "9 Nile St" }),
      validatedAt: "2026-09-30T08:00:00Z",
    });
    assert.equal(mixed.address.text, "9 Nile St");
    assert.match(mixed.mapsHref ?? "", /query=30\.5667%2C30\.9833/, "the captured point still pins it");

    // The FULL address, not a fragment: the resolved street comes FIRST, ahead of a landmark label.
    const full = listRowFacts({
      ...bare,
      places: [place({ address: "6 El-Nour, Sheraton Al Matar, El Nozha, Cairo", label: "behind the mosque" })],
      validatedAt: "2026-09-30T08:00:00Z",
    });
    assert.equal(full.address.text, "6 El-Nour, Sheraton Al Matar, El Nozha, Cairo", "the long drivable address, not the landmark");
  }

  // ── The ink ─────────────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(gradeInk("A"), "text-rose-700", "A is red, as the old Reps List painted it");
    assert.equal(gradeInk("B"), "text-amber-700");
    assert.equal(gradeInk("C"), "text-slate-500");
    assert.equal(gradeInk(null), "text-slate-300", "no grade is the palest");
    assert.match(factInk({ source: "placeholder", text: NOT_RECORDED }), /italic/, "a placeholder is never mistaken for a value");
    assert.doesNotMatch(factInk({ source: "validated", text: "باجور" }), /italic/);
  }

  // ── 🔴 THE OVERRIDE IS A PRECEDENCE, NEVER A WRITE ──────────────────────────────────────────────
  //
  // Nothing may edit the iReports360 mirror to make the board agree with the capture. The two
  // disagree legitimately — a typed record against a GPS fix at the door — and a write is
  // unrecoverable where a precedence can be re-read. The module is pure, so this is its whole risk.
  {
    const rules = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/list-row-facts.ts", import.meta.url), "utf8"));
    assert.doesNotMatch(rules, /supabase|from\(|update\(|upsert\(|insert\(/i, "the resolver reads; it never writes");
    // 🔴 GOLDEN RULE #1: this module is the funnel every List row passes through, which makes it the
    //    one place a check could leak onto the rep's own screen. `ListPlace` carries brickDistanceKm,
    //    accuracyMeters and both raw readings — none of them may ever be named here.
    assert.doesNotMatch(rules, /distance|accuracy|integrity|flag|reading|mocked/i, "nothing on a rep's List row judges him");
  }

  // ── It is actually what the board draws ─────────────────────────────────────────────────────────
  {
    const board = stripComments(readFileSync(new URL("../src/components/phoenix-crm/customer-list-board.tsx", import.meta.url), "utf8"));
    assert.ok(board.includes("const facts = listRowFacts(customer);"), "the table reads the resolver");
    assert.ok(board.includes("listRowFacts(customer).address.text"), "and so does the phone card — one row cannot say two things");
    for (const column of ["Customer", "Specialty", "List", "Brick"]) {
      assert.ok(board.includes(`>\n                            ${column}\n`), `the old Reps List's "${column}" column is on the board`);
    }
    // 🔴 The old board's sixth column scored a rep's check-in against the brick. It stays off.
    assert.doesNotMatch(board, /Confidence|brickDistanceKm/, "Confidence is a check on the rep and never reaches his List");

    // 🔴 THE AREA IS NOT SAID TWICE. The group heading already names brick AND area, and the address
    //    carries the vendor's own region words — a third naming, in a third vocabulary, is what the
    //    owner was looking at ("you duplicated the wrong areas and regions").
    assert.ok(!board.includes("{facts.area.text}"), "the Brick column prints the brick alone");

    // 🔴 THE FULL ADDRESS IS CLICKABLE, and only when there is something to drive to.
    assert.ok(board.includes("<AddressText href={facts.mapsHref}"), "the table's address is the clickable one");
    assert.ok(board.includes('rel="noreferrer"') && board.includes('target="_blank"'), "and it opens away from his day");
    assert.ok(board.includes("if (!href) {"), "a placeholder is never a link");

    // 🔴 A SHARED CUSTOMER IS HIGHLIGHTED, and the row says who and why (owner, 2026-09-30). Pinned
    //    here because it cannot be shown on demand: sharing is rare by construction — 214 real pairs
    //    company-wide — and the rep whose List this was measured on has none, which is the honest
    //    answer and not a silent failure (the loader logs one, and the preview logged zero).
    assert.ok(board.includes('<tr className={shared ? "bg-violet-50" : undefined}'), "a shared row is violet, as the old board had it");
    assert.ok(board.includes("const shared = (customer.sharedWith?.length ?? 0) > 0;"), "and it is the same field the old board reads");
    assert.ok(board.includes("{describeSharing(shared)}"), "the small line names WHO and on what basis — the match is an inference a reader may overrule");
    assert.equal((board.match(/<SharedLine customer=\{customer\} \/>/g) ?? []).length, 2, "on the table row AND the phone card");

    // 🔴 NO "Not validated yet" PILL ON A ROW THAT CARRIES A VALIDATE BUTTON (owner, same session:
    //    "since it has a Validate button beside it, then for sure it is not validated. Be smart").
    assert.ok(!board.includes("PENDING_PILL"), "the button IS the status; a pill repeating it says nothing new");
    // The widths are a table-fixed grid totalling 100%, so the row fits rather than scrolling.
    const widths = /columns=\{\[([^\]]+)\]\}/.exec(board)?.[1] ?? "";
    const total = [...widths.matchAll(/(\d+)%/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    assert.equal(total, 100, `the column widths total ${total}%, not 100% — a row that overflows its grid scrolls sideways`);
  }

  console.log("phoenix-crm list row facts: OK");
}
