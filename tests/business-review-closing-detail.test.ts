import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { channelOfClosingRow } from "@/lib/business-review/sources/closing-detail";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The Business Review's customer-grain source — which of the three ways a pound reached the market,
 * and the rules the module must not quietly drop.
 *
 * The loader itself needs a database, so what is pinned here is the CLASSIFICATION (pure) and the
 * two things a future edit could silently remove without any test noticing: the El Qema mask and
 * the figure-window filter. Both are the kind of omission that changes a number a manager reads
 * while every other test stays green.
 */

const SOURCE = "src/lib/business-review/sources/closing-detail.ts";
const PANELS = "src/components/business-review/concentration.client.tsx";

export function runBusinessReviewClosingDetailTests() {
  // ------------------------------------------------------------------ 1. direct wins first
  {
    // Verified on production 2026-09-26: the direct book carries distributor_code DIRECT (61 rows,
    // no client code, the retired vintage) and DirectReq (26 rows, 21 customers).
    assert.equal(
      channelOfClosingRow({ clientCode: "C1", clientName: "صيدلية النور", distributorCode: "DirectReq" }),
      "direct",
      "a direct order is a direct order whoever bought it",
    );
    assert.equal(
      channelOfClosingRow({ clientCode: "C1", clientName: "مخزن الشفاء", distributorCode: "DIRECT" }),
      "direct",
      "including one placed to a warehouse — the question is how the sale was PLACED, then who bought",
    );
    assert.equal(
      channelOfClosingRow({ clientCode: "C1", clientName: "x", distributorCode: "directreq" }),
      "direct",
      "and the code is matched case-insensitively",
    );
  }

  // ------------------------------------------------------------------ 2. wholesaler is a NAME rule
  {
    // There is no column saying a customer is a warehouse. `classifyCustomerChannel` is the one
    // authority, shared with the closing's city split and the venue guard.
    assert.equal(
      channelOfClosingRow({ clientCode: "C9", clientName: "مخزن الشفاء", distributorCode: "PS" }),
      "wholesaler",
      "a warehouse bought from a distributor is a WHOLESALER row, not an ordinary distributor sale",
    );
    assert.equal(
      channelOfClosingRow({ clientCode: "C9", clientName: "صيدلية النور", distributorCode: "PS" }),
      "distributor",
      "and an ordinary pharmacy is the plain distributor channel",
    );
    assert.equal(
      channelOfClosingRow({ clientCode: "C9", clientName: "", distributorCode: "IS" }),
      "distributor",
      "a blank name is evidence of nothing and must not be guessed into a warehouse",
    );
  }

  // ------------------------------------------------------------------ 2b. a rep's row is his AREA's number
  //
  // 🔴 An area routinely carries more than one rep, and targets are set per AREA — there is no
  // per-rep achievement in this system. So the percentage shown against a person's name is the
  // territory's, shared by everyone standing in it. Labelling it "achievement" beside a name would
  // read as a personal score, and a manager acting on a personal score that is really a shared
  // territory figure is the one outcome this table must not produce.
  {
    const panels = stripComments(readFileSync(PANELS, "utf8"));

    assert.ok(
      panels.includes("Area achievement"),
      `${PANELS}: the rep table's percentage column must say "Area achievement". A bare ` +
        `"Achievement" beside a person's name reads as a personal score, and there is no per-rep ` +
        `achievement in this system to back it — targets are keyed per area.`,
    );
    assert.ok(
      panels.includes("Area they stand in"),
      `${PANELS}: the rep table must name the area the person was placed in, or the percentage ` +
        `beside him has no stated subject.`,
    );
    assert.ok(
      /shared by everyone standing in it/.test(panels),
      `${PANELS}: the note saying the figure is shared is gone. It is what stops two reps in one ` +
        `area reading as two people who each scored it.`,
    );
  }

  // ------------------------------------------------------------------ 3. the rules that live in the source
  {
    const source = stripComments(readFileSync(SOURCE, "utf8"));

    // The CALL, not the import. A first draft of this assertion asked only whether the token
    // appeared anywhere, and passed with the mask deleted — the import line alone satisfied it.
    assert.ok(
      source.includes("const kept = withoutMaskedSourceRows("),
      `${SOURCE}: the El Qema mask is GONE. Its detail rows are removed for everyone but the Super ` +
        `Admin, and it carried 41 rows and 30 customers across Jul-Aug 2026 on production — so a ` +
        `concentration figure built from unmasked rows leaks the name through a share that no ` +
        `longer adds up.`,
    );

    // The mask must run on the RAW rows. Masking after the channel split or after any rollup is
    // the defect this asserts against: by then the removed value is already inside a total.
    const maskAt = source.indexOf("withoutMaskedSourceRows");
    const mapAt = source.indexOf("channelOfClosingRow(row)");
    assert.ok(maskAt > 0 && mapAt > 0 && maskAt < mapAt, `${SOURCE}: the mask must run BEFORE anything is derived`);

    assert.ok(
      source.includes("figurePeriods"),
      `${SOURCE}: the load must be cut to the FIGURE window. A month whose distributor files have ` +
        `not landed is held out of every other figure on the page; letting it into this one puts a ` +
        `brick on a chart the achievement beside it does not know about.`,
    );

    assert.ok(
      !/from\(["']source_of_sales_(fact_rollup|import_rows)["']\)/.test(source),
      `${SOURCE}: this module must read the closing's own aggregate RPC, never the raw rows — ` +
        `grouping them here would be a second opinion about what a closing row is worth.`,
    );

    assert.ok(
      source.includes("phx_closing_customers"),
      `${SOURCE}: the aggregate RPC is gone. It is what applies the closing's own placement, the ` +
        `no-bonus price and the direct order's own value.`,
    );
  }
}
