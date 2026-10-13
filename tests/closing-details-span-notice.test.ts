import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { describeClosingDetailsSpan } from "../src/lib/sales/closing-details-span.ts";
import { describePeriodSelection, periodLabel } from "../src/lib/sales/monthly-closing-period-merge.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE DETAILS TAB IS ONE MONTH, AND IT MUST SAY SO WHEN THE MATRIX IS SEVERAL.
//
// Details exists to check the headline's arithmetic without leaving the page. Fold several months
// together in the picker and the two tabs stop describing the same thing: the merged matrix's
// `period` is the LAST month of the span, the workspace hands that one month to the panel, and the
// panel loads, totals, filters and exports it alone — while the matrix above it totals the whole
// span.
//
// Nothing on screen said so. The rows were never wrong; they were unlabelled, which on a
// reconciliation page reads as the two tabs disagreeing.
// ─────────────────────────────────────────────────────────────────────────────

const PANEL_SOURCE = "src/components/sales/closing-details-panel.tsx";
const WORKSPACE_SOURCE = "src/components/sales/monthly-closing-workspace.tsx";
const MERGE_SOURCE = "src/lib/sales/monthly-closing-period-merge.ts";
const PORTAL_SOURCE = "src/components/sales/portal-monthly-closing-view.tsx";
const STANDALONE_SOURCE = "src/components/sales/closing-details-standalone.tsx";

export async function runClosingDetailsSpanNoticeTests() {
  const span = ["2026-07", "2026-08", "2026-09"];

  // ── 1. The regression: three months above, one month below, and the reader is told ────────────
  const notice = describeClosingDetailsSpan({ period: "2026-09", periodsInView: span });
  assert.ok(notice, "a three-month matrix over one month of Details rows must be disclosed");
  assert.ok(
    notice!.includes(periodLabel("2026-09")),
    `the notice must name the month the rows ARE: ${notice}`,
  );
  assert.ok(
    notice!.includes(describePeriodSelection(span)),
    `the notice must name the span the matrix covers, in the same words the rest of the page uses: ${notice}`,
  );
  assert.ok(
    notice!.includes("2 further months"),
    `the notice must say how many months are in the matrix and not in these rows: ${notice}`,
  );
  assert.ok(
    notice!.includes("Export XLSX"),
    `the export beside the rows is the same single month, so the notice must cover it too: ${notice}`,
  );
  assert.ok(!notice!.includes("…") && !notice!.includes("..."), "no ellipsis in on-screen copy");

  // ── 2. One month says nothing at all ──────────────────────────────────────────────────────────
  assert.equal(
    describeClosingDetailsSpan({ period: "2026-09", periodsInView: ["2026-09"] }),
    null,
    "the ordinary single-month closing must carry no notice",
  );
  assert.equal(
    describeClosingDetailsSpan({ period: "2026-09", periodsInView: [] }),
    null,
    "the portal tab and the standalone details page pass no span, and must stay unchanged",
  );
  assert.equal(describeClosingDetailsSpan({ period: "2026-09" }), null);
  assert.equal(
    describeClosingDetailsSpan({ period: "", periodsInView: span }),
    null,
    "with no month loaded there are no rows to label",
  );

  // ── 3. Duplicates and stray space are folded before counting ──────────────────────────────────
  assert.equal(
    describeClosingDetailsSpan({ period: "2026-09", periodsInView: [" 2026-09 ", "2026-09", ""] }),
    null,
    "the same month repeated is still one month, not a span",
  );
  const folded = describeClosingDetailsSpan({ period: "2026-09", periodsInView: ["2026-08", " 2026-08", "2026-09"] });
  assert.ok(
    folded?.includes("1 further month is"),
    `two distinct months means exactly one month is outside these rows, singular: ${folded}`,
  );

  // ── 4. A month that is not in the span is still described truthfully ──────────────────────────
  const outside = describeClosingDetailsSpan({ period: "2026-06", periodsInView: span });
  assert.ok(
    outside?.includes(periodLabel("2026-06")) && outside.includes("3 further months"),
    `rows from a month the matrix does not even cover must be named, not hidden: ${outside}`,
  );

  // ── 5. It is wired, and only where a span can happen ──────────────────────────────────────────
  const panel = stripComments(readFileSync(PANEL_SOURCE, "utf8"));
  assert.ok(
    panel.includes("describeClosingDetailsSpan"),
    `${PANEL_SOURCE} must render the notice — a disclosure nothing draws is not a disclosure`,
  );
  assert.ok(
    panel.includes("periodsInView"),
    `${PANEL_SOURCE} must accept the months the matrix beside it is showing`,
  );
  const workspace = stripComments(readFileSync(WORKSPACE_SOURCE, "utf8"));
  assert.ok(
    /periodsInView=\{selectedPeriods\}/.test(workspace),
    `${WORKSPACE_SOURCE} must hand the matrix's own months to the Details panel, or the panel can never know it is one month of several`,
  );
  for (const source of [PORTAL_SOURCE, STANDALONE_SOURCE]) {
    assert.ok(
      !stripComments(readFileSync(source, "utf8")).includes("periodsInView"),
      `${source} mounts one month by construction — passing a span there would invent a disclosure`,
    );
  }

  // ── 6. The mechanism the notice exists for is still the mechanism ─────────────────────────────
  const merge = stripComments(readFileSync(MERGE_SOURCE, "utf8"));
  assert.ok(
    merge.includes("periods[periods.length - 1]"),
    `${MERGE_SOURCE} no longer leaves the LAST month of a span in the merged matrix's period. Re-read it: the notice names which single month the Details rows are, and that is where the answer comes from.`,
  );
}
