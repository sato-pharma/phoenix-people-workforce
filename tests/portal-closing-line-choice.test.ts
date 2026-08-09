import assert from "node:assert/strict";

import { pickPortalClosingLine } from "../src/lib/sales/monthly-closing-portal.ts";

// Which LINE a portal / export closing read loads.
//
// Almost every sales manager holds exactly one line, and for them this is a formality. It stops
// being one for a manager who legitimately covers two — a Product Manager carrying a
// `line_scope_override` of Pedia + Anti Infective (Ahmed Sharaf, B-155, who the publish notification
// already Cc's on EVERY line). Before this existed, the export resolved its Closing Matrix skeleton
// from `loadPortalMonthlyClosing({ access, period })`, which took no line at all and always answered
// with the viewer's OWN employee-record line.
//
// That is not a cosmetic mislabel. buildPortalClosingWorkbook rebuilds the matrix with
// `rebuildMatrixFromRows(matrix, rows, { preserveTargets: true })`: the sales come from the exported
// rows, but the PRODUCT COLUMNS and every TARGET come from the skeleton. So a two-line PM exporting
// his second line received the first line's products and the first line's targets wrapped around the
// second line's rows — and because the exported products had no column to land in, the sales were
// dropped on the floor. Nothing on any sheet said so; it read as a real workbook.
//
// Hence the one rule pinned here: a requested line is either honoured or REFUSED. It is never
// silently traded for a different one. Refusing costs the reader the Matrix + Target sheets (the
// route falls back to the honest rows-only workbook); substituting costs them the truth.

export async function runPortalClosingLineChoiceTests() {
  // ── The ordinary single-line manager: unchanged in both directions ──
  const soloPublished = pickPortalClosingLine({
    allowedLines: ["Pedia"],
    publishedLines: ["Pedia"],
  });
  assert.equal(soloPublished.line, "Pedia", "a one-line manager still lands on their own line");
  assert.deepEqual(soloPublished.availableLines, ["Pedia"], "their line is the only option offered");
  assert.equal(soloPublished.refused, false, "nothing was requested, so nothing is refused");

  const soloUnpublished = pickPortalClosingLine({
    allowedLines: ["Pedia"],
    publishedLines: [],
  });
  assert.equal(
    soloUnpublished.line,
    "Pedia",
    "an unpublished line still resolves, so the caller can name it in 'awaiting publish'",
  );
  assert.deepEqual(soloUnpublished.availableLines, [], "but it is not offered as a choice");

  // ── THE HEADLINE: the exported line is the line that gets loaded ──
  const twoLine = { allowedLines: ["Pedia", "Anti Infective"], publishedLines: ["Pedia", "Anti Infective"] };
  const askedAntiInfective = pickPortalClosingLine({ ...twoLine, requestedLine: "Anti Infective" });
  assert.equal(
    askedAntiInfective.line,
    "Anti Infective",
    "a two-line manager exporting Anti Infective gets the Anti Infective skeleton — NOT Pedia, whose "
      + "targets and product columns would have been written into an Anti Infective workbook",
  );
  assert.equal(askedAntiInfective.refused, false, "an in-scope line is served, not refused");
  assert.equal(
    pickPortalClosingLine({ ...twoLine, requestedLine: "Pedia" }).line,
    "Pedia",
    "and the same call asking for Pedia gets Pedia — the choice is real, not cosmetic",
  );

  // ── Out of scope is REFUSED, never substituted ──
  const outOfScope = pickPortalClosingLine({ ...twoLine, requestedLine: "CNS" });
  assert.equal(outOfScope.line, null, "a line outside the viewer's scope resolves to nothing");
  assert.equal(outOfScope.refused, true, "and says so, so the caller degrades instead of guessing");
  assert.notEqual(
    outOfScope.line,
    "Pedia",
    "it must NOT fall back to the first allowed line — that is exactly the silent substitution "
      + "that produced a Pedia-targeted workbook labelled as another line",
  );
  assert.deepEqual(
    outOfScope.availableLines,
    ["Pedia", "Anti Infective"],
    "a refusal still reports what this viewer COULD have opened",
  );

  // ── In scope but unpublished: still that line, so the message names the right one ──
  const askedUnpublished = pickPortalClosingLine({
    allowedLines: ["Pedia", "Anti Infective"],
    publishedLines: ["Anti Infective"],
    requestedLine: "Pedia",
  });
  assert.equal(
    askedUnpublished.line,
    "Pedia",
    "asking for an allowed-but-unpublished line reports THAT line as awaiting publish",
  );
  assert.equal(
    askedUnpublished.refused,
    false,
    "unpublished is not an access refusal — the viewer holds the line, the month just isn't out",
  );
  assert.deepEqual(
    askedUnpublished.availableLines,
    ["Anti Infective"],
    "only published lines are offered, so the picker can never select a blank sheet",
  );

  // ── No request: prefer a line that actually has something to show ──
  const defaulted = pickPortalClosingLine({
    allowedLines: ["Pedia", "Anti Infective"],
    publishedLines: ["Anti Infective"],
  });
  assert.equal(
    defaulted.line,
    "Anti Infective",
    "with Pedia unpublished, the default lands on the published line rather than an empty one",
  );

  const nothingPublished = pickPortalClosingLine({
    allowedLines: ["Pedia", "Anti Infective"],
    publishedLines: [],
  });
  assert.equal(
    nothingPublished.line,
    "Pedia",
    "with nothing published at all it still names the first allowed line for the empty state",
  );
  assert.deepEqual(nothingPublished.availableLines, [], "and offers no choice");

  // ── Ordering and matching ──
  assert.deepEqual(
    pickPortalClosingLine({
      allowedLines: ["Pedia", "Anti Infective", "CNS"],
      publishedLines: ["CNS", "Pedia"],
    }).availableLines,
    ["Pedia", "CNS"],
    "the picker lists lines in the viewer's own scope order, not in publication order",
  );
  assert.equal(
    pickPortalClosingLine({ ...twoLine, requestedLine: "  anti infective  " }).line,
    "Anti Infective",
    "a line arrives from a URL or a JSON body, so matching is trimmed and case-insensitive — and it "
      + "returns the CANONICAL spelling, which is what the closing RPCs and the publication table key on",
  );

  // ── Nothing to open at all ──
  const noLines = pickPortalClosingLine({ allowedLines: [], publishedLines: [] });
  assert.equal(noLines.line, null, "a viewer with no line resolves to nothing");
  assert.equal(noLines.refused, false, "which is an absence, not a refusal");
  assert.equal(
    pickPortalClosingLine({ allowedLines: [], publishedLines: [], requestedLine: "Pedia" }).refused,
    true,
    "but asking for a line while holding none IS a refusal",
  );
}
