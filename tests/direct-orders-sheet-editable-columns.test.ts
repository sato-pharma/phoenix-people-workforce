import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The team's own columns on the live Direct Orders sheet (owner request, 2026-08-06).
//
// Phoenix rewrites columns 1..cols every minute. The team's block sits after that, and the whole
// design turns on one thing: a note belongs to an ORDER, not to a row. Rows move on every refresh —
// an order is approved, a new one arrives, and row 12 is now a different request. A note left
// behind at row 12 does not disappear; it silently re-attaches to somebody else's order, in a
// report about money, and nothing on screen says so.
//
// Every assertion here is aimed at that failure and at the ordering that prevents it, because both
// are invisible: the sheet looks perfectly normal either way.
// ─────────────────────────────────────────────────────────────────────────────

export function runDirectOrdersSheetEditableColumnsTests() {
  const source = readFileSync(new URL("../docs/direct-orders-live-sheet.gs", import.meta.url), "utf8");

  // ── The block sits outside everything Phoenix rewrites ────────────────────
  assert.match(
    source,
    /function editableStartCol\(cols\) \{\s*return cols \+ 1;/,
    "the team's block must begin immediately after Phoenix's own columns — a fixed column number " +
      "would be silently overwritten the day a column is added to the report",
  );
  for (const bounded of [
    /sheet\.getRange\(ROW_DATA, 1, values\.length, cols\)\.setValues\(values\)/,
    /sheet\.getRange\(ROW_DATA \+ values\.length, 1, tail, cols\)\.clearContent\(\)/,
  ]) {
    assert.match(
      source,
      bounded,
      "the refresh write and its tail clear must both stay bounded by `cols`; widening either to " +
        "the sheet's full width would erase the team's notes once a minute",
    );
  }

  // ── Keyed by Request ID, never by row ─────────────────────────────────────
  assert.match(
    source,
    /var NOTES_KEY_HEADER = "Request ID";/,
    "notes must be keyed on the Request ID column the report already renders",
  );
  const capture = source.slice(source.indexOf("function captureEditableByRequestId"));
  assert.match(
    capture.slice(0, 1400),
    /var id = String\(ids\[r\]\[0\] \|\| ""\)\.trim\(\);/,
    "the capture must read the id sitting on each row, which is the only pairing still true at " +
      "that moment",
  );
  const paint = source.slice(source.indexOf("function paintEditable"));
  assert.match(
    paint.slice(0, 900),
    /store\[orderedIds\[r\]\]/,
    "the repaint must look each note up BY ID against the new row order — indexing the store by " +
      "row number is exactly how a note lands on a different order",
  );

  // ── The ordering that makes it work ───────────────────────────────────────
  // buildOrdersFrame calls resetSheet. Capturing after it would read a sheet that has just been
  // wiped, and the notes typed since the last refresh would be gone with no error anywhere.
  const captureAt = source.indexOf("var captured = captureEditableByRequestId(sheet, header, cols);");
  const rebuildAt = source.indexOf("if (rebuild) buildOrdersFrame(sheet, header, cols);");
  const writeAt = source.indexOf("sheet.getRange(ROW_DATA, 1, values.length, cols).setValues(values)");
  assert.notEqual(captureAt, -1, "the capture must exist");
  assert.notEqual(rebuildAt, -1, "the frame rebuild must exist");
  assert.ok(
    captureAt < rebuildAt,
    "the capture must run BEFORE buildOrdersFrame — that function calls resetSheet, so capturing " +
      "afterwards reads an already-wiped sheet and loses every note typed since the last refresh",
  );
  assert.ok(
    captureAt < writeAt,
    "the capture must run BEFORE the rewrite, while each row still pairs with its own order",
  );

  // ── The durable store, for orders that leave and come back ────────────────
  assert.match(
    source,
    /var NOTES_TAB = "_Phoenix notes \(do not delete\)";/,
    "a hidden store must exist: an order leaves this report when it is approved or expires, and " +
      "without the store its note would be gone for good the moment it dropped off the list",
  );
  assert.match(source, /sheet\.hideSheet\(\);/, "the store must be hidden, not another tab to maintain");
  // Scoped to buildOrdersSheet's own body, and it took two wrong attempts to get here. Comparing
  // the store write to the PHOENIX write proved nothing — moving it before the repaint is still
  // after that. Comparing it to lastIndexOf("paintEditable(") then failed against correct code,
  // because the function's own DEFINITION sits later in the file than the calls do.
  const fnStart = source.indexOf("function buildOrdersSheet(");
  const fnEnd = source.indexOf("\nfunction ", fnStart + 1);
  assert.ok(fnStart !== -1 && fnEnd > fnStart, "buildOrdersSheet must exist");
  const fn = source.slice(fnStart, fnEnd);
  const storeWriteAt = fn.indexOf("writeNotesStore(ss, store);");
  const lastPaintAt = fn.lastIndexOf("paintEditable(sheet, cols,");
  assert.notEqual(storeWriteAt, -1, "the store must be written back inside the refresh");
  assert.ok(
    storeWriteAt > lastPaintAt,
    "the store must be written AFTER the last repaint, so a refresh that dies midway leaves it as " +
      "it was rather than half-updated",
  );

  // ── Bounds, or the whole refresh dies over an empty note ──────────────────
  assert.match(
    source,
    /function ensureColumns\(sheet, needed\)/,
    "a new sheet is 26 columns wide and this needs 51 — without ensureColumns every getRange past " +
      "the edge throws and the refresh dies on a sheet that has never been built",
  );
  assert.match(
    capture.slice(0, 1400),
    /if \(sheet\.getMaxRows\(\) < needRows \|\| sheet\.getMaxColumns\(\) < needCols\) return out;/,
    "the capture must bail out on a sheet too small to hold the block, rather than throwing and " +
      "aborting the refresh",
  );

  // ── The status list must not reject what it has not caught up with ────────
  assert.match(
    source,
    /\.setAllowInvalid\(true\)/,
    "the status dropdown must accept a value outside its list — refusing it sends the person back " +
      "to typing in a Phoenix column, where it is erased within the minute",
  );

  // ── Findable, because nothing is locked ───────────────────────────────────
  // The owner chose not to protect the Phoenix columns, so the only thing telling someone which
  // block keeps their typing is that it looks different.
  assert.match(
    source,
    /setValue\("YOURS ▸ kept on refresh"\)/,
    "the team's block must announce itself: with nothing locked, being visibly different is the " +
      "only thing that stops someone typing where it will be erased",
  );
  assert.equal(
    (source.match(/\{ label: "/g) ?? []).length >= 6,
    true,
    "the six agreed columns must be declared",
  );
  for (const label of [
    "Month proposed (team)",
    "Note",
    "Follow-up owner",
    "Follow-up date",
    "Status (team)",
    "Collection / payment note",
    "Extra",
  ]) {
    assert.ok(source.includes(`label: "${label}"`), `the "${label}" column must exist`);
  }

  // ── The golden rule keeps its gate ────────────────────────────────────────
  // Setting the real sales month is what INJECTS the sales (spec C2), and only Finance or a Super
  // Admin may do it. The team's column is a PROPOSAL that sits beside Phoenix's own; the two must
  // never become one. Made editable in place it would be erased within the minute while the person
  // believed the order was booked; made to write back it would let anyone holding the share link
  // inject sales, and that link is deliberately shared with people who have no Phoenix account.
  assert.ok(
    source.includes('label: "Month proposed (team)"'),
    "the team's month must be a separate PROPOSAL column, never Phoenix's own Sales month",
  );
  assert.ok(
    !EDITABLE_LABELS(source).includes("Sales month"),
    "\"Sales month\" must never appear in the editable block — that column is the C2 trigger, and " +
      "the sheet is shared with people who have no Phoenix account at all",
  );
  assert.match(
    source,
    /Finance still books it in Phoenix\./,
    "the reason must stay written down beside the column, or the next person moves the gate " +
      "without knowing there was one",
  );
}

/** The labels declared inside EDITABLE_COLUMNS only — not every label in the file. */
function EDITABLE_LABELS(source: string): string[] {
  const start = source.indexOf("var EDITABLE_COLUMNS = [");
  const end = source.indexOf("];", start);
  return [...source.slice(start, end).matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
}
