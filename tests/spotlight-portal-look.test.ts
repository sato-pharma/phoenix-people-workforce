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
// `EmployeePortalPageShell` ALREADY renders the dark navy command header — badge, title,
// description. A page inside it that draws its own dark banner stacks two dark blocks and reads as
// broken. The first assertion below is that one.

const root = process.cwd();
const shell = readFileSync(join(root, "src/components/employee-portal/enterprise-shell.tsx"), "utf8");
const workspace = readFileSync(join(root, "src/components/spotlight/rep-spotlight-workspace.tsx"), "utf8");
const page = readFileSync(join(root, "app/employee-portals/spotlight/page.tsx"), "utf8");

export function runSpotlightPortalLookTests(): void {
  // ── 1. THE SHELL OWNS THE HEADER — the page must not draw a second one ────────────────────────
  assert.ok(
    shell.includes("bg-[#08111f]"),
    "The portal shell no longer paints its own command header; re-derive what a page may draw.",
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
      `The workspace paints a dark banner (${banner}) under the shell's own navy header — two stacked`
        + " dark blocks is exactly the defect this page has already shipped twice. The shell owns the header.",
    );
  }
  assert.ok(
    !/<h1[\s>]/.test(workspace),
    "The shell renders the page's only <h1>; sections inside it use <h2>.",
  );

  // ── 2. The portal's own card vocabulary, taken from enterprise-shell ──────────────────────────
  const portalCardShadow = "shadow-[0_18px_46px_rgba(15,23,42,0.07)]";
  assert.ok(
    shell.includes(portalCardShadow),
    "The portal's card shadow moved; take the new one from enterprise-shell.tsx and re-pin both sides.",
  );
  assert.ok(
    workspace.includes(`rounded border border-slate-200 bg-white ${portalCardShadow}`),
    "Spotlight cards must be the portal's card: rounded, slate-200 border, white, the portal shadow.",
  );

  // The portal's hover-lift, as EmployeePortalActionLink does it.
  const lift = "hover:-translate-y-px";
  assert.ok(shell.includes(lift), "The portal's hover lift moved; re-pin from enterprise-shell.tsx.");
  assert.ok(workspace.includes(lift), "Buttons should lift on hover the way the portal's own links do.");

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
  // The sheet scales instead of overflowing.
  assert.ok(
    /className="block w-full rounded-sm border border-slate-200 bg-white/.test(workspace),
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
