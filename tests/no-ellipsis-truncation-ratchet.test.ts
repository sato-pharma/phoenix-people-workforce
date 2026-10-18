import assert from "node:assert/strict";
import path from "node:path";

import { cachedIsDirectory, cachedReaddir, cachedReadFile } from "./support/source-corpus.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Standing owner rule: "Never truncate text with an ellipsis and never let text
// wrap to multiple lines in the UI."
//
// Both halves matter at once, and that is exactly why this cannot be a codemod.
// Deleting `truncate` satisfies the first half by violating the second: the text
// stops being cut off and starts wrapping instead. The correct fix is per-site
// layout work — widen the column, let the table scroll, shorten the label — and
// there were 292 real sites when this was counted honestly, across 126 files.
//
// So this test does not try to fix them. It RATCHETS. The count may fall and may
// never rise, which means:
//
//   - new UI is held to the rule from the day it is written, and
//   - the existing 292 can be retired deliberately, screen by screen, with the
//     baseline lowered as they go.
//
// A count that goes UP is a new violation somebody just added. A count that goes
// DOWN is good news and this test says so, because a stale-high baseline quietly
// re-opens the door to the number it was lowered from.
//
// WHAT COUNTS
// Only a CSS truncation class inside a quoted class string, in CODE. A JS identifier
// named `truncate`, an Excel column truncation in an export, or the word in a comment
// is not a UI ellipsis and is not counted — comments are stripped before anything is
// measured, and that is now enforced by the detector self-checks in the body below
// rather than merely promised in this paragraph.
//
// It was promised here and untrue from the day this landed. The first count of 298
// included SIX prose mentions, and five of those six were comments explaining why the
// author had deliberately NOT used the class — the ratchet was spending its headroom
// on documentation of compliance. #2571 then lost a full CI round when a seventh such
// comment pushed the count to 299: a production revert held up by a sentence
// describing the very rule it was obeying.
//
// WHAT IS NOT A VIOLATION
// The ~460 "…" characters in progress text — "Loading…", "Approving…", "Opening
// WhatsApp…". Those are a progress indicator, not truncation: nothing is being
// hidden from the reader. Sweeping them would be a regression dressed up as
// compliance, so they are out of scope by design, not by oversight.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counted 2026-08-28 on commit aeab6be5, with comments stripped. Lower this when
 * sites are genuinely retired; never raise it to make a red run go green.
 *
 * Was 298 when first counted on 80ba78f2 (Phase 5). That figure counted six prose
 * mentions as violations, so it never described the UI. Nothing changed on screen
 * when it moved to 292 — only the measurement stopped being wrong.
 *
 * 292 -> 285 on 2026-08-30: seven sites went with the unreachable components deleted
 * in the module audit's phase 1. Nothing changed on screen for these either — every
 * one of them sat in a file no route could reach.
 *
 * 285 -> 273 later the same day: twelve went with the generic Admin Command Center,
 * retired in the audit's phase 5. Same story a third time — a role sweep found that
 * no role landed on that page, so none of its twelve truncations was on anyone's
 * screen to begin with. Deleting a dead file is the cheapest way this count falls,
 * and it is the only way it has fallen so far; the ~273 that remain are on live
 * screens and each needs its own fix.
 *
 * 273 -> 271 on 2026-09-02, and these two are the FIRST to fall the expensive way:
 * both were on a live screen, in the notifications bell, and were fixed rather than
 * deleted. They were also the panel's only ellipsised text — one of them hid 2556px
 * of a metadata value inside a 161px box, which is how the rendered `idempotencyKey`
 * managed to sit in front of the owner unnoticed. `truncate` -> `break-words`.
 *
 * 271 -> 254 on 2026-09-03: seventeen fell the expensive way in one pass, all in the
 * employee portal, when the owner asked for it to be polished end to end. Every one
 * was on a live screen and every one was fixed rather than deleted. The boards were
 * the worst of them: they truncated the one thing on a row that identifies it, a
 * person's name, so "Hana Abdelaziz Samir Abdelaziz Ghoniem" and a colleague sharing
 * her first two names were the same row to a reader. `truncate` -> `break-words`,
 * with `break-all` reserved for filenames, which have no spaces to break at.
 *
 * 254 -> 245 later the same day, in the same premium-polish pass, fixing every
 * `text-ellipsis whitespace-nowrap` site in the marketing-request customer
 * validation flow. Three were admin headers ("Customer Validation" and two
 * siblings); one was the portal twin of the same page; three more were in the
 * customer-validation workspace, including the row heading that carries a
 * CUSTOMER'S OWN NAME — the exact shape this file's history keeps falling on. Every
 * one fixed by wrapping, none deleted.
 *
 * 245 -> 240 in the same pass, clearing the LAST five raw-property sites, all in
 * Area Consolidation. These were the awkward ones: written deliberately as
 * `md:overflow-hidden md:text-ellipsis md:whitespace-nowrap`, wrapping on a phone
 * and clipping only from md: up, and each carried a comment explaining that as the
 * best answer available — because the house rule then had TWO halves, never truncate
 * AND never wrap, which cannot both hold for a 97-character sentence in a 303px slot.
 * AGENTS.md §4 has since retired the second half outright ("where they collide,
 * WRAPPING wins"), so the compromise had nothing left defending it. One of the five
 * clipped the employee names the owner reads before pressing the button that moves
 * their rows. All five now wrap at every size, and their comments were corrected
 * rather than left teaching the retired rule.
 *
 * `text-ellipsis` (the raw property, as opposed to Tailwind's `truncate` shorthand)
 * is now at zero occurrences in app/ and src/, in every responsive prefix. An earlier
 * revision of this note claimed that one commit too early: the unprefixed form was
 * gone, the five `md:`-prefixed ones were not, and a plain grep for the unprefixed
 * string is what made them invisible. The remaining 240 are all `truncate` or
 * `line-clamp-*`.
 *
 * 240 -> 205 on 2026-09-03: thirty-five fell in one pass, walking the HR Business Partner's own
 * sidebar top to bottom — the second seat done end to end after the employee portal. Every one was
 * on a live screen on her rail, and every one was fixed rather than deleted.
 *
 * The recruitment workspace was the bulk of it at ten. Its candidate table truncated the name, the
 * contact, the role title, the family, the region and the area — six of the columns a reader scans
 * to decide who a CV goes to, across 555 production rows. The rest were identity fields of the
 * same kind: names in the Employee 360 search cards, full names and HR IDs in the contract-renewal
 * and probation tables, the organogram detail modal's heading, the coaching report's rep name.
 * `truncate` -> `break-words`, with `break-all` for the CV filename, which has no spaces to
 * break at. Rows grow taller; that is the trade the portal pass already accepted.
 *
 * Two comments in the recruitment workspace argued from the old behaviour ("a name that already
 * truncates", "this second line already truncates") and were corrected rather than left teaching
 * it, the same way the five above were.
 *
 * ONE site was deliberately NOT retired and is still counted here. employee-management.tsx's
 * SearchableSelect trigger renders an <input> (searchable-select.tsx:295) — a single-line control
 * that cannot wrap however it is styled, so dropping the class would not give the text room, it
 * would swap the ellipsis for a silent clip, which is worse for the reader. It is the same
 * exception the fits-the-screen rule already makes for a native <select>. Leaving it counted is
 * the point: the ratchet should carry a known exception, not be quietly relieved of one.
 *
 * 205 -> 203 on 2026-09-05: the two batch-file columns, found by the admin half of the clip sweep
 * that followed the employee-portal chrome pass. Both cut the one string their row exists to
 * identify, and neither carried a title, so the missing text was not recoverable by hover either.
 * payroll-history.tsx cut 121-133px of the payroll batch name on /payroll at 768/1024/1280; since
 * every automated batch shares the "automated-payroll:" prefix, what the ellipsis ate was the only
 * part telling two rows apart. sales-import-workspace.tsx was worse at 154px, its ten columns
 * competing for the same 980px.
 *
 * `truncate` -> `break-words` on both, the same trade as the recruitment pass: these filenames are
 * single unbroken tokens, so `whitespace-normal` alone would still overflow them. The sales cell
 * also took a `min-w-[220px]` floor, because once nowrap is gone the column's min-content width
 * collapses and auto table layout squeezed it to 149px and four lines.
 *
 * Worth recording for whoever measures the next one: a harness reproducing these two tables at
 * 1280px was VOID, because its control row still carrying `truncate` did not cut anything. A
 * `max-w-[260px]` on a <td> is not a real constraint — the column simply took 500px. It is the
 * COLUMN SQUEEZE that cuts, so a truncation site has to be measured at a width where the columns
 * actually compete, or the reading says the defect is not there.
 *
 * 203 -> 202 on 2026-09-14: the direct-order ApprovalTracker's step label
 * (direct-order-detail-primitives.tsx). A returned order's open rung now reads "Returned — waiting
 * for <requester>", which a four-segment bar on a phone cut mid-name. `truncate` -> `break-words`,
 * the same trade as the batch-file columns above.
 *
 * 202 -> 201 on 2026-09-16: the admin global search's placeholder (topbar.tsx), outside `main`, so
 * a sweep over `main` never counted it. "Search employees, reports, pages..." needs 215px; the box
 * gave it 195px at 768 and 150px at 1024, and only widens past it at xl, so on every admin page
 * between those widths it ended in an ellipsis. `truncate` -> `leading-tight`: it wraps to two
 * lines, which fit inside the h-10 box. Pinned by tests/shell-chrome-overflows.test.ts.
 *
 * 201 -> 197 on 2026-09-17: the two shared filter dropdowns, on 14 screens between them, every sales
 * filter bar among them. MultiSelectFilter and RoiMultiSelect each cut their summary line and every
 * option label, so a long depot or distributor name ended in an ellipsis inside the one control that
 * picks it. `truncate` -> `min-w-0 break-words` on all four, and the trigger's fixed `h-[58px]` became
 * a `min-h-[58px]` floor so a wrapped line grows it. Pinned by tests/multi-select-filter-fits.test.ts.
 *
 * 197 -> 196 on 2026-09-17: the Sales Analytics module was retired, and its KPI card
 * (analytics-kpi-card.tsx) went with it. No screen changed; the site left with the file.
 *
 * 196 -> 194 on 2026-09-17: the admin shell's Weekly Sales Dashboard (weekly-dashboard-view-impl.tsx).
 * The product mix legend and the trend tooltip's distributor names ended in an ellipsis; both are now
 * `min-w-0 break-words` and wrap. Pinned by tests/weekly-sales-fits-the-screen.test.ts.
 *
 * 194 -> 193 on 2026-09-18: Expense Approvals' ticket and receipt tiles (trip-attachments.tsx). A
 * long file name ended in an ellipsis under the picture; it is `break-words` now and wraps. Pinned
 * by tests/outstation-approver-trip-photos.test.ts.
 *
 * 193 -> 192 on 2026-09-18: Database Mapping's Validation tab customer map
 * (database-validation-tab.tsx). The address was cut short with a hover title; it now shows in full
 * and wraps. Pinned by tests/database-mapping-tables-fit.test.ts.
 *
 * 192 -> 181 on 2026-09-21: the approvals hub, all eight sites — there is now no `truncate`
 * anywhere under src/components/approvals-hub. It started with the three name lines (the workspace
 * card, the history list, the company requests list), which now render the employee RECORD name
 * rather than the nickname-first display name; that runs to four and five parts here, and measured
 * at 375px the longest name in the employee master had 349px of itself hidden behind the ellipsis.
 * The owner then asked for the secondary lines too, which took in the rest: the three subtitle
 * lines, the approval scope cards (name + job title), the stuck-approvals panel (its `primary` is
 * "<record name> (<HR id>)") and the plan decision activity label.
 *
 * Every one sits in a `min-w-0` column beside a `shrink-0` sibling, so wrapping grows the row
 * taller and never pushes the page sideways. The scope card was the exception — a bare grid item,
 * so it was given `min-w-0` in the same change to stop a long name stretching its track. Pinned by
 * tests/approvals-hub-resolves-the-employee-record-name.test.ts.
 *
 * 181 -> 180 on 2026-09-21: the GPS check-in address under each stop on the field-workforce route
 * map (field-workforce-route-map.tsx). That line is the one place that says WHERE the rep actually
 * stood, and a Cairo street address is exactly the length an ellipsis eats. Its parent is already
 * `min-w-0 flex-1` beside a `shrink-0` time column, so wrapping costs no horizontal scroll at
 * 375px. Pinned by tests/crm-route-map-address-never-ellipsises.test.ts.
 *
 * 180 -> 175 on 2026-09-24: five cuts fell out of the sales fits-the-screen pass (the
 * fits-the-screen ratchet is 209 -> 175 in the same change). Three were `line-clamp-2` on a
 * customer ADDRESS (Customer Directory, and both of Customer Mapping's views), a fourth was the
 * consolidated view's distributor-code list, and the fifth a `truncate` on the SoS coverage tab's
 * customer column. All five sat in
 * tables that are now `table-fixed` with a percentage `<colgroup>`, so the text wraps inside its
 * own column and the row grows taller instead of the page growing wider: exactly the trade the
 * owner's rule names, where truncation and horizontal scroll collide and wrapping wins.
 *
 * 175 -> 174 on 2026-09-25: the Monthly Closing Details panel's own distributor column, which
 * showed the raw code and now shows the master's NAME (closing-details-panel.tsx) — a name is
 * longer than a code and an ellipsis on it is exactly the cut the owner's rule forbids, so the
 * `truncate` there became `break-words`.
 *
 * 174 -> 151 on 2026-09-25: the Medical Rep portal polish. The cuts became wraps — most in
 * Employee 360 (bar lists, product and double-visit names), the rest in closing details, the
 * message menu and the rep's field screens — each where a `min-w-0 break-words` cell or a merged
 * column now gives the name the room it needs. Includes the Territory Drilldown manager tree's
 * block card (territory-tree-desktop.tsx, BlockLane) — its block-code line truncated, same fix,
 * landed independently on the territory-tree-manager-fit branch and merged in here.
 *
 * 151 -> 147 on 2026-09-26: the Activity Control Center's four remaining cuts, all in
 * activity-control-dashboard.tsx — the online list's name and role, and the recent-navigation
 * feed's person and module. The online list is now a `table-fixed` desktop table with a
 * percentage `<colgroup>` beside a mobile card list, and the navigation row wraps instead of
 * cutting, so the four became `break-words` with no horizontal scroll bought in exchange.
 *
 * 147 -> 144 on 2026-09-26: the Monthly Closing screen's three remaining cuts, found by measuring
 * `scrollWidth > clientWidth` in a real browser at 1440px against production data rather than by
 * reading source. Two were the area filter's own options — "Dokki - Mohandseen - Bolak (GZ2)" lost
 * 32px and "Imbaba - Imbaba Centers (GZ3)" 14px, which is the worst place to cut a name, since
 * that list IS how an area is chosen — and the third was the closing matrix's area-name cell,
 * where "Dokki - Mohandseen - Bolak" needed 200px in a 196px column and rendered as "…Bola…".
 * The filter options now wrap onto a second line; the matrix column went 196 -> 208 so today's
 * longest name still sits on one line, with `break-words` behind it as the guarantee for
 * tomorrow's. No horizontal scroll was bought in exchange: that grid already scrolls sideways by
 * the owner's own ruling, and no row on it grew taller (33px and 36px before and after).
 *
 * 144 -> 141 on 2026-10-19: the Recruitment premium sweep. Three cuts became wraps — the Intake
 * Health dead-letter error, which now prints in full, among them.
 */
const BASELINE = 141;

const ROOTS = ["app", "src"];

/** A CSS truncation class sitting inside a quoted class string. */
const CLASS_STRING_WITH_TRUNCATION =
  /["'`][^"'`\n]*\b(?:truncate|text-ellipsis|line-clamp-\d+)\b[^"'`\n]*["'`]/;
const ANY_TRUNCATION_TOKEN = /\b(?:truncate|text-ellipsis|line-clamp-\d+)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of cachedReaddir(dir)) {
    const full = path.join(dir, entry);
    if (cachedIsDirectory(full)) {
      // Nothing gitignored lives under app/ or src/, but skip the obvious anyway
      // so a stray local folder can never inflate the count.
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

export function runNoEllipsisTruncationRatchetTests() {
  const files = ROOTS.flatMap((r) => walk(r));
  assert.ok(
    files.length > 1000,
    `only ${files.length} source files were scanned — the walk is not reaching the tree, so any count it reports is meaningless`,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Check the detector against known inputs BEFORE trusting it on ~2,900 files.
  // A ratchet whose regex is wrong does not fail loudly — it reports a number, and
  // a wrong number looks exactly as authoritative as a right one. That is how 298
  // stood unchallenged until a comment tipped it to 299 and someone read the list.
  // ───────────────────────────────────────────────────────────────────────────
  const countIn = (snippet: string) =>
    stripComments(snippet)
      .split("\n")
      .filter((line) => CLASS_STRING_WITH_TRUNCATION.test(line)).length;

  assert.equal(countIn('<p className="truncate">{name}</p>'), 1, "a plain class string is a real violation and must still count");
  assert.equal(countIn("<p className={`flex truncate ${x}`}>{n}</p>"), 1, "a template-literal class string must still count — narrowing the delimiters to silence comments would blind the ratchet to these instead");
  assert.equal(countIn('<p className="line-clamp-2">{n}</p>'), 1, "line-clamp falls under the same rule as truncate");
  assert.equal(countIn("// the label span has no `truncate`, so a long one would wrap"), 0, "a line comment naming the class is prose, not a violation");
  assert.equal(countIn("/**\n * the span has no `truncate` here\n */"), 0, "a JSDoc block naming the class is prose, not a violation");
  assert.equal(countIn("{/* No `truncate` on purpose — the text must never be cut */}"), 0, "a JSX block comment naming the class is prose, not a violation");
  assert.equal(countIn('const u = "https://x.example/a";\n<p className="truncate">{n}</p>'), 1, "a URL must not read as the start of a comment and swallow the line after it");

  // Line numbers survive stripping, or every file:line reported below is shifted
  // upward by the size of whatever comment block sat above it.
  const preserved = stripComments('/*\n * `truncate`\n */\n<p className="truncate">x</p>').split("\n");
  assert.equal(preserved.length, 4, "stripping must preserve the line count, or every file:line this test prints is wrong");
  assert.ok(
    CLASS_STRING_WITH_TRUNCATION.test(preserved[3]),
    "the surviving violation must still sit on its original line after the comment above it is stripped",
  );

  const sites: string[] = [];
  for (const file of files) {
    const source = stripComments(cachedReadFile(file));
    if (!ANY_TRUNCATION_TOKEN.test(source)) continue;
    source.split("\n").forEach((line, i) => {
      if (CLASS_STRING_WITH_TRUNCATION.test(line)) sites.push(`${file.replace(/\\/g, "/")}:${i + 1}`);
    });
  }

  const count = sites.length;

  assert.ok(
    count <= BASELINE,
    `${count - BASELINE} new UI truncation site(s) were added — the count went ${BASELINE} -> ${count}.\n` +
      `The owner's rule is that text is never cut off with an ellipsis, and a page never scrolls ` +
      `sideways either: where the two collide, wrapping wins. Let the text wrap (break-words), give ` +
      `it room by merging columns, or shorten the label.\n` +
      `Sites now present:\n  ${sites.slice(-12).join("\n  ")}`,
  );

  // Improvement direction: the count fell BELOW the baseline. That is a win, not a failure — a PR
  // must never go red for making the app better. Warn (so the baseline can be lowered in a later
  // housekeeping pass) and pass. The regression guard above (count <= BASELINE) still fails on any
  // NEW truncation site, so the rule itself is not weakened.
  if (count < BASELINE) {
    console.warn(
      `Good news: truncation sites dropped ${BASELINE} -> ${count}. Lower BASELINE in this file to ` +
        `${count} so the ground that was won cannot be given back.`,
    );
  }
}
