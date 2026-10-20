import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDailyCvDigest,
  dailyCvDigestMessage,
  dailyCvDigestPlaceLine,
  digestRowsVisibleTo,
  type DailyCvDigestSourceRow,
} from "../src/lib/recruitment/inbound/daily-cv-digest.ts";
import { strandedEscalationHref, STALE_SEND_TA_ACTION_URL } from "../src/lib/recruitment/stale-send-check.ts";
import { TRIAGE_BACKLOG_ACTION_URL } from "../src/lib/recruitment/triage-backlog-check.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The day's CVs by the workspace's own tabs and places, and every notice landing on the filtered
// workspace (owner's plan, Phase 4, 20 Oct 2026).
//
// "Medical Rep · Smouha: 2 new, 1 incomplete" — the tab and place the applicant's OWN replies filed
// them in, never the CV-read "Applying for". Talent Acquisition's figures are fenced: an HR applicant
// (her manager's seat or her own) is never counted for her, and never named to her in a per-CV alert.
// The links open the workspace on the pile the number counts.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = "2026-10-20";
const AT = "2026-10-20T09:00:00.000Z"; // 12:00 Cairo

function row(id: string, overrides: Partial<DailyCvDigestSourceRow> = {}): DailyCvDigestSourceRow {
  return {
    createdAt: AT,
    declaredRoleFamily: null,
    id,
    missingAnswerKeys: [],
    placements: [],
    source: "whatsapp",
    status: "new",
    ...overrides,
  };
}

const smouha = { areaCode: "AB2", areaName: "Smouha", regionCode: "AB", tab: "medical_rep" as const };

const ROWS: DailyCvDigestSourceRow[] = [
  row("rep-1", { placements: [smouha] }),
  row("rep-2", { missingAnswerKeys: ["salary"], placements: [smouha] }),
  // Filed in two tabs: counted in both.
  row("both", { placements: [{ ...smouha }, { regionCode: "CA", tab: "district_manager" }] }),
  row("hrsh", { declaredRoleFamily: "hr_section_head", placements: [{ tab: "hr_section_head" }] }),
  row("ta", { declaredRoleFamily: "talent_acquisition", placements: [{ tab: "talent_acquisition" }] }),
  // The retired Human Resources tap: not filed (no tab is a safe guess), still an HR applicant.
  row("old-hr", { declaredRoleFamily: "human_resources", placements: [] }),
  row("nobody", { placements: [] }),
  // Yesterday: never in today's numbers.
  row("yesterday", { createdAt: "2026-10-19T09:00:00.000Z", placements: [smouha] }),
];

function flat(file: string): string {
  return stripComments(readFileSync(file, "utf8")).replace(/\s+/g, " ");
}

export function runRecruitmentDigestByTabTests(): void {
  // ── 1 · By tab and place, in the owner's tab order, Needs placing last ───────────────────────
  const everyone = buildDailyCvDigest(ROWS, DAY);
  assert.equal(everyone.total, 7, "yesterday's CV is not today's");
  assert.deepEqual(
    everyone.byPlace.map((place) => [place.label, place.count, place.incomplete]),
    [
      ["Medical Rep · Smouha", 3, 1],
      ["District Manager · Cairo", 1, 0],
      ["HR Section Head", 1, 0],
      ["Talent Acquisition", 1, 0],
      ["Needs placing", 2, 0],
    ],
    "RED the owner's tab order; the AU area's own name, else the region's, else the tab alone",
  );
  const rep = everyone.byPlace[0];
  assert.deepEqual([rep.tab, rep.region, rep.area], ["medical_rep", "AB", "AB2"], "the line carries what its workspace link needs");
  assert.equal(dailyCvDigestPlaceLine(rep), "Medical Rep · Smouha: 3 new, 1 incomplete", "the owner's own example line");
  assert.equal(dailyCvDigestPlaceLine(everyone.byPlace[1]), "District Manager · Cairo: 1 new", "no '0 incomplete' noise");
  assert.ok(
    everyone.byPlace.reduce((sum, place) => sum + place.count, 0) >= everyone.total,
    "a person in two tabs counts in both — never fewer than the day",
  );
  const message = dailyCvDigestMessage(everyone);
  assert.match(message, /By tab and place:\n- Medical Rep · Smouha: 3 new, 1 incomplete\n/);
  assert.ok(!/Applying for|Role not stated/.test(message), "RED the CV-read role is gone from the summary");

  // ── 2 · The Talent Acquisition fence, by person, even as a number ────────────────────────────
  const hers = buildDailyCvDigest(digestRowsVisibleTo(ROWS, true), DAY);
  assert.equal(hers.total, 4, "RED the three HR applicants are not counted for her");
  assert.ok(
    !hers.byPlace.some((place) => place.tab === "hr_section_head" || place.tab === "talent_acquisition"),
    "her manager's tab and her own never appear on her panel",
  );
  assert.deepEqual(
    hers.byPlace.find((place) => place.tab === "needs_placing")?.count,
    1,
    "RED an unfiled applicant who tapped the retired Human Resources row is still an HR applicant",
  );
  assert.equal(digestRowsVisibleTo(ROWS, false).length, ROWS.length, "the unfenced digest (the Super Admin's 18:00 notice) counts everyone");

  const overview = flat("src/lib/hr/talent-acquisition-overview.ts");
  assert.match(
    overview,
    /buildTodaysCvDigest\(now, \{ hideHrPeople: workspaceViewer\(access\)\.hidesHrPeople \}\)/,
    "RED her panel asks the fence from her own seat",
  );

  const notify = flat("src/lib/recruitment/inbound/recruitment-notify.ts");
  assert.match(
    notify,
    /candidateHiddenFrom\( \{ role: "HR Resourcing", scope: "company" \}, input\.candidateId, \)\.catch\(\(\) => true\)/,
    "RED the per-CV alert asks the fence, and a check that cannot answer leaves her off (fail closed)",
  );
  assert.match(
    notify,
    /hiddenFromTalentAcquisition \? await hrIdsForRoles\(recruitmentDeskAlertRoles\) : await hrIdsForRoles\(recruitmentAlertRoles\)/,
    "a hidden person goes to the desk alone — the alert list without her",
  );
  assert.match(notify, /actionUrl: workspaceCandidateHref\(input\.candidateId\)/, "a new-CV alert opens that CV");
  assert.match(notify, /actionUrl: workspaceHref\(\{ datePick: "today" \}\)/, "the 18:00 digest opens today's arrivals");

  const arrivals = flat("src/components/hr/talent-acquisition/cv-arrivals.tsx");
  assert.match(
    arrivals,
    /workspaceHref\( \{ area: place\.area, datePick: "today", region: place\.region, tab: place\.tab \}, \{ basePath: HR_WORKSPACE_BASE_PATH \}, \)/,
    "each line on her panel opens its own tab, place and day",
  );

  // ── 3 · Every notice lands on the pile it counts ─────────────────────────────────────────────
  const read = (href: string) => new URL(href, "https://phoenix.test");
  const allSilent = read(strandedEscalationHref([{ reason: "no_answer" }, { reason: "no_answer" }]));
  assert.equal(allSilent.pathname, "/recruitment");
  assert.equal(allSilent.searchParams.get("status"), "sent_to_manager");
  assert.equal(allSilent.searchParams.get("overdue"), "1", "RED every send a manager is ignoring is exactly the overdue filter");

  const mixed = read(strandedEscalationHref([{ reason: "no_answer" }, { reason: "manager_cannot_answer" }]));
  assert.equal(mixed.searchParams.get("status"), "sent_to_manager");
  assert.equal(
    mixed.searchParams.get("overdue"),
    null,
    "RED a send stranded because the manager can no longer answer may be younger than overdue — the filter must not hide it",
  );
  assert.equal(read(strandedEscalationHref([])).searchParams.get("overdue"), null);
  assert.equal(STALE_SEND_TA_ACTION_URL, "/recruitment", "the manager-hold return still lands on the workspace root");

  assert.equal(TRIAGE_BACKLOG_ACTION_URL, "/recruitment?status=new", "the triage backlog opens the New pile it counts");

  const staleSend = flat("src/lib/recruitment/stale-send-check.ts");
  assert.match(staleSend, /actionUrl: strandedHref,/, "the stranded escalation uses the filtered link");
  assert.match(staleSend, /ctaUrl: strandedHref/, "and so does its Telegram button");

  const center = flat("src/lib/hr/command-center.ts");
  assert.match(center, /workspaceHref\(\{ statuses: \["new"\] \}, \{ basePath: HR_WORKSPACE_BASE_PATH \}\)/, "Awaiting Review opens the New pile");
  assert.match(
    center,
    /workspaceHref\(\{ statuses: \["sent_to_manager"\] \}, \{ basePath: HR_WORKSPACE_BASE_PATH \}\)/,
    "With Hiring Managers opens the CVs with a manager",
  );
}
