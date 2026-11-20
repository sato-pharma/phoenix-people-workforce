import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The self spotlight wears the EMPLOYEE PORTAL's look.
//
// Owner, 2026-09-30: "premium polish the page to follow the portal style." This replaces the earlier
// pin that held it against the Report It form — he changed the instruction, and a test that keeps
// enforcing a superseded one is worse than no test.
//
// 🔴 THE DEFECT THIS EXISTS TO STOP CAME BACK TWICE, SO IT IS PINNED RATHER THAN REMEMBERED.
// `EmployeePortalPageShell` renders the page's one header. Until 2026-11-20 that header was a dark
// navy block, and a page inside it that drew its own dark banner stacked two dark blocks and read as
// broken. Since 2026-11-20 the shell's header is the landing kit's light title band (the orange tick,
// the section name, the navy title, a hairline), and a dark banner here would now be the page's own
// navy slab under it — the kit keeps navy for at most ONE headline board a page, and the spotlight
// has none. Either way the page draws no banner of its own; the first assertion below is that one.
//
// The spotlight is a document identity (its sheet is exempt from the ink rule by his ruling of
// 2026-09-12) and was left alone by the 2026-11-20 portal redesign, so its card vocabulary below is
// pinned on its own. It is no longer cross-checked against the shell's empty state and action link,
// which moved to the landing kit that day.

const root = process.cwd();
const shell = readFileSync(join(root, "src/components/employee-portal/enterprise-shell.tsx"), "utf8");
const workspace = readFileSync(join(root, "src/components/spotlight/rep-spotlight-workspace.tsx"), "utf8");
const page = readFileSync(join(root, "app/employee-portals/spotlight/page.tsx"), "utf8");

export function runSpotlightPortalLookTests(): void {
  // ── 1. THE SHELL OWNS THE HEADER — the page must not draw a second one ────────────────────────
  assert.ok(
    shell.includes("employee-portal-page-header") && /<h1[\s>]/.test(shell),
    "The portal shell no longer draws its own title band and <h1>; re-derive what a page may draw.",
  );
  assert.ok(
    page.includes("EmployeePortalPageShell"),
    "The spotlight page must render inside EmployeePortalPageShell so the portal header is the only header.",
  );
  // Blunt on purpose: it bans the dark BACKGROUND tokens outright rather than trying to judge how
  // large a dark block is. A small dark element (the meter's threshold tick) uses slate-700, which
  // keeps the rule cheap to state and impossible to argue with.
  for (const banner of ["bg-slate-900", "bg-[#08111f]", "bg-slate-950"]) {
    assert.ok(
      !workspace.includes(banner),
      `The workspace paints a dark banner (${banner}) under the shell's own header — a second header`
        + " block is exactly the defect this page has already shipped twice. The shell owns the header.",
    );
  }
  assert.ok(
    !/<h1[\s>]/.test(workspace),
    "The shell renders the page's only <h1>; sections inside it use <h2>.",
  );

  // ── 2. The spotlight's own card vocabulary, as approved on 2026-09-30 ────────────────────────
  const spotlightCardShadow = "shadow-[0_18px_46px_rgba(15,23,42,0.07)]";
  assert.ok(
    workspace.includes(`rounded border border-slate-200 bg-white ${spotlightCardShadow}`),
    "Spotlight cards keep the look he approved: slate-200 border, white, the card shadow.",
  );

  // The hover lift its buttons were given on 2026-09-30.
  assert.ok(workspace.includes("hover:-translate-y-px"), "The spotlight's buttons keep their hover lift.");

  // Orange is the single accent, on the portal's own micro-label scale.
  assert.ok(
    workspace.includes("text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-600"),
    "The card eyebrow must use the portal's orange micro-label treatment.",
  );

  // ── 3. The owner's standing UI rules on this page ─────────────────────────────────────────────
  assert.ok(!/overflow-x-auto/.test(workspace), "No horizontal scroll — fit by wrapping, never by scrolling.");
  assert.ok(
    !/\btruncate\b|text-ellipsis/.test(workspace),
    "Nothing on this page may be truncated (owner standing rule).",
  );
  // Every multi-column grid collapses to one column first.
  for (const grid of workspace.match(/grid-cols-\d[^"']*/g) ?? []) {
    assert.ok(
      /^grid-cols-1\b/.test(grid),
      `Grid "${grid}" does not start at one column, so it cannot collapse on a phone.`,
    );
  }
  // The sheet scales instead of overflowing. Deliberately does NOT pin a corner radius: the
  // square-edge golden rule owns that, and an earlier version of this line required `rounded-sm`
  // on the sheet, which is the one thing the page must not have.
  assert.ok(
    /className="block w-full border border-slate-200 bg-white"/.test(workspace),
    "The rendered sheet must be w-full so an A4 portrait fits a phone without scrolling sideways.",
  );

  // ── 4. The behaviour the look must not quietly drop ───────────────────────────────────────────
  // The threshold is never hard-coded into the copy: it arrives as a prop from the engine's own
  // constant, so the page and the gate can never quote different numbers.
  assert.ok(!/\b90%/.test(workspace), "Quote the threshold from the `threshold` prop, never as a literal 90%.");
  assert.ok(
    workspace.includes("/api/spotlight/me/preview") && workspace.includes("/api/spotlight/me/sheet"),
    "The page must still read its numbers and its sheet from the self-scoped routes.",
  );
}
