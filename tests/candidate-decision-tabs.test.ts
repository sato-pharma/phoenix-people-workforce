import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  candidateDecisionTabLabels,
  candidateDecisionTabOf,
  candidateDecisionTabs,
  candidateMatchesDecisionTab,
  countCandidatesByDecisionTab,
  decisionTabForStatusFilter,
  DEFAULT_CANDIDATE_DECISION_TAB,
  isCandidateDecisionTab,
  statusFilterForDecisionTab,
} from "../src/lib/recruitment/candidate-decision-tabs.ts";
import { candidateStatuses } from "../src/lib/recruitment/candidate-status.ts";

/**
 * THE DECISION TABS. The owner, 2026-09-18: "in any screening page you must show did not decide yet —
 * I press on it, it shows me the people I did not decide yet — shortlisted, I press on it, I only see
 * shortlisted — and rejected." And why: once a CV is decided it should stop crowding every list, so
 * that a new CV is easy to see. Asked in chat, he chose Sent to manager and Hired as their own tabs,
 * "All" last, and every screen opening on "Not decided yet".
 *
 * One rule places a CV on a tab, and three screens use it: the screening page, the candidate pool and
 * the WhatsApp Applicants page. This file pins the rule, then that each of the three really uses it.
 */

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

export function runCandidateDecisionTabsTests() {
  // ── 1 · THE TABS, IN HIS ORDER ────────────────────────────────────────────
  assert.deepEqual(
    [...candidateDecisionTabs],
    ["new", "shortlisted", "sent_to_manager", "rejected", "hired", "all"],
    "the undecided work first, the decided piles after, All last",
  );
  assert.equal(DEFAULT_CANDIDATE_DECISION_TAB, "new", "every screen opens on Not decided yet");
  assert.equal(candidateDecisionTabLabels.new, "Not decided yet", "named by what it holds, not the status's own 'New'");
  assert.equal(candidateDecisionTabLabels.all, "All");
  // Every status is exactly one tab, and nothing but "All" is not a status.
  assert.deepEqual(
    candidateDecisionTabs.filter((tab) => tab !== "all"),
    [...candidateStatuses].sort(
      (a, b) => candidateDecisionTabs.indexOf(a as never) - candidateDecisionTabs.indexOf(b as never),
    ),
    "the five piles are the five statuses — a sixth status would need a tab",
  );
  assert.ok(isCandidateDecisionTab("rejected") && isCandidateDecisionTab("all"));
  assert.ok(!isCandidateDecisionTab("decided") && !isCandidateDecisionTab(null));

  // ── 2 · WHICH TAB A CV SITS ON ────────────────────────────────────────────
  for (const status of candidateStatuses) {
    assert.equal(candidateDecisionTabOf(status), status, `a ${status} CV sits on its own tab`);
  }
  assert.equal(candidateDecisionTabOf("Candidate Created"), "new", "the legacy database default reads as undecided");
  // A status nobody can read is shown where the work is, never filed as decided on a guess.
  for (const unreadable of [null, undefined, "", "banana", "Not Eligible — Non-Egyptian (Dubai, UAE)"]) {
    assert.equal(candidateDecisionTabOf(unreadable), "new", `${JSON.stringify(unreadable)} is not a decision`);
  }
  assert.ok(candidateMatchesDecisionTab("rejected", "rejected"));
  assert.ok(!candidateMatchesDecisionTab("rejected", "new"), "a rejected CV is off Not decided yet");
  assert.ok(!candidateMatchesDecisionTab("shortlisted", "new"), "so is a shortlisted one");
  assert.ok(candidateMatchesDecisionTab("rejected", "all") && candidateMatchesDecisionTab(null, "all"), "All keeps everybody");

  // ── 3 · THE COUNTS ADD UP ─────────────────────────────────────────────────
  const counts = countCandidatesByDecisionTab([
    { status: "new" },
    { status: null },
    { status: "shortlisted" },
    { status: "rejected" },
    { status: "rejected" },
    { status: "hired" },
    { status: "sent_to_manager" },
  ]);
  assert.deepEqual(counts, { all: 7, hired: 1, new: 2, rejected: 2, sent_to_manager: 1, shortlisted: 1 });
  assert.equal(
    counts.new + counts.shortlisted + counts.sent_to_manager + counts.rejected + counts.hired,
    counts.all,
    "every CV sits in exactly one pile, so the five add up to All",
  );

  // ── 4 · THE SCREENING LINK'S `status` IS THE TAB ──────────────────────────
  assert.equal(decisionTabForStatusFilter(null), "all", "no status narrowing is the All tab");
  assert.equal(decisionTabForStatusFilter("rejected"), "rejected");
  assert.equal(statusFilterForDecisionTab("all"), null);
  assert.equal(statusFilterForDecisionTab("new"), "new");
  for (const tab of candidateDecisionTabs) {
    assert.equal(decisionTabForStatusFilter(statusFilterForDecisionTab(tab)), tab, `${tab} round-trips through the link`);
  }

  // ── 5 · ALL THREE SCREENS USE IT ──────────────────────────────────────────
  // The screening page: counted after every other filter, then narrowed by the tab.
  const workspace = read("src/lib/recruitment/screening-workspace.ts");
  assert.match(workspace, /const decisionCounts = countCandidatesByDecisionTab\(acrossTabs\);/);
  assert.match(
    workspace,
    /const visible = acrossTabs\.filter\(\(candidate\) => candidateMatchesDecisionTab\(candidate\.status, decisionTab\)\);/,
    "the list is the tab's pile",
  );
  const station = read("src/components/recruitment/workstation/workstation-page-client.tsx");
  assert.match(station, /<CandidateDecisionTabStrip/, "the screening page draws the tabs");
  assert.match(station, /key=\{serverTab\}/, "a new tab starts the workstation afresh on its own pile");
  // The work queue on the rail opens on Everyone, so the list is the whole tab — "Not decided yet 40"
  // then shows forty, not the New-CVs subset of them.
  assert.match(
    read("src/components/recruitment/workstation/screening-workstation.tsx"),
    /useState<ScreeningWorkQueue>\("all"\)/,
  );

  // The pool: tab state opening on Not decided yet, the Status select gone, the strip drawn.
  const pool = read("src/components/recruitment/recruitment-workspace.tsx");
  assert.match(pool, /useState<CandidateDecisionTab>\(DEFAULT_CANDIDATE_DECISION_TAB\)/, "the pool opens on Not decided yet");
  assert.match(pool, /const decisionCounts = countCandidatesByDecisionTab\(filteredCandidates\);/);
  assert.match(pool, /<CandidateDecisionTabStrip/, "the pool draws the tabs");
  assert.doesNotMatch(pool, /<option value="">Any status<\/option>/, "the Status select became the tabs");
  // A rejection is a red flag, so on the Rejected tab the Active / Red split would read "Active 0".
  assert.match(pool, /const showsRedSplit = decisionTab !== "rejected";/);

  // The WhatsApp Applicants page.
  const whatsApp = read("src/components/recruitment/whatsapp-applicants-search.tsx");
  assert.match(whatsApp, /useState<CandidateDecisionTab>\(DEFAULT_CANDIDATE_DECISION_TAB\)/, "it opens on Not decided yet");
  assert.match(whatsApp, /<CandidateDecisionTabStrip/, "and draws the tabs");

  // ── 6 · "CUT" A CV INTO ONE OF HIS OWN FOLDERS FROM THE POOL ─────────────
  // His words: make a folder called Archive and "cut the rejected CVs and put them there". So the
  // pool's bulk bar moves the ticked CVs, through the route that asserts `candidates: update`.
  assert.match(pool, /Move to folder/);
  assert.match(pool, /postJson\(`\/api\/recruitment\/cv-folders\/\$\{bulkFolderId\}\/items`, \{\s+candidateIds: selectedVisibleIds,\s+mode: "move",/);
  assert.match(pool, /\{canFileCandidates && cvFolderChoices\.length > 0 \? \(/, "offered only to a filer, and only when a folder exists");
  assert.match(pool, /canFileCandidates=\{props\.canFileCandidates\}/, "and the grant reaches the pool");
  const route = read("app/api/recruitment/cv-folders/[id]/items/route.ts");
  assert.match(
    route,
    /requireRecruitmentAccess\(request, "candidates", "update"\)/,
    "the route it posts to enforces the same grant",
  );
}
