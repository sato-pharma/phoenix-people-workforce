import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

/**
 * The three golden rules this page had to clear, pinned in source so they survive an edit.
 *
 * ── WHAT WAS MEASURED IN A BROWSER, AND WHAT THIS COVERS INSTEAD ──────────────────────────────
 *
 * Measured live on 2026-09-05 against the dev server, with document.visibilityState === "visible"
 * so the readings were real: `main` 1260/1260 and the document 1280/1280 — no horizontal scroll —
 * and ZERO elements under `main` with a non-zero computed border-radius.
 *
 * A browser measurement is a snapshot of one commit. These assertions are what stops the next edit
 * undoing it, and they cover the mobile split, which the shell's own CSS cannot enforce.
 */
export function runRecruitmentHiringAnalyticsLayoutTests() {
  const view = readFileSync("src/components/recruitment/hiring-analytics-view.tsx", "utf8");

  // ── the owner's rule: desktop gets the table, a phone NEVER does ────────────────────────────
  assert.match(
    view,
    /className="hidden w-full table-fixed md:table"/,
    "the channel table must be hidden below the md breakpoint - the owner's rule is that mobile "
      + "never gets a table",
  );
  assert.match(
    view,
    /className="space-y-3 md:hidden"/,
    "and a card list must take its place on a phone, rather than the table simply disappearing",
  );

  // ── fits the screen: no min-width floor under a scroller ────────────────────────────────────
  //
  // `overflow-x-auto` over a `min-width` floor IS the bug, not the fix. The table is w-full with a
  // colgroup so it narrows instead of scrolling.
  assert.equal(
    /overflow-x-auto/.test(view),
    false,
    "no horizontal scroller: the fits-the-screen rule says fit by merging or wrapping columns, "
      + "never by letting the table scroll sideways",
  );
  assert.equal(
    /min-w-\[|minWidth/.test(view),
    false,
    "no min-width floor - it is what forces the sideways scroll the rule forbids",
  );
  assert.match(view, /<colgroup>/, "the table sets its column widths, so table-fixed can do its job");

  // ── square edges ────────────────────────────────────────────────────────────────────────────
  //
  // The shell forces radius 0 inside .admin-shell, so a rounded class here would be dead weight
  // that still reads as intent to the next person. The rule is to not write one.
  //
  // Scanned inside className attributes only, not across the whole file: the first version of
  // this assertion failed on its own explanatory comment, which is a test measuring its own
  // prose rather than the code.
  const classNames = [...view.matchAll(/className="([^"]*)"/g)].map((match) => match[1]);
  const roundedClasses = classNames.filter((value) => /\brounded(-|\s|$)/.test(value));
  assert.deepEqual(
    roundedClasses,
    [],
    "no rounded-* class: the square-edge rule is the intent, and the shell's reset makes such a "
      + `class dead weight that reads as a deliberate curve:\n${roundedClasses.join("\n")}`,
  );

  // ── no ellipsis ─────────────────────────────────────────────────────────────────────────────
  assert.equal(
    classNames.some((value) => /\btruncate\b|\btext-ellipsis\b/.test(value))
      || view.includes("…"),
    false,
    "the owner's rule is that text is never truncated with an ellipsis - long channel names wrap",
  );
  assert.match(view, /break-words/, "long values wrap instead, which is the permitted answer");

  // ── the count and its share are not neighbours on one line ──────────────────────────────────
  //
  // "14" beside "1.9%" reads as a single number at a glance - the same adjacency that had
  // "1.63 / 6.57" read as "1.63 out of 6.57".
  assert.match(
    view,
    /className="block font-semibold text-slate-900">\{step\.count\}/,
    "the funnel count must be on its own line, not inline beside its percentage",
  );
  assert.match(
    view,
    /% of \{previousLabel\}/,
    "and the share must name what it is a share OF - a bare percentage beside a count invites the "
      + "reader to divide the two",
  );

  // ── the page itself: no portal twin, and the permission is the gate ─────────────────────────
  const page = readFileSync("app/(admin)/recruitment/hiring-analytics/page.tsx", "utf8");
  assert.match(
    page,
    /resolveNavigationMode\(access\) === "employee-portal"/,
    "a portal-shell role must be sent away - this report reads EVERY candidate, so there is no "
      + "portal audience it could be scoped to",
  );

  const nav = readFileSync("src/config/system-navigation.ts", "utf8");
  const row = nav.split("\n").find((line) => line.includes('"/recruitment/hiring-analytics"')) ?? "";
  assert.ok(row.length > 0, "the sidebar row must exist - without it the page has no way in");
  assert.match(row, /resource: "candidates", action: "read"/, "gated on reading candidates");
  assert.equal(
    /roles:\s*\[/.test(row),
    false,
    "and NO roles list: naming CEO here looked right and granted nothing, because the CEO holds no "
      + "`candidates` permission at all. The permission alone is the gate.",
  );
}
