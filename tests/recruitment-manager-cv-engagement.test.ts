import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  aggregateManagerCvEngagement,
  canViewManagerCvEngagement,
  engagementHrKey,
  type EngagementSendInput,
} from "../src/lib/recruitment/manager-cv-engagement.ts";

function read(relativePath: string): string {
  return readFileSync(relativePath, "utf8");
}

function send(over: Partial<EngagementSendInput> & { candidateId: string; managerHrId: string }): EngagementSendInput {
  return {
    candidateId: over.candidateId,
    managerHrId: over.managerHrId,
    managerName: over.managerName ?? "A Manager",
    managerJobTitle: over.managerJobTitle ?? "District Manager",
    managerArea: over.managerArea ?? "GZ3",
    managerRegion: over.managerRegion ?? "Giza",
    sentAt: over.sentAt ?? "2026-08-01",
    positionLabel: over.positionLabel ?? null,
  };
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
  // elsewhere. A send stored lower ("dm-7") and a view stored upper ("DM-7") must land on one key.
  assert.equal(engagementHrKey("Dm-7"), engagementHrKey("DM-7"));
  assert.equal(engagementHrKey("dm-7"), "DM-7");
  assert.equal(engagementHrKey(""), null);
  assert.equal(engagementHrKey(null), null);

  // ── The aggregator: counts, dedup, open-attribution, answered, sorting ──────────────────────
  const sends: EngagementSendInput[] = [
    send({ candidateId: "c1", managerHrId: "Dm-7", managerName: "Dina", sentAt: "2026-08-01" }),
    send({ candidateId: "c2", managerHrId: "Dm-7", managerName: "Dina", sentAt: "2026-08-05" }),
    send({ candidateId: "c3", managerHrId: "Dm-7", managerName: "Dina", sentAt: "2026-08-10" }),
    // The SAME CV sent to the SAME manager twice — a legacy row plus a re-send. Must count once.
    send({ candidateId: "c1", managerHrId: "Dm-7", managerName: "Dina", sentAt: "2026-08-02" }),
    send({ candidateId: "c4", managerHrId: "nsm-1", managerName: "Nabil", managerJobTitle: "National Sales Manager", sentAt: "2026-08-03" }),
    // A candidate whose row is gone — no candidateInfo entry. Still received; never "answered".
    send({ candidateId: "c6", managerHrId: "nsm-1", managerName: "Nabil", managerJobTitle: "National Sales Manager", sentAt: "2026-08-04" }),
  ];

  const candidateInfo = new Map<string, { name: string | null; status: string | null }>([
    ["c1", { name: "Aya", status: "shortlisted" }], // answered (a decision)
    ["c2", { name: "Basma", status: "new" }], // waiting
    ["c3", { name: "Carim", status: "sent_to_manager" }], // waiting (on the manager)
    ["c4", { name: "Doha", status: "rejected" }], // answered (a decision)
    // c6 deliberately absent
  ]);

  // Dina opened c1 and c3. The SCREENER B-10 opened c4 — that view must NOT count as Nabil opening
  // it, because the manager who never opened it must keep reading as not-opened.
  const openedKeys = new Set<string>([
    `${engagementHrKey("Dm-7")}::c1`,
    `${engagementHrKey("Dm-7")}::c3`,
    `${engagementHrKey("B-10")}::c4`,
  ]);

  const report = aggregateManagerCvEngagement({ sends, candidateInfo, openedKeys, scoped: true });

  assert.equal(report.scoped, true, "the scoped flag passes through untouched");
  assert.equal(report.rows.length, 2, "two distinct managers");

  // Sorted by most CVs received first: Dina (3) before Nabil (2).
  const [dina, nabil] = report.rows;
  assert.equal(dina.managerName, "Dina");
  assert.equal(nabil.managerName, "Nabil");

  // Dina: c1, c2, c3 (the duplicate c1 collapsed). Opened c1 + c3. Answered c1 only.
  assert.equal(dina.received, 3, "the duplicate send is deduped to one CV");
  assert.equal(dina.opened, 2);
  assert.equal(dina.notOpened, 1);
  assert.equal(dina.answered, 1);
  assert.equal(dina.candidates.length, 3);
  // Newest CV first inside the manager.
  assert.equal(dina.candidates[0].candidateId, "c3", "candidates sorted newest-first by sentAt");

  // Nabil: c4 (rejected, viewed only by the screener → not opened) + c6 (no row → not answered).
  assert.equal(nabil.received, 2);
  assert.equal(nabil.opened, 0, "a view by someone other than the manager never marks HIS open");
  assert.equal(nabil.notOpened, 2);
  assert.equal(nabil.answered, 1, "c4 is answered (rejected); c6 with an unknown status is NOT answered");

  assert.deepEqual(report.totals, { managers: 2, received: 5, opened: 2, notOpened: 3, answered: 2 });

  // ── An empty input is an empty report, not a throw ──────────────────────────────────────────
  const empty = aggregateManagerCvEngagement({ sends: [], candidateInfo: new Map(), openedKeys: new Set(), scoped: false });
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
  // Missing-table codes are treated as "not migrated yet" so the page degrades instead of 500ing.
  assert.match(domainSource, /PGRST205/, "the loader must treat a missing relation as not-migrated-yet");

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
