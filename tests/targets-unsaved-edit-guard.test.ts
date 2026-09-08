import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expandTargetPeriodScope } from "@/lib/sales/monthly-targets";

// The Targets authoring screen, rebuilt 2026-09-08 after a month of hand-entered Pedia targets was
// lost and the owner rejected the screen that lost them.
//
// WHAT HAPPENED. The SFE Manager re-typed August's Pedia targets in the grid and they never
// arrived. The Supabase gateway recorded ZERO calls to `phx_upsert_monthly_targets` that day,
// `au.monthly_targets` last changed on 2026-08-04, and the table keeps no history — so there was
// nothing to recover from the database, the logs or the daily backups. The numbers had never left
// his browser, because a typed target lived in React state alone and three ordinary actions threw
// it away in silence: switching the Line/Month dropdown, reloading, and clicking a sidebar link.
//
// This pins the four rulings that came out of that day:
//   1. the edit survives all three exits (the draft is the load-bearing half),
//   2. no achievement on this tab at all,
//   3. no table and no scrolling box — regions are buttons that open,
//   4. a template covers a month, a calendar quarter or a calendar semester, empty or populated.

/** Comments describe the guard as thoroughly as the code does; assert on the CODE. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

export function runTargetsUnsavedEditGuardTests() {
  const workspace = code(read("src/components/sales/targets-authoring.tsx"));
  const page = code(read("app/(admin)/sales/targets/page.tsx"));

  // ── 1. The dropdown cannot wipe the grid without asking ─────────────────────
  {
    const navigate = workspace.match(/function navigate\(line: string, period: string\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(navigate, "navigate() must still exist — both dropdowns route through it");

    assert.match(
      navigate,
      /hasUnsavedEdits[\s\S]*?window\.confirm\(/,
      "navigate() must confirm before discarding unsaved edits — this is the exit that lost August",
    );

    // Order is the whole assertion: a confirm placed AFTER the clear warns about work already gone.
    const confirmAt = navigate.indexOf("window.confirm(");
    const clearAt = navigate.indexOf("setEdits({})");
    assert.ok(confirmAt >= 0 && clearAt >= 0, "navigate() must both confirm and clear");
    assert.ok(
      confirmAt < clearAt,
      "the confirm must come BEFORE setEdits({}) — confirming after the clear asks about work already discarded",
    );
  }

  // ── 2. Reload / tab close asks too, and only while something is unsaved ──────
  {
    const leaveGuard = workspace.match(
      /if \(!hasUnsavedEdits\) return;[\s\S]*?removeEventListener\("beforeunload", warnBeforeUnload\)/,
    )?.[0];
    assert.ok(
      leaveGuard,
      "the leave prompt must be gated on there being unsaved edits, and must remove its own listener",
    );
    assert.match(
      leaveGuard,
      /event\.preventDefault\(\)[\s\S]*?event\.returnValue = ""/,
      "arming the prompt needs BOTH preventDefault and the legacy returnValue",
    );
  }

  // ── 3. The draft — the only guard a sidebar click cannot walk past ──────────
  {
    assert.match(
      workspace,
      /const TARGET_DRAFT_KEY = "phoenix\.sales\.targets\.draft\.v1"/,
      "typed targets must be kept somewhere a navigation cannot clear",
    );
    assert.match(
      workspace,
      /window\.localStorage\.setItem\(TARGET_DRAFT_KEY/,
      "the draft belongs in localStorage — sessionStorage dies with the tab, which is the case that lost the work",
    );
    assert.match(workspace, /readTargetDraft\(draftScope\)/, "and must be read back scoped to this grid");

    // Restoring August's numbers onto September's grid is worse than losing them, so the scope is
    // checked on the way IN as well as on the way out.
    assert.match(workspace, /parsed\.scope !== scope/, "a draft must never be restored onto a different line or month");
    assert.match(
      workspace,
      /const draftScope = draftScopeOf\(props\.selectedLine, props\.selectedPeriod\)/,
      "the draft scope is the line AND the period",
    );
    assert.match(
      workspace,
      /draftRestoredRef = useRef<string \| null>\(null\)/,
      "the restore latch must hold the scope it restored, not a bare boolean — switching month re-renders, it does not remount",
    );

    const persist = workspace.match(
      /if \(draftRestoredRef\.current !== draftScope\) return;\s*writeTargetDraft\([\s\S]*?\);/,
    )?.[0];
    assert.ok(persist, "the draft must be written whenever the edits change, not on unload");
    assert.match(persist, /hasUnsavedEdits \?[\s\S]*?: null/, "and cleared once nothing is unsaved");

    assert.match(
      workspace,
      /const unchanged = raw === "" \? live == null : Number\(raw\) === live;/,
      "a draft entry equal to the live row is already committed and must be dropped, not restored",
    );
    // A restored edit inside a collapsed region is invisible, which reads as lost all over again.
    assert.match(workspace, /setOpenRegions\(\(current\) => \(\{ \.\.\.Object\.fromEntries/, "restoring must open the regions the edits belong to");
    assert.match(workspace, /hasUnsavedEdits \? \(\s*<span/, "an unsaved grid must say so beside the Save button");
    assert.match(workspace, /Not saved yet/, "in words, not only as a count on the button");
  }

  // ── 4. No achievement on this tab (owner, 2026-09-08) ───────────────────────
  {
    for (const banned of ["achievement", "Achievement", "actualValue", "coveredActualValue"]) {
      assert.ok(
        !workspace.includes(banned),
        `the authoring screen must not mention ${banned} — achievement lives on Business Review and the portal tab`,
      );
    }
    assert.ok(
      !page.includes("loadMonthlyAchievement"),
      "the page must not load achievement at all",
    );
  }

  // ── 5. No table, no scrolling box — regions are buttons that open ───────────
  {
    assert.ok(!/<table/.test(workspace), "the owner rejected the table outright: regions open into areas instead");
    assert.ok(
      !/overflow-y-auto|overflow-x-auto|max-h-\[/.test(workspace),
      "and nothing may sit in its own scrollbar — the page scrolls, once",
    );
    assert.match(workspace, /aria-expanded=\{open\}/, "a region must be a real expandable button, not a div");
    assert.match(
      workspace,
      /setOpenRegions\(\(current\) => \(\{ \.\.\.current, \[region\.name\]: !open \}\)\)/,
      "regions open and close independently — more than one at a time",
    );
  }

  // ── 6. The rows come from the model, so an empty future month is typeable ───
  {
    assert.match(page, /loadTargetableAreas\(selectedLine\)/, "areas come from the canonical model");
    assert.match(page, /loadTargetableProducts\(selectedLine\)/, "products too");
    assert.match(
      page,
      /rows = areas\.flatMap\(\(area\) =>\s*products\.map\(/,
      "every targetable area × every active product — a month with no sales must still render a grid to type into",
    );
  }

  // ── 7. Units are never totalled across different products (owner rule) ──────
  {
    assert.match(
      workspace,
      /if \(product !== "all" && units != null\)/,
      "a unit subtotal is only meaningful when the view is filtered to ONE product",
    );
  }

  // ── 8. Template spans are CALENDAR quarters and halves ──────────────────────
  {
    assert.deepEqual(expandTargetPeriodScope("2026-08", "month"), ["2026-08"]);

    // August sits in Q3 — Jul, Aug, Sep. NOT Aug, Sep, Oct: a rolling window would hand back a
    // span matching no plan and no payout, and the sheet would still look right.
    assert.deepEqual(expandTargetPeriodScope("2026-08", "quarter"), ["2026-07", "2026-08", "2026-09"]);
    assert.deepEqual(expandTargetPeriodScope("2026-10", "quarter"), ["2026-10", "2026-11", "2026-12"]);
    assert.deepEqual(expandTargetPeriodScope("2026-01", "quarter"), ["2026-01", "2026-02", "2026-03"]);

    assert.deepEqual(
      expandTargetPeriodScope("2026-08", "semester"),
      ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"],
    );
    assert.deepEqual(
      expandTargetPeriodScope("2026-03", "semester"),
      ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
    );

    // A quarter never straddles a year end, and a semester never straddles it either.
    for (const scope of ["quarter", "semester"] as const) {
      for (const period of ["2026-01", "2026-06", "2026-07", "2026-12"]) {
        const span = expandTargetPeriodScope(period, scope);
        assert.ok(
          span.every((month) => month.startsWith("2026-")),
          `${scope} of ${period} must stay inside its own year`,
        );
      }
    }

    // Rubbish in yields just itself — never six bad months the download would hide.
    assert.deepEqual(expandTargetPeriodScope("not-a-month", "semester"), ["not-a-month"]);
  }

  // ── 9. The template route offers both fill states over that span ────────────
  {
    const route = code(read("app/api/sales/targets/template/route.ts"));
    assert.match(route, /expandTargetPeriodScope\(requestedPeriod, scope\)/, "the route must widen the layout to the chosen span");
    assert.match(route, /const populated = url\.searchParams\.get\("populated"\) === "true"/, "and offer the populated fill state");
    assert.match(
      route,
      /await assertPermission\(access, "sales", "import"\)/,
      "the populated download carries real targets — it stays gated like the authoring screen",
    );
    assert.match(
      workspace,
      /populated=\$\{populated \? "true" : "false"\}/,
      "the page must ask for the fill state it is offering",
    );
  }

  // ── 10. Filter by region, area, product and whether it is set yet ───────────
  {
    for (const [label, state] of [
      ["Region", "region"],
      ["Area", "area"],
      ["Product", "product"],
      ["Show", "status"],
    ] as const) {
      assert.ok(
        workspace.includes(`label="${label}"`),
        `the toolbar must offer a ${label} filter`,
      );
      assert.match(
        workspace,
        new RegExp(`if \\(${state} !== "all"`),
        `and the ${label} filter must actually narrow the rows`,
      );
    }

    // The Area list follows the Region choice. A picker wider than its own result hands back an
    // empty board, which reads as broken data rather than as a filter (the same shape as the
    // company-wide picker offered to one rep).
    assert.match(
      workspace,
      /if \(region !== "all" && row\.regionName !== region\) continue;/,
      "the Area options must be bounded by the chosen Region",
    );
    assert.match(
      workspace,
      /setRegion\(value\);\s*setArea\("all"\);/,
      "changing Region must reset Area, or a stale area silently empties the grid",
    );

    // "Not set yet" has to read the LIVE value, or a cell you just typed still counts as blank.
    assert.match(workspace, /const filled = liveValueOf\(row\) != null;/, "the set/blank filter reads the pending edit, not only the stored value");
  }

  // ── 11. An upload names its months, and the server checks the answer ────────
  {
    const upload = code(read("app/api/sales/targets/upload/route.ts"));

    // The sheet carries its own Period column, so the month it writes is whatever is in the FILE.
    assert.match(upload, /const periodKeys = \[\.\.\.new Set\(periods\.map\(/, "the route must work out which months the file holds");
    assert.match(upload, /overwrites: overwritesByKey\.get\(/, "and say how many cells it would REPLACE, not only how many it writes");

    const guard = upload.match(/const confirmed = String\(form\.get\("confirmPeriods"\)[\s\S]*?status: 409[\s\S]*?\);/)?.[0];
    assert.ok(guard, "the commit must refuse unless the caller confirms the months the file holds");
    assert.match(guard, /confirmed\.length === periodKeys\.length/, "the confirmed set must match the file's set exactly");
    assert.match(guard, /period_confirmation_required/, "and say so with a code the page can act on");

    // The guard lives on the SERVER. A confirmation only the dialog checks is decoration — the
    // dialog can be skipped by any other caller of this route.
    const commitAt = upload.indexOf("upsertMonthlyTargets({");
    const guardAt = upload.indexOf("period_confirmation_required");
    assert.ok(guardAt >= 0 && commitAt >= 0 && guardAt < commitAt, "the refusal must come BEFORE the write");

    assert.match(workspace, /form\.append\("confirmPeriods", confirmPeriods\.join\(","\)\)/, "the page must send what it showed");
    assert.match(
      workspace,
      /if \(confirmPeriods\.length === 0\) \{[\s\S]*?return;/,
      "and must not offer a save before the file has been checked",
    );
    assert.match(workspace, /window\.confirm\(\s*`This file writes targets for/, "one confirmation, naming every month the file holds");
  }
}
