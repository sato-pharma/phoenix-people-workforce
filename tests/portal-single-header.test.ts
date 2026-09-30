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
];

/**
 * 🔴 DELIBERATELY NOT A ROW: `src/components/employee-360/employee-360-view.tsx`.
 *
 * It contains an `<h1>` under a shell that passes `title="Employee 360"`, which a grep for `<h1>`
 * reports as this defect. It is not one — the heading is `{subject.displayName}`, the PERSON being
 * looked at, not the page. Nothing is printed twice, and there is nothing for a viewer to see wrong.
 * There is a semantic argument for demoting it to `<h2>` under the shell's page title; that is a
 * different change, it was not asked for, and adding a row here would force it. Audited 2026-09-30.
 */

// 🔴 THE `<h1>` CHECK IS THE LOAD-BEARING ONE; THIS LIST IS THE SECOND FENCE, NOT THE FIRST.
// `bg-slate-900` is deliberately ABSENT: Report It uses it for buttons, table header rows and the
// submitted-successfully panel, all of which are fine, so banning it here would fail on correct code
// (the tighter ban lives in `tests/spotlight-portal-look.test.ts`, whose component uses none of
// those). The removed Report It hero was `bg-slate-900` — what catches its return is the `<h1>` rule,
// because a page header is a heading whatever colour it is painted.
const DARK_HERO_TOKENS = ["bg-slate-950", "bg-[#08111f]"] as const;

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
      const body = read(guard.file);

      if (guard.h1 === "never") {
        assert.ok(
          !/<h1[\s>]/.test(body),
          `${guard.file} renders an <h1> while ${page}'s shell already renders the page title. Two`
            + " page titles is the defect the owner named on Spotlight and again on Report It; use an"
            + " <h2> for a section inside the page. If this component is now SHARED with the admin"
            + " shell and legitimately needs a heading there, change its row to h1: \"gated\" and"
            + " assert the prop this page passes — do not delete the row.",
        );

        for (const token of DARK_HERO_TOKENS) {
          assert.ok(
            !body.includes(token),
            `${guard.file} paints a dark banner (${token}) under the shell's own navy header.`
              + " The shell owns the header.",
          );
        }
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
        guard.componentGate.test(stripComments(body)),
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
