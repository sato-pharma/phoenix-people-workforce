import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Spec D3, the mobile half — "Desktop = full tables; mobile = cards."
//
// This screen shipped without any mobile layout at all. Not a weak one: none. A manager opening an
// approval on a phone got three tables, two of them with hard 820px and 760px minimum widths, so
// the numbers a decision rests on lived off the right edge behind a horizontal scroll.
//
// The inversion is what makes it worth locking. Four sibling components in this module — held-desk,
// pharmacy-registry-manager, rep-counters-table, and the employee-portal version of THIS screen —
// already split correctly. So the rep on their phone got cards, and the approver, on the screen the
// owner twice called the face of the system, got the scrolling table.
//
// Checked as source text because the harness runs `node --experimental-strip-types` and cannot load
// a .tsx at all. For this rule that is enough: "is there a mobile branch" is answered by the file.
// It is NOT enough for "does it look premium" — nothing here claims that.
// ─────────────────────────────────────────────────────────────────────────────

const DETAIL = "../src/components/approvals-hub/direct-order-request-detail.tsx";

export function runDirectOrdersApprovalWindowMobileTests() {
  const source = readFileSync(new URL(DETAIL, import.meta.url), "utf8");

  // ── The 2026-08-08 restyle is actually in place ────────────────────────────
  // Locks the redesign itself, not just its mobile behaviour: every section on this screen must
  // come from the shared PanelSection primitive (mirroring Outstation's Expense Approvals look),
  // never a reintroduced one-off <section>/<header> pair.
  assert.match(
    source,
    /from "@\/components\/approvals-hub\/direct-order-detail-primitives"/,
    "the approval window must still import its section/field primitives from direct-order-detail-primitives.tsx",
  );
  // `[^>]*` tolerates section props such as the `anchorId` the validated-evidence badge jumps to
  // (2026-09-22) — the invariant being pinned is only that Distributors is a shared PanelSection.
  assert.match(source, /<PanelSection title="Distributors"[^>]*>/, "Distributors must render inside a PanelSection");
  assert.match(source, /<PanelSection title="Approval chain">/, "Approval chain must render inside a PanelSection");

  // ── Every table is desktop-only ────────────────────────────────────────────
  // Asserted per-table against the wrapper that actually encloses it, rather than by counting
  // `hidden md:block` anywhere in the file — a file-wide count stays green when someone adds a
  // fourth table with no wrapper, which is precisely how this regressed the first time.
  {
    const tables = [...source.matchAll(/<table\b/g)].map((m) => m.index ?? 0);
    assert.ok(tables.length >= 3, `the approval window should still carry its three tables (found ${tables.length})`);
    for (const at of tables) {
      const wrapper = source.slice(Math.max(0, at - 260), at);
      const openDiv = wrapper.lastIndexOf("<div");
      assert.notEqual(openDiv, -1, "every table must sit inside a wrapper div that can carry the breakpoint");
      const cls = wrapper.slice(openDiv);
      assert.ok(
        /\bhidden\b/.test(cls) && /\bmd:block\b/.test(cls),
        `every table must be desktop-only (hidden + md:block): a table on a 375px screen is the ` +
          `owner's standing admin-shell rule broken — desktop gets tables, mobile gets cards. ` +
          `Offending wrapper: ${cls.replace(/\s+/g, " ").slice(0, 120)}`,
      );
    }
  }

  // ── Every table has a card counterpart ─────────────────────────────────────
  // Hiding the table without adding cards would satisfy the rule above and leave a phone showing
  // nothing at all — which is worse than the scrolling table, because empty reads as "no data".
  {
    const tables = [...source.matchAll(/<table\b/g)].length;
    const cards = [...source.matchAll(/md:hidden/g)].length;
    assert.equal(
      cards,
      tables,
      `every desktop table needs a mobile card block: ${tables} tables but ${cards} md:hidden blocks — ` +
        "hiding a table with nothing to replace it shows a phone an empty section, and empty reads as 'no data'",
    );
  }

  // ── No minimum-width table can be reached on a phone ───────────────────────
  {
    for (const m of source.matchAll(/min-w-\[(\d+)px\]/g)) {
      const before = source.slice(Math.max(0, (m.index ?? 0) - 320), m.index ?? 0);
      const openDiv = before.lastIndexOf("<div");
      const cls = openDiv === -1 ? "" : before.slice(openDiv);
      assert.ok(
        /\bhidden\b/.test(cls) && /\bmd:block\b/.test(cls),
        `a min-w-[${m[1]}px] element must be desktop-only — at 375px it is a horizontal scroll ` +
          "hiding the numbers the decision rests on",
      );
    }
  }

  // ── The totals survive onto mobile ─────────────────────────────────────────
  // The footer row is the judgement line — what this pharmacy is worth across all months, which
  // the approver weighs THIS order against. It is the first thing dropped when a table is
  // squeezed onto a phone, and the one thing a decision cannot be made without.
  // Each mobile block is sliced to its OWN closing </PanelSection> (the section boundary, since
  // the 2026-08-08 restyle moved every raw <section> to the shared PanelSection component — the
  // literal "</PanelSection>" in THIS file's source is the same reliable per-block boundary the
  // old literal "</section>" used to be). A fixed character window instead ran past the end of the
  // section and found the NEXT one's desktop <tfoot> "Total" — so the assertion passed with no
  // mobile total present at all. Caught by prove-it-fails, not by review.
  {
    const withTotals = [...source.matchAll(/md:hidden/g)].filter((m) => {
      const rest = source.slice(m.index ?? 0);
      const end = rest.indexOf("</PanelSection>");
      return /Total/.test(end === -1 ? rest : rest.slice(0, end));
    });
    assert.equal(
      withTotals.length,
      2,
      `both history cards must carry their own total, and only those two (found ${withTotals.length}): ` +
        "the footer is the baseline the order is judged against, not decoration to drop when space is short",
    );
  }

  // ── A provisional month stays flagged on the card ──────────────────────────
  // A month Finance has not closed must never read as settled. The flag is worth more on a phone
  // than any number beside it, so it must not be one of the fields dropped for space.
  // Counted as RENDERED JSX text (`>not final<`), not as a bare substring. A plain count included
  // the phrase from this file's own source comment, so the total was 3 where two were real —
  // deleting the mobile one left 2 and the assertion stayed green. Also caught by prove-it-fails.
  {
    const rendered = [...source.matchAll(/>\s*not final\s*</g)].length;
    assert.equal(
      rendered,
      2,
      `the "not final" flag must be rendered on the mobile card as well as the desktop row ` +
        `(found ${rendered} rendered occurrences, expected 2): an unclosed month shown as settled ` +
        "is the one misreading this column exists to prevent",
    );
  }

  // ── The empty states are not swallowed by the split ────────────────────────
  // Each table's empty state explains WHY it is empty — a provisional pharmacy on probation reads
  // differently from an established one that simply has not bought (spec D2, #1829). Those sit
  // outside the desktop/mobile branch and must stay reachable at both widths.
  {
    assert.match(
      source,
      /No other direct orders recorded for this pharmacy yet — this is its first\./,
      "the direct-order empty state must survive the split — an empty table must never read as zero",
    );
    assert.match(
      source,
      /pharmacyStanding\?\.noHistoryNote/,
      "the retail empty state must still come from the domain's standing sentence, not from a count in the view",
    );
  }

  // ── The field grid starts at ONE column ────────────────────────────────────
  // This is the half the first pass missed. Converting the three tables to cards left the field
  // grid at `grid-cols-2`, which was assumed fine because it already carried a breakpoint. It was
  // not. Measured on production at 375px: two columns give each value 150px while eight of them
  // need up to 287px — a request id, a requester's "name · code · role", a price carrying its
  // "(on file, not used — discount deal)" note. Every value is `whitespace-nowrap` by the owner's
  // standing rule, so they did not wrap; they overran into the next column and printed on top of
  // it. Two columns of colliding text is worse than either wrapping or a table.
  //
  // Only a browser could have caught this. The tables were provably desktop-only and the page did
  // not scroll sideways, so every source-level check passed while the screen was unreadable.
  //
  // RE-AIMED 2026-08-08. The owner asked for the three field clusters to become real tables, so the
  // multi-column `<dl className="grid ...">` this used to inspect no longer exists — the fields now
  // render through FieldTable, a two-column label/value table that is single-column by construction
  // and therefore immune to the original defect. What still has to hold is the RULE, not that one
  // element: nothing on this screen may put a multi-column grid of nowrap values at the phone's base
  // width. So the check now sweeps EVERY grid on the page instead of the one that used to exist.
  {
    const grids = [...source.matchAll(/className="([^"]*\bgrid\b[^"]*)"/g)].map((match) => match[1]);
    assert.ok(grids.length > 0, "the detail screen must still lay out with explicit grid classes");
    for (const cls of grids) {
      // A base-level (breakpoint-free) grid-cols-2+ is the exact defect: at 375px each value gets
      // ~150px while real values run to 287px, and whitespace-nowrap makes them overlap rather
      // than wrap. Behind sm:/md:/lg: it is fine, because the phone never sees it.
      const bareMultiColumn = /(^|\s)grid-cols-([2-9]|1[0-2])\b/.exec(` ${cls}`);
      assert.ok(
        !bareMultiColumn,
        `a grid must not start at more than one column — at 375px nowrap values overlap instead of ` +
          `wrapping. Put it behind a breakpoint. Found: "${cls}"`,
      );
    }
    // …and the desktop view must not have been narrowed to achieve that: the hero row still widens.
    assert.match(
      source,
      /grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4/,
      "the hero row must stack on a phone and still open out to four columns on desktop — the mobile rule must not cost the desktop view",
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Added after #1833/#1836: four things the mobile layout left behind.
  // ───────────────────────────────────────────────────────────────────────────

  // ── One source of truth for the money ─────────────────────────────────────
  // #1833 gave the phone its own totals cards, which left the same seven sums written twice — the
  // desktop totals row and the mobile card each reducing the same array. Sliced per totals row and
  // per mobile card rather than counted file-wide, because a file-wide `.reduce(` ban would also
  // forbid the hoisted declarations this rewards.
  assert.match(source, /const retailTotals = \{/, "retail totals must be computed once");
  assert.match(source, /const directTotals = \{/, "direct totals must be computed once");
  for (const [index, block] of source.split("<tfoot>").slice(1).entries()) {
    const row = block.slice(0, block.indexOf("</tfoot>"));
    assert.ok(
      !row.includes(".reduce("),
      `totals row ${index + 1} must read the hoisted totals, never recompute them inline`,
    );
  }
  // Anchored AFTER the hoisted declarations, not at the first `return (` — the first one belongs
  // to the Field primitive near the top of the file, so slicing there swallowed the very
  // declarations this rewards and the assertion failed against correct code.
  const declEnd = source.indexOf("};", source.indexOf("const directTotals = {"));
  assert.notEqual(declEnd, -1, "the hoisted totals declarations must exist");
  assert.ok(
    !source.slice(declEnd).includes(".reduce((sum"),
    "no renderer may recompute a total inline — two reduce expressions on the two screens that " +
      "must agree about what a pharmacy is worth is how they quietly disagree",
  );

  // ── The phantom check ─────────────────────────────────────────────────────
  assert.match(
    source,
    /request\.salesValue > retailTotals\.salesValue/,
    "the retail totals must flag an order larger than everything the pharmacy has ever bought — " +
      "the one line most likely to catch a phantom, from numbers already on the page",
  );

  // ── The chain row cannot squeeze ──────────────────────────────────────────
  assert.match(
    source,
    /min-w-0 flex-1 text-sm font-semibold/,
    "the approver name must be allowed to shrink, or a long name shoves the status off a phone",
  );
  assert.match(
    source,
    /pl-0 md:pl-\[42px\]/,
    "the 42px decorative gutter must be desktop-only — it costs 12% of a 390px screen in the one " +
      "block that holds free Arabic text",
  );

  // ── Touch targets on the shared decision component ────────────────────────
  const actions = readFileSync(
    new URL("../src/components/approvals-hub/decision-actions.tsx", import.meta.url),
    "utf8",
  );
  const countIn = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  // REC-032 (14 Nov 2026): the buttons wear the one approvals interface, whose regular size is the
  // 44px floor — so the floor is read where it now lives, and this panel must use that size.
  const kit = readFileSync(
    new URL("../src/components/approvals-hub/approval-action-kit.tsx", import.meta.url),
    "utf8",
  );
  assert.match(kit, /regular: "h-11 /, "the one approvals interface's regular size is the 44px floor");
  assert.ok(
    countIn(actions, "\"regular\"") >= 2 && !/"dense"/.test(actions),
    "every decision button must clear the 44px touch floor — this is the screen where money moves, " +
      "reached after eight sections of evidence",
  );
  assert.match(actions, /h-12 flex-1/, "the sticky mobile bar's buttons must be thumb-sized");
  assert.match(actions, /createPortal\(/, "the sticky bar must portal to the body to escape overflow contexts");
  assert.match(
    actions,
    /style=\{\{ bottom: "env\(safe-area-inset-bottom\)" \}\}/,
    "the admin bar sits on the safe area itself",
  );
  assert.doesNotMatch(
    actions,
    /calc\(56px/,
    "the portal twin's 56px offset clears the EMPLOYEE bottom nav; the admin shell has none, so " +
      "copying that number would float this bar above nothing",
  );
  // 🔴 THE ONE OVERRIDE THE FORM-DESIGN SWEEP OF 2026-10-06 HAD TO KEEP, AND THE REASON THE
  // ASSERTION MOVED. Every form control in the system now wears the shared token, which carries
  // `text-sm` — 14px. On this screen that is a real defect, not a style: iOS Safari zooms the
  // entire viewport when it focuses a field under 16px, and this is the screen where money moves.
  // So the border, the padding and the orange focus pair come from the token, and the 16px step
  // stays here as a `cn()` override. The old assertion read one contiguous literal
  // (`text-base focus:border-orange-500 focus:outline-none md:text-sm`) which the sweep dissolved
  // — it caught the sweep, correctly, and is replaced by the two halves it was really pinning.
  assert.match(
    actions,
    // Whitespace-tolerant on purpose: the old assertion was a contiguous literal, and a formatter
    // wrapping this call would have broken it for a reason that is not the rule.
    /className=\{\s*cn\(\s*phxTextareaClassName,\s*"text-base md:text-sm",?\s*\)\s*\}/,
    "the reason box must be 16px on mobile, or iOS Safari zooms the viewport when it is focused — " +
      "the shared textarea token is text-sm (14px), so this screen must override it through cn(), " +
      "never a template literal (a template ships both sizes and lets the stylesheet pick)",
  );
  assert.match(
    readFileSync(new URL("../src/components/ui/form-tokens.ts", import.meta.url), "utf8"),
    /focus:border-orange-500[\s\S]{0,160}focus:ring-orange-500\/20/,
    "the orange focus pair this screen used to spell out must still exist in the shared token it " +
      "now inherits from, or the override above restores the size and loses the focus ring",
  );
}
