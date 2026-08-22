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

/**
 * The WHOLE of one Apps Script function, and nothing past it: bounded by its own closing brace at
 * column 0, which is a real end.
 *
 * Every pin below used to take a fixed byte count instead, and three of the five were already
 * wrong when this was written. Measured against the live file:
 *
 *   headerMatches        1,002 bytes read through a   900-byte window — 102 bytes invisible, and
 *                        one of its two checks is a `!includes("sheet.getLastColumn()")`, so
 *                        anything down there would have PASSED
 *   paintEditable          669 bytes read through a   900-byte window — 231 bytes of the NEXT
 *                        function, whose text the assertion could have matched instead
 *   buildEditableFrame   2,190 bytes read through a 2,200-byte window — ten bytes of headroom on
 *                        a `doesNotMatch`, which goes blind rather than red when it runs out
 *
 * A byte count measures how long the function happens to be, never the invariant it claims to
 * guard, and it fails silently in both directions.
 */
function scriptFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) return "";
  const rest = source.slice(start + 1);
  const close = rest.search(/^\}/m);
  return source.slice(start, close >= 0 ? start + 2 + close : source.length);
}

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
  const capture = scriptFunction(source, "captureEditableByRequestId");
  assert.match(
    capture,
    /var id = String\(ids\[r\]\[0\] \|\| ""\)\.trim\(\);/,
    "the capture must read the id sitting on each row, which is the only pairing still true at " +
      "that moment",
  );
  const paint = scriptFunction(source, "paintEditable");
  assert.match(
    paint,
    /store\[orderedIds\[r\]\]/,
    "the repaint must look each note up BY ID against the new row order — indexing the store by " +
      "row number is exactly how a note lands on a different order",
  );

  // ── The ordering that makes it work ───────────────────────────────────────
  // buildOrdersFrame calls resetSheet. Capturing after it would read a sheet that has just been
  // wiped, and the notes typed since the last refresh would be gone with no error anywhere.
  const captureAt = source.indexOf("var captured = captureEditableByRequestId(sheet, header, cols);");
  // Anchored on the CALL, not on the whole `if (rebuild) …;` line — that line became a block when
  // the style stamp was added, and an assertion pinned to its exact text failed against code that
  // was perfectly correct.
  const rebuildAt = source.indexOf("buildOrdersFrame(sheet, header, cols);");
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
    capture,
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

  // ── The frame must actually RUN, not merely exist ─────────────────────────
  // The first version shipped with a builder that was never called on a real sheet: it hung off
  // `rebuild`, and rebuild is false whenever Phoenix's own columns are unchanged — which is every
  // existing sheet. The owner pasted the script and got seven unstyled, unlabelled columns. The
  // original test asserted the builder EXISTED and was called from buildOrdersFrame; it never
  // asserted the path taken when nothing about Phoenix's layout changed.
  assert.match(
    source,
    /else if \(!editableFrameReady\(sheet, cols\)\) buildEditableFrame\(sheet, cols\);/,
    "the team's block must be painted on the NOT-rebuilding path too — on a sheet whose Phoenix " +
      "columns are unchanged, buildOrdersFrame never runs and the block would stay unstyled forever",
  );
  assert.match(
    source,
    /function editableFrameReady\(sheet, cols\)/,
    "a readiness check must exist so the frame heals itself instead of depending on a rebuild",
  );

  // ── headerMatches must not see the team's block ───────────────────────────
  // Comparing getLastColumn() to Phoenix's width made the answer depend on anything to the RIGHT
  // of the table. Empty, the widths matched and the frame was never built; populated, they stopped
  // matching and the entire layout rebuilt every minute — flicker and mid-read column resizing.
  const matcher = scriptFunction(source, "headerMatches");
  assert.ok(
    !matcher.includes("sheet.getLastColumn()"),
    "headerMatches must not measure the sheet's full width: the team's block sits to the right of " +
      "Phoenix's columns, so getLastColumn() makes a note the trigger for a full layout rebuild",
  );
  assert.match(
    matcher,
    /sheet\.getRange\(at, 1, 1, header\.length\)/,
    "the header comparison must be bounded by Phoenix's own column count",
  );

  // ── A restyle must actually reach a sheet that already exists ─────────────
  // Styling lives in buildOrdersFrame, which only runs when the column set changes. A pure restyle
  // changes no header, so without a stamp an existing sheet keeps the old look forever and pasting
  // a new script appears to do nothing. That is exactly how the editable block shipped invisible.
  assert.match(
    source,
    /var STYLE_VERSION = "/,
    "a style stamp must exist, or a restyle can never reach a sheet that has already been built",
  );
  assert.match(
    source,
    /var restyled = PropertiesService\.getDocumentProperties\(\)\.getProperty\(STYLE_STAMP_KEY\) !== STYLE_VERSION;/,
    "the style stamp must be read",
  );
  // Asserted on the DECISION, not on the declaration. Checking only that `restyled` exists left
  // the assertion green when it was deleted from the rebuild expression — the stamp was computed
  // and then ignored, which is the same as not having one.
  assert.match(
    source,
    /var rebuild = restyled \|\| !headerMatches\(sheet, header, ROW_HEADER\);/,
    "the rebuild decision must actually USE the style stamp — a stamp that is read and then " +
      "ignored repaints nothing, and the restyle never reaches a sheet that already exists",
  );
  assert.match(
    source,
    /setProperty\(STYLE_STAMP_KEY, STYLE_VERSION\)/,
    "the stamp must be written after the rebuild, or every refresh repaints the whole layout",
  );

  // ── One palette, no near-misses ───────────────────────────────────────────
  // It shipped with three raw hex values found nowhere else in the workbook — a muddy orange
  // beside ORANGE, an off-white beside TILE_BG. Near-misses of a house colour read as bolted on.
  const frame = scriptFunction(source, "buildEditableFrame");
  assert.doesNotMatch(
    frame,
    /#[0-9a-fA-F]{6}/,
    "the team's block must use the workbook's own constants, never a raw hex value — the owner's " +
      "standing rule is to match the module's design identity, never invent a one-off look",
  );

  // ── Every cell centred (owner's rule, 2026-08-06) ─────────────────────────
  assert.ok(
    (source.match(/setHorizontalAlignment\("center"\)/g) ?? []).length >= 5,
    "the total bar, the header, the body, the numeric columns and the team's block must all be " +
      "centred — a half-centred sheet looks like a mistake rather than a choice",
  );
  assert.doesNotMatch(
    scriptFunction(source, "buildOrdersFrame"),
    /setHorizontalAlignment\("right"\)/,
    "no column on the orders tab may stay right-aligned once the sheet is centred",
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
