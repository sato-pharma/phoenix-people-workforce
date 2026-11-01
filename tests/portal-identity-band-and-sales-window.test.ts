import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { salesWindowLabel, splitDepartedRoster } from "../src/lib/employee-portal/home-snapshot.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Three owner rules stated on 2026-09-03, pinned so a later edit cannot quietly undo any of them.
//
//  1. NOTHING RENDERS ABOVE THE IDENTITY BANNER. Said twice in one sitting — first about the plan
//     adherence card ("the place where you are putting the percentage of matching of the plan is
//     very bad — never put anything above the identity bar"), then about the two arrangeable nav
//     rows and their "+" ("remove it totally"). Both had the same shape: the portal's landing page
//     opens with a person's own signature card, and something had been placed in front of it.
//
//     The plan card got there because PortalCommandCenter HOISTED it above the role dashboard so
//     one placement would serve all five role branches — a reasonable instinct that put it above
//     the identity card in every one of them. The fix keeps that instinct and moves the hoist
//     inside PortalIdentityBand, a component every landing surface renders FIRST. This test is
//     what stops the next hoist.
//
//  2. NAME THE WINDOW. "You must show this achievement is in which window?" The manager keycards
//     are built from PUBLISHED monthly closings, and a closing publishes only after its month has
//     ended — so on 3 September the newest figures were July's, under the words "achieved this
//     period".
//
//  3. NO ELLIPSIS, ANYWHERE IN THE PORTAL. Standing owner rule, and the boards were truncating
//     the one thing on them that identifies a row: a person's name.
//
// Plus the data rule behind the other half of that conversation ("how am I still seeing employees
// who resigned in his main dashboard?"): a leaver leaves the LIST, never the MONEY.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every portal landing surface, in render order. Each one opens with the person's identity card
 * and must therefore render `PortalIdentityBand` before any other portal building block.
 */
const LANDING_SURFACES = [
  "src/components/employee-portal/portal-command-center.tsx",
  "src/components/employee-portal/dashboards/dsm-command-center.tsx",
  "src/components/employee-portal/dashboards/nsm-command-center.tsx",
  "src/components/employee-portal/dashboards/rm-command-center.tsx",
  "src/components/employee-portal/dashboards/marketing-manager-command-center.tsx",
  "app/employee-portals/training-manager/page.tsx",
] as const;

/**
 * The opening tag of a role command center's own render. Every landing surface returns exactly
 * this shape, and `portal-command-center.tsx` holds three of them (PM/GPM, Medical Rep, Standard)
 * beside the shared primitives — so the scan has to start HERE and not at the top of the file, or
 * the `<IdentityCard>` inside PortalIdentityBand's own definition reads as a stray card above it.
 */
const ROLE_CENTER_ROOT = /<div className="mx-auto w-full space-y-[^"]*" dir="auto">/g;

/**
 * The blocks that make up a landing page. If any of these is rendered before the identity band,
 * something has been placed above the person's own card again.
 *
 * `PlanAdherenceDashboardCard` is named explicitly even though it now lives INSIDE the band: a
 * reader who re-hoists it would write it here, above, exactly as it was before.
 */
const LANDING_BLOCKS =
  /<(PortalIdentityBand|IdentityCard|ProfileIntelBar|PlanAdherenceDashboardCard|PortalContextBar|PendingActions|GlanceStrip|QuickActions|SectionHead|KeycardGrid|RankingPanel|DashboardsGrid|ActionStrip|NationalKeycards|RegionKeycards)\b/g;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function directoryRow(over: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    displayName: over.hrId,
    employmentStatus: "active",
    organogramVisible: true,
    jobTitle: "Medical Representative",
    ...over,
  } as EmployeeDirectoryRow;
}

export function runPortalIdentityBandAndSalesWindowTests() {
  // ── 1. HEADLINE: nothing renders above the identity banner ───────────────────────
  let roleCentersChecked = 0;
  for (const path of LANDING_SURFACES) {
    const source = stripComments(read(path));

    // A file may hold several role branches — portal-command-center.tsx holds three — so every
    // one of them is checked, not just the first.
    const roots = [...source.matchAll(ROLE_CENTER_ROOT)].map((match) => match.index ?? 0);
    assert.ok(
      roots.length > 0,
      `${path}: found no role command center render at all. Either the root element changed shape ` +
        "or this file moved; either way the identity-band rule is no longer being checked here.",
    );

    for (const [index, start] of roots.entries()) {
      const end = roots[index + 1] ?? source.length;
      const render = source.slice(start, end);
      const blocks = [...render.matchAll(LANDING_BLOCKS)].map((match) => match[1]);

      assert.ok(
        blocks[0] !== undefined,
        `${path} (render ${index + 1}): renders no landing blocks — has it been emptied?`,
      );
      assert.equal(
        blocks[0],
        "PortalIdentityBand",
        `${path} (render ${index + 1}): <${blocks[0]}> renders above the identity band. ` +
          "Owner rule, 2026-09-03: never put anything above the identity banner.",
      );
      roleCentersChecked += 1;
    }

    assert.ok(
      !/<PlanAdherenceDashboardCard\b/.test(source.slice(roots[0])),
      `${path}: renders PlanAdherenceDashboardCard inside a role center. It belongs inside ` +
        "PortalIdentityBand, which is what keeps it below the identity card on every branch.",
    );
  }
  assert.ok(
    roleCentersChecked >= 8,
    `only ${roleCentersChecked} role command centers were checked; there are at least 8 ` +
      "(PM/GPM, Medical Rep, Standard, DSM, NSM, RM, Marketing Manager, Training Manager). " +
      "A landing surface that stops matching is a landing surface this rule stops protecting.",
  );

  // Each role branch gets its own band, and none of them may drop the plan card by passing null:
  // the prop is required precisely so a branch cannot forget it.
  {
    const hub = read("src/components/employee-portal/portal-command-center.tsx");
    assert.ok(
      /planAdherence: Streamed<PortalPlanAdherence \| null>;/.test(hub),
      "PortalIdentityBand's planAdherence prop must stay REQUIRED — an optional prop lets a new " +
        "role branch silently lose the plan card, which is the bug this component replaced.",
    );
  }

  // ── 2. The two arrangeable nav rows are gone from the portal ─────────────────────
  {
    const layout = stripComments(read("src/components/employee-portal/employee-portal-layout.tsx"));
    for (const banned of ["UpperNavRow", "LowerNavRow", "HorizontalNavProvider", "NavRowAddButton"]) {
      assert.ok(
        !layout.includes(banned),
        `employee-portal-layout.tsx still references ${banned}. The portal has no horizontal nav ` +
          'rows — owner, 2026-09-03: "remove it totally". The ADMIN shell keeps its rows; this is ' +
          "not a parity gap to close.",
      );
    }
  }

  // ── 3. No ellipsis anywhere in the portal ────────────────────────────────────────
  {
    const withTruncate: string[] = [];
    for (const path of [
      ...LANDING_SURFACES,
      "src/components/employee-portal/line-top-achievers-card.tsx",
      "src/components/employee-portal/dashboards/double-visit-focus-section.tsx",
      "src/components/employee-portal/account-activation-workspace.tsx",
      "src/components/employee-portal/dv-planner-workspace.tsx",
      "src/components/employee-portal/bottom-nav-customizer.tsx",
    ]) {
      // The class, not the word: `truncate` inside prose or an identifier is not an ellipsis.
      if (/className="[^"]*\btruncate\b/.test(read(path))) withTruncate.push(path);
    }
    assert.deepEqual(
      withTruncate,
      [],
      `these portal files truncate text with an ellipsis: ${withTruncate.join(", ")}. ` +
        "Standing owner rule — never truncate with an ellipsis; wrap instead.",
    );
  }

  // ── 4. A leaver leaves the LIST, never the MONEY ─────────────────────────────────
  {
    const directory = [
      directoryRow({ hrId: "B-94", displayName: "Taha", jobTitle: "District Sales Manager" }),
      directoryRow({ hrId: "B-101", displayName: "Still Here" }),
      directoryRow({ hrId: "B-164", displayName: "Essam", employmentStatus: "resigned", organogramVisible: false }),
      directoryRow({ hrId: "B-52", displayName: "Fiby", employmentStatus: "resigned", organogramVisible: false }),
    ];
    const roster = [
      { hrId: "B-101", totalSales: 100 },
      { hrId: "b164", totalSales: 40 },
      { hrId: "B-52", totalSales: 60 },
    ];

    const split = splitDepartedRoster(roster, directory);
    assert.deepEqual(
      split.active.map((row) => row.hrId),
      ["B-101"],
      "a resigned rep must not be ranked on their old manager's board months after leaving",
    );
    assert.deepEqual(
      split.departed.map((row) => row.hrId),
      ["b164", "B-52"],
      "the departed rows must be RETURNED, not discarded — the board has to be able to say how " +
        "much of the total above it belongs to names it is no longer showing. Note b164: HR ids " +
        "are mixed case and hyphenated inconsistently, and a plain .eq under-returns.",
    );
    assert.equal(
      split.departed.reduce((sum, row) => sum + row.totalSales, 0),
      100,
      "their sales are real and stay in the headline total; only the LIST is filtered",
    );

    // The guard that stops this fix becoming the worse bug: every call site reads the directory
    // with `.catch(() => [])`, and an empty active-set must never empty a manager's team.
    assert.deepEqual(
      splitDepartedRoster(roster, []).active.map((row) => row.hrId),
      ["B-101", "b164", "B-52"],
      "an unreadable directory must degrade to UNFILTERED, never to an empty board",
    );
  }

  // ── 5. The window a keycard covers, named ────────────────────────────────────────
  {
    assert.equal(
      salesWindowLabel(["2026-07"]),
      "Jul 2026",
      "one published closing reads as that month, not as a range",
    );
    assert.equal(
      salesWindowLabel(["2026-08", "2026-06", "2026-07"]),
      "Jun – Aug 2026",
      "an unsorted window is sorted before it is named, and a multi-month window is named as a range",
    );
    assert.equal(
      salesWindowLabel([]),
      null,
      "nothing published must return null so the caller can stay silent rather than name a wrong month",
    );
    assert.equal(salesWindowLabel(null), null);
    assert.equal(
      salesWindowLabel(["not-a-period", "2026-07"]),
      "Jul 2026",
      "a malformed period is dropped, never rendered raw at a manager",
    );

    // And the phrase it replaced must be gone from every manager keycard.
    for (const path of [
      "src/components/employee-portal/dashboards/dsm-command-center.tsx",
      "src/components/employee-portal/dashboards/nsm-command-center.tsx",
      "src/components/employee-portal/dashboards/rm-command-center.tsx",
    ]) {
      assert.ok(
        !stripComments(read(path)).includes("achieved this period"),
        `${path}: still says "achieved this period". These figures come from published closings — ` +
          'owner, 2026-09-03: "you must show this achievement is in which window?"',
      );
    }
  }

  // ── 6. Two things the eye caught that no assertion could ────────────────────────────────
  {
    const dv = read("src/components/employee-portal/dashboards/double-visit-focus-section.tsx");

    // FITS THE SCREEN. The trend chart claimed 44px per month behind an overflow-x-auto band, so
    // at 375px its three most recent months sat off the right edge — clipped, and invisible to a
    // scrollWidth check on `main`, which read 351/351 throughout. The owner's rule names this exact
    // shape as the bug: "overflow-x-auto over a min-width floor IS the bug, not the fix".
    assert.ok(
      !/minWidth/.test(dv),
      "the double-visit trend chart has a min-width floor again. That floor is what pushed Jul, " +
        "Aug and Sep off a 375px screen. The columns must SHARE the width (flex-1 under a max-w " +
        "cap), never claim a fixed number of pixels each.",
    );

    // WHITE ON WHITE. CoverageRing's percentage was fill="white" on ScopeFocusPanel's bg-white
    // body, so the one number the panel exists to show was invisible on every screen it had ever
    // rendered on. Nothing failed — it simply was not there. Same shape as the white Sato wordmark
    // on white paper.
    const ring = dv.slice(dv.indexOf("function CoverageRing"), dv.indexOf("function ScopeFocusPanel"));
    assert.ok(
      ring.length > 0,
      "CoverageRing has moved or been renamed — the white-on-white check no longer covers it.",
    );
    assert.ok(
      !/fill="white"/.test(ring),
      'CoverageRing draws in fill="white" again. Its card body is bg-white, so white text there is ' +
        "not low-contrast — it is absent.",
    );
  }

  // ── 7. The portal's loading skeleton fits the screen too ──────────────────────────────
  {
    const skeleton = read("src/components/employee-portal/employee-portal-route-loading.tsx");
    // A w-64 bar beside a w-24 block in a row that could not wrap gave the card a 394px
    // min-content. Its grid column is auto-sized, so at 375px the column grew to 394 and the whole
    // portal scrolled sideways on EVERY page load — before any real content existed to blame.
    assert.ok(
      !/employee-portal-skeleton[^"]*\bw-64\b/.test(skeleton),
      "the portal loading skeleton has a fixed w-64 bar again. A placeholder must claim a SHARE " +
        "of the width (w-full under a max-w cap), never a fixed 256px — at 375px that one bar put " +
        "a horizontal scrollbar on every portal page load.",
    );
  }
}
