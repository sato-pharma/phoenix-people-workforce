import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { rotatedLabel } from "../src/lib/share-links/rotated-label.ts";
import { hashShareToken, shareTokenPreview } from "../src/lib/share-links/token-hash.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A ROTATED SHARE LINK KEEPS ITS FILE GRANT — exactly, never more.
//
// Direct orders and marketing requests rotate their live sheet's feed token every week by minting
// a replacement row and revoking the old one. Both tables carry `allow_files`, NOT NULL DEFAULT
// false, so an insert that forgets the column does not fail. It mints a link that can no longer
// open a single evidence photograph, and nothing anywhere turns red.
//
// That is what happened. Marketing carried the grant from its first rotation (#1799); direct
// orders never did (#1773, #1777, #3159). The direct-orders feed link minted 2026-08-05 15:15 Cairo
// carried allow_files = true, and every link the rotation minted from 2026-08-23 14:00 onwards was
// false — so the owner's live sheet showed a blank "Evidence photo link" column for weeks and the
// file route answered "This link does not carry file access."
//
// The insert is therefore EXECUTED here rather than pattern-matched: the object literal each
// rotation hands to `.insert(` is cut out of the real source at its closing brace and evaluated
// against a fake old row, and the value the database would receive is what gets asserted. A regex
// would accept `old.allowFiles ?? false` — always undefined, so always false — as happily as the
// real column name.
// ─────────────────────────────────────────────────────────────────────────────

/** The two rotations whose table HAS the column. */
const CARRIERS = [
  "../src/lib/direct-orders/sheet-token-rotation.ts",
  "../src/lib/marketing-requests/sheet-token-rotation.ts",
];

/** The third rotation, whose table deliberately does not. */
const CV_LIFECYCLE = "../src/lib/recruitment/cv-lifecycle-sheet-token-rotation.ts";

/**
 * FIXTURES ONLY, and obviously fake on purpose — tests/cv-lifecycle-sheet-token-rotation.test.ts
 * records the day a real token was pasted into a test and `secret-scan` caught it.
 */
const OLD_TOKEN = "EXAMPLE-OLD-TOKEN-0000000000000000";
const NEW_TOKEN = "EXAMPLE-NEW-TOKEN-1111111111111111";

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/**
 * The object literal a rotation passes to `.insert(`, cut at its REAL closing brace — strings and
 * comments skipped — rather than at a fixed byte window, so the file growing around it cannot move
 * the cut.
 */
function insertLiteral(relative: string): string {
  const source = read(relative);
  const call = source.indexOf(".insert({");
  assert.ok(call > -1, `${relative} must still mint its replacement link with .insert({ … })`);
  assert.equal(
    source.indexOf(".insert(", call + 1),
    -1,
    `${relative} gained a second .insert( — this test evaluates the one that mints the replacement link, so make sure it still finds that one`,
  );
  const start = call + ".insert(".length;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index < 0) break;
    } else if (char === "/" && source[index + 1] === "*") {
      index = source.indexOf("*/", index + 2) + 1;
      if (index <= 0) break;
    } else if (char === '"' || char === "'" || char === "`") {
      for (index += 1; index < source.length && source[index] !== char; index += 1) {
        if (source[index] === "\\") index += 1;
      }
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${relative}: the .insert({ … }) literal never closes`);
}

/** The row the database would receive, with `old` standing in for the live link being rotated. */
function mintedRow(relative: string, old: Record<string, unknown>): Record<string, unknown> {
  return vm.runInNewContext(`(${insertLiteral(relative)})`, {
    String,
    expiresAt: String(old.expires_at),
    hashShareToken,
    newToken: NEW_TOKEN,
    old,
    rotatedLabel,
    shareTokenPreview,
  }) as Record<string, unknown>;
}

function liveLink(allowFiles?: boolean): Record<string, unknown> {
  return {
    created_by_hr_id: "EXAMPLE-HR",
    expires_at: "2100-01-01T00:00:00.000Z",
    filters: null,
    label: "Owner live Google Sheet feed",
    passcode_hash: null,
    scope: "all",
    scope_hr_id: "EXAMPLE-HR",
    surface: "feed",
    token: OLD_TOKEN,
    ...(allowFiles === undefined ? {} : { allow_files: allowFiles }),
  };
}

export function runShareLinkRotationAllowFilesTests(): void {
  for (const relative of CARRIERS) {
    // ── 1. THE HEADLINE: a link that opened photographs still opens them ──────
    assert.equal(
      mintedRow(relative, liveLink(true)).allow_files,
      true,
      `${relative} DROPPED THE FILE GRANT: rotating a link with allow_files=true minted one without it, so the column defaulted to false, the live sheet's "Evidence photo link" cells went blank and the file route refused`,
    );

    // ── 2. …and a link that did not, still does not ───────────────────────────
    // A rotation renames a link; it must never widen what the link can reach.
    assert.equal(
      mintedRow(relative, liveLink(false)).allow_files,
      false,
      `${relative} must carry allow_files=false as false — a renamed link must not gain photo access`,
    );
    assert.equal(
      mintedRow(relative, liveLink()).allow_files,
      false,
      `${relative}: an old row with no allow_files at all must mint false — unknown fails closed, never open`,
    );

    // ── 3. The row it copies from must still HAVE the column ─────────────────
    // `old.allow_files ?? false` is only as good as the SELECT that fetched `old`. Narrow that to a
    // column list without allow_files and every rotation quietly mints false again, with the insert
    // above still looking perfectly correct.
    const liveSelect = read(relative).match(/\.select\(("[^"]*")\)\s*\.eq\("surface", "feed"\)/);
    assert.ok(liveSelect, `${relative} must still read the live link with .select(…).eq("surface", "feed")`);
    const columns = JSON.parse(liveSelect[1] ?? '""') as string;
    assert.ok(
      columns === "*" || columns.split(",").some((column) => column.trim() === "allow_files"),
      `${relative} narrowed the live-link SELECT to "${columns}" without allow_files, which re-opens this defect from the read side`,
    );
  }

  // ── 4. The twins mint the same columns ──────────────────────────────────────
  // Marketing is a port of direct orders, and this defect was one column carried by one twin and
  // forgotten by the other. The next column either of them gains is checked against the other here.
  const [directOrders, marketing] = CARRIERS.map((relative) => Object.keys(mintedRow(relative, liveLink(true))).sort());
  assert.deepEqual(
    directOrders,
    marketing,
    "the direct-orders and marketing rotations must mint the same columns — a column one copies and the other forgets is silently defaulted on every rotation",
  );

  // ── 5. The CV-lifecycle table has NO allow_files, and must not be "aligned" ─
  // ats_cv_lifecycle_share_links has no file surface and no such column, by design. Copying the
  // carriers' line into its insert would grant nothing — it would fail every weekly insert on an
  // unknown column, and the rotation with it.
  assert.ok(
    !("allow_files" in mintedRow(CV_LIFECYCLE, liveLink(true))),
    `${CV_LIFECYCLE} must not write allow_files: its table has no such column, so the weekly rotation would fail`,
  );
}
