import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  isSalesNotificationExcluded,
  salesNotificationExclusions,
} from "../src/lib/sales/sales-notification-exclusions.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * ONE LIST DECIDES WHO IS LEFT OUT OF A SALES ANNOUNCEMENT, AND BOTH SENDERS READ IT.
 *
 * The owner asked on 2026-08-08 that Sara Samir Jacoub Yohana not be mailed the Monthly Closing
 * publish while she is on long vacation, and on 2026-09-09 he extended the same decision to the
 * weekly upload notification. Her seat, HR record, employment status and vacancy are untouched and
 * must stay that way — this is a mailing decision about a person, not an HR change.
 *
 * 🔴 THE FAILURE IS SILENT IN BOTH DIRECTIONS, WHICH IS WHY IT IS PINNED.
 *
 * A DRIFTED COPY. If each sender carried its own list, removing her from one when she returns leaves
 * the other still skipping her, and adding a second person to one leaves the other still mailing
 * them. Neither produces an error; the mail simply goes to the wrong set, and the only person who
 * would notice is the recipient.
 *
 * A CASE-SENSITIVE MATCH. The closing's original list compared the literal string against
 * `Set.has("B-156")`. HR ids are stored in mixed case across tables, so a seat row returning
 * "b-156" would have answered false and mailed her anyway — the exclusion silently ceasing to apply
 * while still LOOKING present in the source. Canonical-key matching is what closes that, so both
 * casings are asserted rather than assumed.
 */

const CLOSING_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/closing-publish-recipients.ts", import.meta.url)),
  "utf8",
);

const WEEKLY_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/weekly/upload-notification-recipients.ts", import.meta.url)),
  "utf8",
);

/** Source with comments stripped, so a rule quoted in prose cannot satisfy a check. */
function code(source: string): string {
  return stripComments(source);
}

export function runSalesNotificationExclusionsTests() {
  // ── The decision itself ──────────────────────────────────────────────────────────────────────
  assert.ok(
    salesNotificationExclusions().includes("B-156"),
    "Sara Samir stays excluded from sales announcements until the owner says she is back",
  );

  // ── Matched on the canonical key, never the literal string ───────────────────────────────────
  for (const spelling of ["B-156", "b-156", " B-156 ", "b-156".toUpperCase()]) {
    assert.equal(
      isSalesNotificationExcluded(spelling),
      true,
      `"${spelling}" must be excluded — a casing difference silently un-excludes her and the mail goes out`,
    );
  }
  assert.equal(isSalesNotificationExcluded("B-155"), false, "nobody else is excluded by accident");
  assert.equal(isSalesNotificationExcluded(null), false, "an absent HR_ID is not an exclusion");
  assert.equal(isSalesNotificationExcluded(""), false, "a blank HR_ID is not an exclusion");

  // ── Both senders read the shared list, and neither keeps a private copy ──────────────────────
  for (const [label, source] of [
    ["closing publish", CLOSING_SOURCE],
    ["weekly upload", WEEKLY_SOURCE],
  ] as const) {
    const stripped = code(source);
    assert.match(
      stripped,
      /isSalesNotificationExcluded\(/,
      `the ${label} recipients must filter through the shared exclusion helper`,
    );
    // Scoped to the EXCLUDED ids specifically, never "any HR_ID that looks like one": the closing
    // module legitimately names B-155 (Ahmed Sharaf) as a standing Cc, and a pattern broad enough to
    // catch that is a test that false-fails and then gets deleted.
    for (const excluded of salesNotificationExclusions()) {
      assert.ok(
        !stripped.includes(excluded),
        `the ${label} recipients must not hard-code ${excluded} — a second copy is what drifts`,
      );
    }
  }

  // ── The weekly filter sits on the seat list, so it covers the NSM too ────────────────────────
  // Applying it per bucket is the shape that leaves one bucket unfiltered when a bucket is added.
  assert.equal(
    code(WEEKLY_SOURCE).split("isSalesNotificationExcluded(").length - 1,
    1,
    "one filter on the shared seat list — a per-bucket filter is what forgets the next bucket",
  );

  // ── The Regional Sales Manager is cc'd beside the National Sales Manager ─────────────────────
  // Owner, 2026-10-20, asked who receives it: "Add him in cc".
  assert.match(code(WEEKLY_SOURCE), /const RSM_SEAT_TIER = "RSM";/);
  assert.match(
    code(WEEKLY_SOURCE),
    /\.\.\.collect\(rsmHrIds, `\$\{line\} Regional Sales Manager`, seen\)/,
    "the line's Regional Sales Manager is in the weekly upload's cc",
  );
  assert.equal(
    /const to = collect\(dmHrIds,/.test(code(WEEKLY_SOURCE)),
    true,
    "the To line stays the District Managers alone",
  );
}
