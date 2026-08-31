import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  aggregateManagerCvEngagement,
  canViewManagerCvEngagement,
  engagementHrKey,
  type EngagementManagerMeta,
  type EngagementMembership,
} from "../src/lib/recruitment/manager-cv-engagement.ts";

function read(relativePath: string): string {
  return readFileSync(relativePath, "utf8");
}

function meta(over: Partial<EngagementManagerMeta> & { managerHrId: string }): [string, EngagementManagerMeta] {
  const key = engagementHrKey(over.managerHrId);
  if (!key) throw new Error("bad manager id in fixture");
  return [
    key,
    {
      managerHrId: over.managerHrId,
      name: over.name ?? "A Manager",
      jobTitle: over.jobTitle ?? "District Manager",
      area: over.area ?? "Giza",
      line: over.line ?? "CNS",
      inactive: over.inactive ?? false,
      employmentStatusLabel: over.employmentStatusLabel ?? null,
      lastWorkingDate: over.lastWorkingDate ?? null,
    },
  ];
}

export function runRecruitmentManagerCvEngagementTests() {
  // ── The gate admits EXACTLY the owner's five, and no one else ──────────────────────────────
  // Super Admin (by system scope), CEO, and the three National Sales Managers (by role). The five
  // are two people plus three seats; the gate keys on scope + role, so it is the three roles below.
  assert.equal(canViewManagerCvEngagement({ role: "Super Admin", scope: "system" }), true, "Super Admin sees it");
  assert.equal(canViewManagerCvEngagement({ role: "CEO", scope: "self" }), true, "CEO sees it");
  assert.equal(
    canViewManagerCvEngagement({ role: "National Sales Manager", scope: "self" }),
    true,
    "National Sales Manager sees it (scoped to his line elsewhere)",
  );
  // Explicitly NOT SFE — the owner named this exclusion in the same breath as the five.
  assert.equal(canViewManagerCvEngagement({ role: "SFE Manager", scope: "self" }), false, "SFE Manager must NOT see it");
  // NOT the broader recruitment audience either: HR Advisory can read every requisition, but the
  // engagement report is a narrower list than canSeeAllRecruitment on purpose.
  assert.equal(canViewManagerCvEngagement({ role: "HR Advisory", scope: "self" }), false, "HR Advisory is not on the list");
  // NOT the managers being measured.
  assert.equal(canViewManagerCvEngagement({ role: "District Manager", scope: "self" }), false, "a measured manager cannot see it");
  assert.equal(canViewManagerCvEngagement({ role: "Regional Manager", scope: "self" }), false, "Regional Manager is not on the list");
  assert.equal(canViewManagerCvEngagement({ role: "Medical Rep", scope: "self" }), false, "a rep cannot see it");

  // ── engagementHrKey collapses mixed-case HR ids to one canonical, upper spelling ────────────
  // HR ids in this codebase are mixed case, and a plain equality has under-returned by 28%
  // elsewhere. A membership stored lower ("dm-7") and a view stored upper ("DM-7") must land on one key.
  assert.equal(engagementHrKey("Dm-7"), engagementHrKey("DM-7"));
  assert.equal(engagementHrKey("dm-7"), "DM-7");
  assert.equal(engagementHrKey(""), null);
  assert.equal(engagementHrKey(null), null);

  // ── The aggregator: counts, dedup, open-attribution, answered, sorting, manager facts ───────
  // A membership is one (manager, candidate) pair, harvested from the folder AND the hand-push
  // routes and unioned. A candidate that reached a manager by two routes appears twice here and
  // must count once.
  const memberships: EngagementMembership[] = [
    // Folder memberships carry the area they were filed under — the expanded list groups by this.
    { managerHrId: "Dm-7", candidateId: "c1", area: "Nasr City" },
    { managerHrId: "Dm-7", candidateId: "c2", area: "No area named" },
    { managerHrId: "Dm-7", candidateId: "c3", area: "Nasr City" },
    // The SAME CV reaching the SAME manager twice — his folder AND a hand-push. Must count once, and
    // the folder's area ("Nasr City") must survive the area-less push.
    { managerHrId: "Dm-7", candidateId: "c1" },
    // c4's bare hand-push is seen BEFORE the folder placement that knows the area — the aggregator must
    // still end up with the area, not the first null.
    { managerHrId: "nsm-1", candidateId: "c4" },
    { managerHrId: "nsm-1", candidateId: "c4", area: "Cairo Downtown" },
    // A candidate whose row is gone — no candidateInfo entry. Still received; never "answered". No
    // folder, so it groups under "Sent directly" (area null).
    { managerHrId: "nsm-1", candidateId: "c6" },
    // A CV stranded on a RESIGNED manager who holds no folder — visible only because it was pushed.
    { managerHrId: "pd-9", candidateId: "c5" },
  ];

  const managerMeta = new Map<string, EngagementManagerMeta>([
    meta({ managerHrId: "Dm-7", name: "Dina", area: "Delta (1)", line: "Anti Infective" }),
    meta({ managerHrId: "nsm-1", name: "Nabil", jobTitle: "National Sales Manager", area: "Egypt", line: "Pedia" }),
    meta({
      managerHrId: "pd-9",
      name: "Ahmed",
      area: "Cairo",
      line: "Pedia",
      inactive: true,
      employmentStatusLabel: "Resigned",
      lastWorkingDate: "2026-08-20",
    }),
  ]);

  const candidateInfo = new Map<string, { name: string | null; status: string | null; arrivedAt: string | null }>([
    ["c1", { name: "Aya", status: "shortlisted", arrivedAt: "2026-08-01" }], // answered (a decision)
    ["c2", { name: "Basma", status: "new", arrivedAt: "2026-08-05" }], // waiting
    ["c3", { name: "Carim", status: "sent_to_manager", arrivedAt: "2026-08-10" }], // waiting (on the manager)
    ["c4", { name: "Doha", status: "rejected", arrivedAt: "2026-08-03" }], // answered (a decision)
    ["c5", { name: "Emad", status: "hired", arrivedAt: "2026-08-02" }], // answered (a decision)
    // c6 deliberately absent
  ]);

  // Dina opened c1 and c3. The SCREENER B-10 opened c4 — that view must NOT count as Nabil opening
  // it, because the manager who never opened it must keep reading as not-opened.
  const openedKeys = new Set<string>([
    `${engagementHrKey("Dm-7")}::c1`,
    `${engagementHrKey("Dm-7")}::c3`,
    `${engagementHrKey("B-10")}::c4`,
  ]);

  const report = aggregateManagerCvEngagement({ memberships, managerMeta, candidateInfo, openedKeys, scoped: true });

  assert.equal(report.scoped, true, "the scoped flag passes through untouched");
  assert.equal(report.rows.length, 3, "three distinct managers");

  // Sorted by most CVs received first: Dina (3) before Nabil (2) before Ahmed (1).
  const [dina, nabil, ahmed] = report.rows;
  assert.equal(dina.managerName, "Dina");
  assert.equal(nabil.managerName, "Nabil");
  assert.equal(ahmed.managerName, "Ahmed");

  // Dina: c1, c2, c3 (the duplicate c1 collapsed). Opened c1 + c3. Answered c1 only.
  assert.equal(dina.received, 3, "the duplicate membership is deduped to one CV");
  assert.equal(dina.opened, 2);
  assert.equal(dina.notOpened, 1);
  assert.equal(dina.answered, 1);
  assert.equal(dina.candidates.length, 3);
  // Manager facts pass through: the LINE is shown, not the region twice, and it is not the HR prefix.
  assert.equal(dina.managerArea, "Delta (1)");
  assert.equal(dina.managerLine, "Anti Infective", "Dina's line comes from the directory, not her b- prefix");
  assert.equal(dina.inactive, false);
  // Newest CV first inside the manager (by arrival date).
  assert.equal(dina.candidates[0].candidateId, "c3", "candidates sorted newest-first by arrivedAt");
  // Each CV carries the area it was filed under, for the grouped expanded list. The duplicate c1
  // (folder + area-less push) keeps the folder's area rather than being blanked by the push.
  assert.equal(dina.candidates.find((entry) => entry.candidateId === "c1")?.area, "Nasr City", "the folder area survives an area-less duplicate push");
  assert.equal(dina.candidates.find((entry) => entry.candidateId === "c2")?.area, "No area named");

  // Nabil: c4 (rejected, viewed only by the screener → not opened) + c6 (no row → not answered).
  assert.equal(nabil.received, 2);
  assert.equal(nabil.opened, 0, "a view by someone other than the manager never marks HIS open");
  assert.equal(nabil.notOpened, 2);
  assert.equal(nabil.answered, 1, "c4 is answered (rejected); c6 with an unknown status is NOT answered");
  // c4's area was unknown on its first (push) membership and filled by the later folder one.
  assert.equal(
    nabil.candidates.find((entry) => entry.candidateId === "c4")?.area,
    "Cairo Downtown",
    "an area-less first membership is upgraded when a later one knows the area",
  );
  // c6 reached him by push alone — no folder, so no area, and it groups under "Sent directly".
  assert.equal(nabil.candidates.find((entry) => entry.candidateId === "c6")?.area, null, "a hand-push with no folder carries no area");

  // Ahmed: a resigned manager still holding one stranded CV, flagged so the reader knows why it sits.
  assert.equal(ahmed.received, 1);
  assert.equal(ahmed.answered, 1, "c5 is hired");
  assert.equal(ahmed.inactive, true, "a resigned manager is flagged, not hidden");
  assert.equal(ahmed.employmentStatusLabel, "Resigned");
  assert.equal(ahmed.lastWorkingDate, "2026-08-20");
  assert.equal(ahmed.candidates[0]?.area, null, "a CV pushed to a resigned manager has no folder area");

  assert.deepEqual(report.totals, { managers: 3, received: 6, opened: 2, notOpened: 4, answered: 3 });

  // ── An empty input is an empty report, not a throw ──────────────────────────────────────────
  const empty = aggregateManagerCvEngagement({
    memberships: [],
    managerMeta: new Map(),
    candidateInfo: new Map(),
    openedKeys: new Set(),
    scoped: false,
  });
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.totals, { managers: 0, received: 0, opened: 0, notOpened: 0, answered: 0 });
  assert.equal(empty.scoped, false);

  // ── The loader scopes NSMs and lets Super Admin/CEO see all (source-level guard) ─────────────
  // The counting above is pure and fully tested; the SCOPE decision lives in the DB loader, so pin
  // it by source the way recruitment-nsm-rm-ceo-scoping does for its own resolver.
  const domainSource = read("src/lib/recruitment/manager-cv-engagement.ts");
  assert.match(
    domainSource,
    /canSeeAllRecruitment\(access\)\s*\?\s*null\s*:\s*await\s+resolveHiringManagerScopeHrIds\(access\)/,
    "loadManagerCvEngagement must see-all for Super Admin/CEO and LINE-scope a National Sales Manager",
  );
  // RECEIVED is the whole folder, not just the hand-offs — the loader must read the folder placement
  // (the same rule that fills My Candidates) AND both hand-push routes, then union them.
  assert.match(domainSource, /loadAllDistrictBoards/, "received must include the manager's district folder");
  assert.match(domainSource, /manager_notified_hr_id/, "received must include the original single-push route");
  assert.match(domainSource, /MANAGER_SENDS_TABLE/, "received must include the multi-manager send trail");
  // The LINE comes from the directory's line_id, never the HR-id prefix (which is stale — Dina is b-*
  // yet Anti Infective), resolved through the lines table.
  assert.match(domainSource, /line_id/, "the manager's line must be read from the directory, not the HR prefix");
  // Missing-table codes are treated as "not migrated yet" so the page degrades instead of 500ing.
  assert.match(domainSource, /PGRST205/, "the loader must treat a missing relation as not-migrated-yet");
  // Route 1 stamps each folder membership with the folder's area — what the expanded list groups by.
  assert.match(domainSource, /area:\s*folder\.areaName/, "the folder route must carry the folder area onto the membership");

  // ── The report's own CV preview is SILENT ─────────────────────────────────────────────────────
  // Opening a CV from this oversight report must never record an "opened" mark — that would let an NSM
  // inflate the very number the report measures. The preview reaches the raw file primitives, never
  // the hiring-manager download that records.
  assert.match(domainSource, /export async function listManagerEngagementCandidateFiles/, "the report has its own file-list function");
  assert.match(domainSource, /export async function getManagerEngagementCandidateFile/, "the report has its own file-download function");
  assert.match(domainSource, /getFileForDownload/, "the preview reads bytes through the silent primitive");

  const previewListRoute = read("app/api/recruitment/manager-engagement/candidates/[candidateId]/files/route.ts");
  const previewFileRoute = read("app/api/recruitment/manager-engagement/candidates/[candidateId]/files/[fileId]/route.ts");
  assert.match(previewListRoute, /canViewManagerCvEngagement/, "the preview list route is gated on the report's own audience");
  assert.match(previewFileRoute, /canViewManagerCvEngagement/, "the preview download route is gated on the report's own audience");
  assert.doesNotMatch(
    previewFileRoute,
    /recordManagerCvOpen|downloadHiringManagerCandidateFile/,
    "the preview download route must record no open",
  );

  // ── The open signal is recorded SILENTLY and best-effort at the one download chokepoint ──────
  const downloadSource = read("src/lib/recruitment/hiring-manager-view.ts");
  assert.match(
    downloadSource,
    /recordManagerCvOpen\(\{\s*candidateId,\s*viewerHrId:\s*access\.hrId\s*\}\)/,
    "downloadHiringManagerCandidateFile must record the manager's own open",
  );
  // Wrapped so a tracking write can never break a CV opening.
  assert.match(
    downloadSource,
    /try\s*\{\s*await\s+recordManagerCvOpen\([\s\S]*?\}\s*catch\s*\{/,
    "the open-recording must be wrapped in try/catch — a CV must open even if the write fails",
  );
}
