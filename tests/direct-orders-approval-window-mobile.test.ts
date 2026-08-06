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
  // Each mobile block is sliced to its OWN closing </section>. A fixed character window instead
  // ran past the end of the section and found the NEXT one's desktop <tfoot> "Total" — so the
  // assertion passed with no mobile total present at all. Caught by prove-it-fails, not by review.
  {
    const withTotals = [...source.matchAll(/md:hidden/g)].filter((m) => {
      const rest = source.slice(m.index ?? 0);
      const end = rest.indexOf("</section>");
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
}
