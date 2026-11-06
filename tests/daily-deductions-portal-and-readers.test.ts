import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Two owner answers of 2026-11-07, asked as multiple choice after the Deductions audit:
//
//  1. The release email tells the employee to "Open your Deductions page", and that page showed no
//     daily line at all. His answer: "Show daily lines". The page now reads the RELEASED snapshot
//     (getPortalDailyDeductions, self-only) beside the month ledger, and a failed daily read says so
//     in its own section instead of taking the ledger down or reading as "nothing released".
//
//  2. The Finance Manager could not open Daily Deductions, though two of its read routes answered
//     him. His answer: "Open the page read-only". He joins VIEW_ROLES by name; every mutating route
//     still asserts approve/create plus Super Admin, and the Compute panel renders only for the
//     Super Admin, because /compute refuses everyone else.
export function runDailyDeductionsPortalAndReadersTests(): void {
  // ── 1. The employee sees his released daily lines ───────────────────────
  {
    const page = readFileSync("app/employee-portals/deductions/page.tsx", "utf8");
    assert.match(page, /getPortalDailyDeductions\(\{ access \}\)/, "the employee Deductions page must read the released daily lines");
    assert.match(
      page,
      /getPortalDailyDeductions\(\{ access \}\)\.then\(\s*\(result\) => \(\{ lines: result\.lines, unavailable: false \}\),\s*\(error: unknown\) => \{[\s\S]{0,400}?unavailable: true/,
      "a failed daily read must be caught on its own and marked unavailable — never thrown into the ledger's error page",
    );
    assert.ok(
      page.indexOf("getPortalDailyDeductions({ access })") < page.indexOf("data = await getPortalDeductionLedger({ access });"),
      "the daily read must START before the ledger read so the two run side by side",
    );
    assert.match(
      page,
      /<DailyDeductionsPortalSection lines=\{daily\.lines\} unavailable=\{daily\.unavailable\} \/>/,
      "the page must render the daily section with both the lines and the unavailable flag",
    );

    const section = readFileSync("src/components/employee-portal/daily-deductions-section.tsx", "utf8");
    assert.match(section, /if \(!unavailable && lines\.length === 0\) return null;/, "with nothing released the section stays away");
    assert.match(section, /could not be loaded right now/, "a failed read must say so in words, never show an empty list");
    assert.match(
      section,
      /charged once/,
      "the section must say a day listed in both places is charged once — releasing a daily line feeds no salary run",
    );
    assert.match(section, /deductionsCategoryNames\[line\.category\]/, "each line names its reason in words, never the category code");

    const reader = readFileSync("src/lib/daily-deductions/portal.ts", "utf8");
    assert.doesNotMatch(reader, /LATENT SURFACE/, "the reader is wired now; its header must not still call it latent");
    assert.match(
      reader,
      /if \(input\.access\.scope === "system"\) return \{ all: true[\s\S]{0,200}?compactDeductionsHrId\(input\.access\.hrId \?\? input\.access\.loginId\)/,
      "the daily portal scope must stay self-only for every non-system role, exactly as the month ledger",
    );
    assert.match(reader, /getActiveDailyPublication\(\)/, "only the released (active) snapshot reaches the employee, never a running tally");
  }

  // ── 2. The Finance Manager reads Daily Deductions, and only reads ───────
  {
    const page = readFileSync("app/(admin)/admin/daily-deductions/page.tsx", "utf8");
    const viewRoles = page.match(/const VIEW_ROLES = new Set\(\[([^\]]*)\]\);/);
    assert.ok(viewRoles, "the page must keep a by-name VIEW_ROLES set");
    const roles = [...viewRoles[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(roles, ["CEO", "Finance Manager", "HR Operations", "Super Admin"], "VIEW_ROLES must be exactly these four roles");
    assert.match(page, /canPublish=\{access\.role === "Super Admin"\}/, "only the Super Admin may compute or release");

    const nav = readFileSync("src/config/system-navigation.ts", "utf8");
    const card = nav.slice(nav.indexOf('href: "/admin/daily-deductions"'), nav.indexOf('href: "/admin/daily-deductions"') + 1200);
    const cardBody = card.slice(0, card.indexOf("\n  },"));
    assert.doesNotMatch(cardBody, /excludedRoles/, "the Daily Deductions card must not exclude the Finance Manager any more");

    const workspace = readFileSync("src/components/admin/daily-deductions-workspace.tsx", "utf8");
    assert.match(
      workspace,
      /\{canPublish \? \(\s*<section className=\{PANEL\}>\s*<div className=\{cn\("px-4 py-3", adminPanelHeaderClassName\)\}>\s*<h2 className=\{PANEL_TITLE\}>Count a date range<\/h2>/,
      "the Compute panel must render for the Super Admin only — /compute refuses every reader",
    );

    for (const route of ["release", "withdraw", "supersede"]) {
      const source = readFileSync(`app/api/admin/daily-deductions/${route}/route.ts`, "utf8");
      assert.match(source, /assertPermission\(access, "deductions", "approve"\)/, `POST /${route} must still assert deductions:approve`);
    }
    const compute = readFileSync("app/api/admin/daily-deductions/compute/route.ts", "utf8");
    assert.match(compute, /assertPermission\(access, "deductions", "create"\);\s*assertDailyDeductionsPublishActor\(access\);/, "POST /compute must still assert create plus Super Admin");
  }
}
