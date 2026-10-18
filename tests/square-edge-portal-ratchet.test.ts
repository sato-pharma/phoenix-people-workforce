import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Standing owner rule (AGENTS.md §4, THE SQUARE-EDGE GOLDEN RULE): "no round or
// semi-round corners, anywhere."
//
// WHY THIS TEST SCANS ELEVEN FILES AND NOT THE WHOLE TREE
// The rule is enforced in CSS, not by the absence of a class. app/globals.css
// carries two sweeps:
//
//     .admin-shell           [class*="rounded"] { border-radius: 0 !important; }
//     .employee-portal-shell [class*="rounded"] { border-radius: 0 !important; }
//
// and src/styles/tokens.css maps every Tailwind radius step onto a --phx-radius
// that is square. So a `rounded-lg` sitting inside either shell renders SQUARE, and
// counting `rounded-*` across app/ + src/components/ returns 4,434 lines that say
// nothing at all about what a reader sees. A ratchet on that number would be pure
// noise — it would fail on new UI that renders perfectly square. AGENTS.md says as
// much in its own words: "measure computed border-radius, since globals.css's sweep
// is not coverage".
//
// BOTH SWEEPS ARE DESCENDANT SELECTORS. That is the hole. A component rendered with
// `createPortal(node, document.body)` mounts as a direct child of <body> — outside
// `.admin-shell` and outside `.employee-portal-shell` — so neither `!important` rule
// can reach it, and a `rounded-*` class there renders GENUINELY ROUNDED.
//
// This is not theoretical. It is the shape of the breaches that keep recurring:
//   #3286  "the identity card is square as a property of ITSELF, not of its container"
//   #3765  "the screening overlay carries no rounded corner IN ITS SOURCE"
// Both had to be fixed at the source, because no container rule was ever going to
// reach them. Eleven files portal to document.body today and they carry 177
// `rounded-*` lines between them.
//
// WHY A RATCHET
// Those 177 are not all visible defects — many sit on inner elements the modal's own
// styling already squares, and sorting them needs a browser. So the count may FALL
// and may never RISE: a NEW rounded class in a portal that escapes both sweeps is
// caught on the day it is written, and the existing 177 can be retired deliberately.
//
// WHAT IS NOT COUNTED
// `rounded-none` and `rounded-[0…]` (both explicitly square), and any mention inside
// a comment — comments are stripped before anything is measured, and the detector
// self-checks below enforce that rather than merely promising it.
//
// WHAT THIS CANNOT DO
// It cannot prove a corner is square; only `getComputedStyle` in a real browser can.
// It catches the one case where the CSS safety net provably does not apply.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counted 2026-09-24 on origin/main, with comments stripped, over the files under
 * app/ + src/components/ that call createPortal AND name document.body. Lower this
 * when sites are genuinely retired; never raise it to make a red run go green.
 *
 * 177 lines across 11 files at first count. The concentration:
 *   47  employee-portal/plans-workspace.tsx
 *   38  outstation/outstation-requests-admin.tsx
 *   29  outstation/admin-manager-expense-modal.tsx
 *   17  employee-portal/company-calendar.tsx
 *   15  sales/import-preview-modal.tsx
 *
 * If a file leaves this set (it stops portalling to the body, so a shell sweep now
 * covers it) the count drops and this test asks for the baseline to be lowered —
 * which is correct: the ground was genuinely won.
 *
 * LOWERED THREE TIMES, each time because the `count < BASELINE` branch at the foot of
 * this file asked for it: 177 -> 174 in #4692, 174 -> 173 on 2026-10-06 (origin/main at
 * 04ac23842), and 173 -> 156 the same day, when the one-form-design sweep took the
 * hand-written radius out of every form control — seventeen of them were inside a
 * component that portals to document.body, where neither globals.css sweep reaches. Taking the number down is the entire point of a ratchet —
 * while it read 174 a site could be re-added for free and nothing would have gone red,
 * so the ground won was still giveable. The warn branch is not a nag; it is the only
 * moment the count is known to have dropped, and ignoring it silently re-opens the gap.
 * 156 -> 153 on 2026-10-19, the Recruitment premium sweep.
 */
const BASELINE = 153;

const ROOTS = ["app", "src/components"];

/**
 * A file is in scope when it BOTH creates a portal and names document.body. The two
 * are checked separately rather than as one expression because the call is commonly
 * written across several lines:
 *
 *     return createPortal(
 *       modal,
 *       document.body,
 *     );
 *
 * A same-line regex would miss every one of those — four of the eleven are written
 * exactly that way.
 */
const PORTALS = /createPortal/;
const TO_BODY = /document\.body/;

const QUOTED_STRING = /["'`][^"'`\n]*["'`]/g;
const ROUNDED_TOKEN = /\brounded(?:-[a-z0-9[\]().,%#*+-]+)?/g;

/** True when a line applies a radius that is not explicitly zero. */
function appliesARadius(line: string): boolean {
  const quoted = line.match(QUOTED_STRING);
  if (!quoted) return false;
  return quoted.some((literal) => {
    const tokens = literal.match(ROUNDED_TOKEN) ?? [];
    return tokens.some((t) => t !== "rounded-none" && !/^rounded-\[0/.test(t));
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

export function runSquareEdgePortalRatchetTests() {
  const all = ROOTS.flatMap((r) => walk(r));
  assert.ok(
    all.length > 800,
    `only ${all.length} .tsx files were scanned — the walk is not reaching the tree, so any count it reports is meaningless`,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Check the detector against known inputs BEFORE trusting it on the tree.
  // ───────────────────────────────────────────────────────────────────────────
  const countIn = (snippet: string) =>
    stripComments(snippet).split("\n").filter(appliesARadius).length;

  assert.equal(countIn('<div className="rounded-lg border">x</div>'), 1, "a plain class string applying a radius must count");
  assert.equal(countIn("<div className={`p-2 rounded-full ${x}`}>x</div>"), 1, "a template-literal class string must still count");
  assert.equal(countIn('<div className="rounded">x</div>'), 1, "the bare `rounded` utility is still a radius");
  assert.equal(countIn('<div className="md:rounded-xl">x</div>'), 1, "a responsive prefix still applies a radius at that breakpoint");
  assert.equal(countIn('<div className="rounded-none">x</div>'), 0, "rounded-none is explicitly square and is the CORRECT way to write this");
  assert.equal(countIn('<div className="rounded-[0px]">x</div>'), 0, "an arbitrary zero radius is square too");
  assert.equal(countIn('<div className="border shadow-sm">x</div>'), 0, "a class string with no radius token must not count");
  assert.equal(countIn("// this modal uses rounded-lg nowhere"), 0, "a line comment naming the class is prose, not a site");
  assert.equal(countIn("/**\n * no `rounded-full` on the avatar here\n */"), 0, "a JSDoc block naming the class is prose, not a site");
  assert.equal(countIn("{/* rounded-lg was dropped when this went square */}"), 0, "a JSX block comment naming the class is prose, not a site");

  // The scope predicate must select a believable slice — not everything, not nothing.
  const inScope = all.filter((file) => {
    const source = stripComments(readFileSync(file, "utf8"));
    return PORTALS.test(source) && TO_BODY.test(source);
  });
  assert.ok(
    inScope.length >= 5 && inScope.length <= 60,
    `${inScope.length} files were selected as portalling to document.body. That is not a believable ` +
      `slice of ${all.length} files — the predicate is matching everything or nothing, and the count ` +
      `below would be meaningless either way.`,
  );

  const sites: string[] = [];
  for (const file of inScope) {
    const source = stripComments(readFileSync(file, "utf8"));
    source.split("\n").forEach((line, i) => {
      if (appliesARadius(line)) sites.push(`${file.replace(/\\/g, "/")}:${i + 1}`);
    });
  }

  const count = sites.length;

  assert.ok(
    count <= BASELINE,
    `${count - BASELINE} new rounded corner(s) were added inside a component that portals to ` +
      `document.body — the count went ${BASELINE} -> ${count}.\n` +
      `THE SQUARE-EDGE GOLDEN RULE: no round or semi-round corners, anywhere. A portal mounts as a ` +
      `direct child of <body>, OUTSIDE .admin-shell and .employee-portal-shell, so neither ` +
      `globals.css sweep reaches it and this corner really does render rounded.\n` +
      `Write rounded-none, or drop the class — and confirm with getComputedStyle, not by reading the ` +
      `source.\n` +
      `Sites now present:\n  ${sites.slice(-12).join("\n  ")}`,
  );

  // Improvement direction: fewer rounded corners than the baseline is a win, not a failure — a PR
  // must never go red for making the app better. Warn (so the baseline can be lowered later) and
  // pass. The regression guard above (count <= BASELINE) still fails on any NEW rounded corner.
  if (count < BASELINE) {
    console.warn(
      `Good news: rounded corners in body-portalled components dropped ${BASELINE} -> ${count}. Lower ` +
        `BASELINE in this file to ${count} so the ground that was won cannot be given back.`,
    );
  }
}
