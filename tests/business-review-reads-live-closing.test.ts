import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * 🔒 THE BUSINESS REVIEW READS THE LIVE CLOSING ENGINE — owner ruling, 2026-09-28, "use the live one".
 *
 * The Monthly Closing is the one source of truth for sales and targets, and every surface must equal
 * the PUBLISHED closing. The Business Review pack is the third carve-out, after Weekly Sales and
 * Marketing ROI, and this file exists because that makes it look like a BUG to anyone reading the
 * golden rule alone — the obvious "fix" is to repoint it at `phx_closing_publication_snapshot`, and
 * that would be the defect.
 *
 * Measured on production when the ruling was taken: Pedia's August stood +191,226.30 above its
 * published closing on 8 direct-order cells Finance booked after publication, and CNS had 592 cells
 * move between areas at net zero on every line total but up to ±11,877 on one area. Neither may be
 * repaired by republishing, because a published and announced month is never corrected.
 *
 * Account: docs/agents-owner-rules.md, "The Business Review reads live".
 */

const SOURCES = [
  "src/lib/business-review/canonical.ts",
  "src/lib/business-review/service.ts",
  "src/lib/business-review/sources/attribution.ts",
];

export function runBusinessReviewReadsLiveClosingTests() {
  // ── 1. it reads the live engine ────────────────────────────────────────────────────────────────
  {
    const joined = SOURCES.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
    assert.match(
      joined,
      /f_monthly_achievement/,
      "the review must read the live closing engine — that is the whole of this ruling.",
    );
  }

  // ── 2. and never the published snapshot ───────────────────────────────────────────────────────
  // Repointing any of these at the snapshot is the exact "correction" the ruling forbids.
  {
    for (const file of SOURCES) {
      const src = stripComments(readFileSync(file, "utf8"));
      assert.ok(
        !/phx_closing_publication_snapshot/.test(src),
        `${file}: the Business Review reads the LIVE engine (owner, 2026-09-28: "use the live one"). ` +
          `Repointing it at the published snapshot would understate real money — Pedia's August was ` +
          `+191,226.30 above its snapshot on direct orders booked after publication — and would freeze ` +
          `a geography the organogram has since corrected.`,
      );
    }
  }

  // ── 3. and never silences the drift to make the two agree ─────────────────────────────────────
  // Acknowledging the drift is the owner's decision about a month, never a step in rendering a pack.
  {
    for (const file of SOURCES) {
      const src = stripComments(readFileSync(file, "utf8"));
      assert.ok(
        !/phx_acknowledge_closing_drift/.test(src),
        `${file}: the review must never acknowledge closing drift — that is a decision about a ` +
          `published month, and it belongs to the owner, not to a pack being rendered.`,
      );
    }
  }

  // ── 4. the rule is written where a session will actually meet it ──────────────────────────────
  {
    const agents = readFileSync("AGENTS.md", "utf8");
    assert.match(
      agents,
      /THE BUSINESS REVIEW READS THE LIVE ENGINE/,
      "AGENTS.md §4 must carry the carve-out, or the golden rule above it reads as forbidding this.",
    );
    assert.match(
      agents,
      /Weekly Sales, Marketing ROI and the \*\*Business Review pack\*\* are the carve-outs/,
      "AGENTS.md §4: the carve-out list must name all three, or the next session removes this one.",
    );
    const account = readFileSync("docs/agents-owner-rules.md", "utf8");
    assert.match(account, /## The Business Review reads live/, "the account belongs in docs/, not in AGENTS.md.");
    assert.match(account, /\+191,226\.30/, "the account must carry the measured figure the ruling was taken on.");
  }
}
