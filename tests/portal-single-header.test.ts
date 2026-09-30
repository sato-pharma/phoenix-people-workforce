import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * THE SHELL OWNS THE PAGE HEADER.
 *
 * `EmployeePortalPageShell` renders the navy command header on every portal page — the badge, the
 * title and the description. A component rendered INSIDE it that draws its own dark hero stacks two
 * dark blocks and repeats the same three strings, which is what the owner saw and named twice:
 *
 *   2026-09-30, on Spotlight: "good design but take care the header is duplicated so see what is
 *                              applicable to remove it"
 *   2026-09-30, on Report It: "fix the duplicated header on report it too"
 *
 * On Report It it was worse than a repeat. The dashboard hero said `Pharmacovigilance` /
 * `Report It — Dashboard` / `Adverse drug reaction reports` while the shell said `Pharmacovigilance`
 * / `Report It Dashboard` / `Adverse drug reaction reports dashboard.` — and on the self-service
 * branch of the page that hero rendered a THIRD time, underneath the form and under an `<h2>My
 * Reports</h2>` of its own.
 *
 * Three more pages were added on his word the same day ("add kpis, field activity and double visit
 * analytics to 4889 too"), and checking them corrected the claim that sent him here: **only Field
 * Activity was actually broken.** KPIs already gated its heading on `chrome === "admin"` and Double
 * Visit Analytics on `embedded`; both were reported as defects by a grep for `<h1>` over their
 * source, which cannot see a runtime condition. Field Activity had no gate at all, because the admin
 * page renders it bare — so it gained the same `chrome` prop KPIs uses rather than losing its title.
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * 🔴 A GATED ROW MUST BE MATCHED AGAINST CODE, NEVER AGAINST A COMMENT.
 *
 * Caught while break-testing this file on 2026-09-30: all three gated assertions below passed with
 * the prop DELETED from the JSX, because every one of those pages also NAMES the prop in a comment
 * explaining why it is there — `// the board now takes chrome="portal"`, `// rendered with
 * embedded=true`, and the JSX notes added with this change. The assertion was reading its own
 * documentation back and calling it proof.
 *
 * 🔴 THE FIRST FIX FOR THAT WAS ITSELF WRONG, AND THE REPO CAUGHT IT. A hand-rolled
 * `split("\n").filter(...)` line filter went red in `validate` against
 * `tests/comment-strip-ratchet.test.ts`, which exists precisely because a line-wise filter tracks no
 * block state: it skips a `{/*` line without OPENING a comment, so the BODY of a multi-line JSX
 * comment is read as code. `stripComments` scans for string and template state instead of guessing,
 * and is the one implementation every source-pinning test here uses.
 */

/**
 * A component under the shell is guarded one of two ways, and the difference is the whole reason
 * this file is not a grep.
 *
 * `never` — the component holds no `<h1>` at all. A static scan of its source IS the proof.
 *
 * `gated` — the component is shared with the ADMIN shell, which renders it bare and so needs the
 * heading. Its source therefore still contains an `<h1>`, correctly, and the thing that can regress
 * is the PAGE forgetting to say which shell it is in. So the assertion moves to the page: it must
 * pass the gating prop. 🔴 THIS IS WHY A GREP FOR `<h1>` OVER THESE COMPONENTS LIES — it reported
 * KPIs and Double Visit Analytics as broken on 2026-09-30 when both were already correct, because a
 * grep cannot see a runtime condition. Read the gate before believing a match.
 */
type Guard =
  | { file: string; h1: "never" }
  | { file: string; h1: "gated"; componentGate: RegExp; pagePasses: RegExp; why: string };

const SHELL_OWNS_THE_HEADER: ReadonlyArray<{ page: string; components: readonly Guard[] }> = [
  {
    components: [{ file: "src/components/spotlight/rep-spotlight-workspace.tsx", h1: "never" }],
    page: "app/employee-portals/spotlight/page.tsx",
  },
  {
    components: [
      { file: "src/components/report-it/report-it-form.tsx", h1: "never" },
      { file: "src/components/report-it/report-it-employee-dashboard.tsx", h1: "never" },
    ],
    page: "app/employee-portals/report-it/page.tsx",
  },
  {
    components: [
      {
        file: "src/components/crm/kpis-board-view.tsx",
        componentGate: /showTitle={chrome === "admin"}/,
        h1: "gated",
        pagePasses: /chrome=["']portal["']/,
        why: "KpiHero draws the rail, kicker and <h1> only when showTitle, which is chrome === \"admin\".",
      },
    ],
    page: "app/employee-portals/kpis/page.tsx",
  },
  {
    components: [
      {
        componentGate: /\{chrome === "admin" \? \(/,
        file: "src/components/field-activity/field-activity-view.tsx",
        h1: "gated",
        pagePasses: /chrome=["']portal["']/,
        why: "The admin page renders this view BARE, with no shell, so its <h1> is the only title there.",
      },
    ],
    page: "app/employee-portals/field-activity/page.tsx",
  },
  {
    components: [
      {
        componentGate: /\{embedded \? \(/,
        file: "src/components/double-visit-analytics/double-visit-analytics-workspace.tsx",
        h1: "gated",
        pagePasses: /\bembedded\b/,
        why: "The workspace swaps its hero for a slim toolbar when embedded; the admin page keeps the hero.",
      },
    ],
    page: "app/employee-portals/double-visit-analytics/page.tsx",
  },
  {
    components: [
      {
        componentGate: /\{chrome === "admin" \? \(/,
        file: "src/components/territory-management/territory-map-workspace.tsx",
        h1: "gated",
        pagePasses: /chrome=["']portal["']/,
        why: "app/(admin)/sales/territory-management/page.tsx renders this workspace BARE, with no"
          + " shell, so its <h1> is the only title on that screen.",
      },
    ],
    page: "app/employee-portals/territory-management/page.tsx",
  },
  // Employee 360 has TWO portal entry points and they share one view, so both are asserted: a prop
  // added to one page and forgotten on the other is exactly the half-fix this registry exists to
  // catch. It was recorded here as a deliberate NON-row until 2026-09-30, on the grounds that nothing
  // rendered twice; the owner then asked for the demotion anyway ("change the employee 360 h1 to an
  // h2"), which is the stronger reading — a screen reader announces a second <h1> as the page's name,
  // so a viewer who cannot see the layout is told the employee's name is the page.
  {
    components: [
      {
        componentGate: /\{chrome === "admin" \? \(/,
        file: "src/components/employee-360/employee-360-view.tsx",
        h1: "gated",
        pagePasses: /chrome=["']portal["']/,
        why: "app/(admin)/employee-360/[hrId]/page.tsx renders this view BARE, and its own three <h1>s"
          + " are all in not-found/error branches, so on the admin SUCCESS path this is the page's ONLY"
          + " <h1>. An unconditional demotion would leave that page with no top-level heading.",
      },
    ],
    page: "app/employee-portals/employee-360/[hrId]/page.tsx",
  },
  {
    components: [
      {
        componentGate: /\{chrome === "admin" \? \(/,
        file: "src/components/employee-360/employee-360-view.tsx",
        h1: "gated",
        pagePasses: /chrome=["']portal["']/,
        why: "The second portal entry point onto the same view — see the row above.",
      },
    ],
    page: "app/employee-portals/employee-360/page.tsx",
  },
  {
    // `h1: "never"` rather than gated, because this component's intro renders in the PORTAL ONLY:
    // `admin-shell-employee-pages.tsx` passes `showIntro={false}` and takes its heading from
    // `AdminPageHero`. So no shell needs an <h1> from the wizard and it should hold none.
    components: [{ file: "src/components/outstation/mobile-outstation-wizard.tsx", h1: "never" }],
    page: "app/employee-portals/submit-expense/page.tsx",
  },
];

/**
 * 🔴 THIS REGISTRY IS NOW THE COMPLETE SET, MEASURED RATHER THAN COLLECTED.
 *
 * Every page under `app/employee-portals/` that renders inside `EmployeePortalPageShell` without a
 * `hero` was swept on 2026-09-30, and each component it imports was classified by whether its
 * heading is gated and whether the page passes a discriminator. Six components held an `<h1>`; all
 * six are rows here. Nothing else on the portal draws a second page title.
 *
 * So a NEW page failing this rule should be caught by review, not found months later by a grep — and
 * if a sweep ever reports a seventh, read its GATE before calling it a defect. Two of the six were
 * reported to the owner as broken that day on the strength of a `<h1>` grep alone and were already
 * correct (`kpis-board-view.tsx` gated on `chrome`, `double-visit-analytics-workspace.tsx` on
 * `embedded`). A grep cannot see a runtime condition.
 */

// 🔴 THE DARK-BACKGROUND BAN IS GONE FROM THIS FILE, AND ITS REMOVAL IS THE POINT OF THIS NOTE.
//
// It banned `bg-slate-950` and `bg-[#08111f]` in every registered component, on the theory that a
// page hero is a dark block. Measured against the sixth row on 2026-09-30 it was redundant where it
// passed and WRONG where it fired:
//
//   - Spotlight's tighter ban (900 as well) already lives in `tests/spotlight-portal-look.test.ts`,
//     whose component has no legitimate dark surface — so this copy added nothing there.
//   - Report It's two components paint `bg-slate-900` for buttons, table header rows and the
//     submitted-successfully panel, which are all correct, so 900 could never be banned here anyway
//     and 950 never appeared.
//   - `mobile-outstation-wizard.tsx` uses `bg-slate-950` three times, for the CAMERA VIEWFINDER
//     behind a <video>, that viewfinder's control bar, and a modal scrim at `/45` with a backdrop
//     blur. Every one is right, and the ban failed a correct file.
//
// A colour was never the invariant. `<h1>` is: a page header is a heading whatever it is painted,
// and a dark block that is not a heading is not a page header. Banning the paint instead of the
// heading is the same mistake as grepping for `<h1>` without reading its gate — judging a thing by
// how it looks in the source rather than by what it does.

export function runPortalSingleHeaderTests(): void {
  // The premise: the shell really does paint the header. If this moves, re-derive the rule before
  // trusting anything below it.
  const shell = read("src/components/employee-portal/enterprise-shell.tsx");
  assert.ok(
    shell.includes("bg-[#08111f]"),
    "The portal shell no longer paints its own command header; re-derive what a page may draw.",
  );

  for (const { page, components } of SHELL_OWNS_THE_HEADER) {
    const source = read(page);

    assert.ok(
      source.includes("EmployeePortalPageShell"),
      `${page} must render inside EmployeePortalPageShell so the portal header is the only header.`,
    );
    // A page passing `hero` REPLACES the shell's header rather than stacking under it, so this rule
    // would not apply to it and the row should not be here.
    assert.ok(
      !/\bhero=/.test(source),
      `${page} passes a \`hero\`, which replaces the shell header — remove its row from`
        + " SHELL_OWNS_THE_HEADER rather than asserting a rule that does not apply to it.",
    );

    for (const guard of components) {
      // 🔴 EVERY MATCH IN THIS LOOP RUNS OVER CODE, NEVER OVER COMMENTS — including the `never`
      // branch. It was raw here until 2026-09-30 and went red on its own documentation: the comment
      // recording which heading was removed from `mobile-outstation-wizard.tsx` quotes that tag, and
      // quoting a tag you have deleted is the most natural thing to write. This is the same failure
      // the gated branch already had, in the other direction — there a comment made a broken page
      // pass, here it made a correct one fail.
      const body = stripComments(read(guard.file));

      if (guard.h1 === "never") {
        assert.ok(
          !/<h1[\s>]/.test(body),
          `${guard.file} renders an <h1> while ${page}'s shell already renders the page title. Two`
            + " page titles is the defect the owner named on Spotlight and again on Report It; use an"
            + " <h2> for a section inside the page. If this component is now SHARED with the admin"
            + " shell and legitimately needs a heading there, change its row to h1: \"gated\" and"
            + " assert the prop this page passes — do not delete the row.",
        );

        continue;
      }

      // A gated component: its <h1> is correct for the ADMIN shell, so what must hold is that THIS
      // page tells it which shell it is in. Both halves are asserted — the gate must still exist in
      // the component, and the page must still pass it.
      assert.ok(
        /<h1[\s>]/.test(body),
        `${guard.file} is marked h1: "gated" but no longer renders an <h1> at all. Its admin shell`
          + " may have lost its title — check, then move the row to h1: \"never\".",
      );
      // The gate itself, not just its existence at the call site. Without this, deleting the
      // condition and leaving the <h1> unconditional passed every other assertion here — found by
      // break-testing rather than by reading, which is why it is pinned separately.
      assert.ok(
        guard.componentGate.test(body),
        `${guard.file} no longer gates its <h1> on ${guard.componentGate}, so the heading now renders`
          + ` in the portal as well as the admin shell. ${guard.why}`,
      );
      assert.ok(
        guard.pagePasses.test(stripComments(source)),
        `${page} no longer passes ${guard.pagePasses} to ${guard.file}, so its own page title renders`
          + ` a second time under the shell's. ${guard.why}`,
      );
    }
  }
}
