import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { IN_APP_ONLY_CHANNELS, resolveInAppOnlyAudience } from "../src/lib/conversations/notify.ts";
import { activeAdministratorHrIds } from "../src/lib/recruitment/candidate-comment-administrators.ts";
import {
  adminCandidateHref,
  adminTwinOfPortalCandidatesHref,
  CANDIDATE_LINK_PARAM,
  parseCandidatePageId,
  PORTAL_CANDIDATES_PATH,
  portalCandidatesHref,
} from "../src/lib/recruitment/candidate-page-link.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A comment on a candidate — the link it carries, and who is told in the app.
//
// The owner, 2026-09-19, on a "New comment on candidate" notice that reached him as a Telegram copy
// of the email: pressing the link opened the employee portal and then dropped him in the command
// center, and "I want the comments to come in in-app notifications."
//
//   1. The link names the candidate (`?candidate=<id>`), so the page it opens can act on it.
//   2. The portal's "My Candidates" page no longer answers an admin-shell viewer with /overview: the
//      Super Admin and HR Advisory land on that candidate's own page, the CEO on his own inbox.
//   3. The Super Admin is told in the app — and ONLY in the app. Who receives an email is the owner's
//      decision, so the Super Admin is never added to the email's To or CC. Asked who else should get
//      the copy, the owner answered the Super Admin, not HR Advisory.
//   4. A comment the Super Admin wrote is not told back to them.
// ─────────────────────────────────────────────────────────────────────────────

const CANDIDATE_ID = "6f0b1c7e-2d44-4a8e-9b53-0c1d2e3f4a5b";
const ADMIN_PAGE = `/recruitment/candidate/${CANDIDATE_ID}`;

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

export function runCandidateCommentLinksAndInAppTests() {
  // ── 1 · The link names the candidate ─────────────────────────────────────────────────────────
  assert.equal(
    PORTAL_CANDIDATES_PATH,
    "/employee-portals/recruitment-candidates",
    "the manager's own list is where every CV notice points — the address is not this change's to move",
  );
  assert.equal(CANDIDATE_LINK_PARAM, "candidate");
  assert.equal(
    portalCandidatesHref(CANDIDATE_ID),
    `${PORTAL_CANDIDATES_PATH}?candidate=${CANDIDATE_ID}`,
    "a comment's link must say WHICH candidate it is about",
  );
  assert.equal(
    portalCandidatesHref(CANDIDATE_ID.toUpperCase()),
    `${PORTAL_CANDIDATES_PATH}?candidate=${CANDIDATE_ID}`,
    "the id is lower-cased, the form the database stores it in",
  );
  for (const notACandidate of [null, undefined, "", "not-a-uuid", `${CANDIDATE_ID}&admin=1`, "../../etc/passwd"]) {
    assert.equal(
      portalCandidatesHref(notACandidate),
      PORTAL_CANDIDATES_PATH,
      `${JSON.stringify(notACandidate)} is not a candidate id — the link stays the bare list, which still opens`,
    );
  }

  // The round trip: what the sender builds is what the receiving page reads back.
  const link = new URL(portalCandidatesHref(CANDIDATE_ID), "https://phoenix.example");
  assert.equal(link.pathname, PORTAL_CANDIDATES_PATH);
  assert.equal(
    parseCandidatePageId(link.searchParams.get(CANDIDATE_LINK_PARAM)),
    CANDIDATE_ID,
    "the page must be able to read the candidate back out of the link the notice carries",
  );

  assert.equal(adminCandidateHref(CANDIDATE_ID), ADMIN_PAGE);
  assert.equal(adminCandidateHref(undefined), "/recruitment", "no candidate to name — the recruitment hub, never a broken page");
  assert.equal(adminCandidateHref("garbage"), "/recruitment");

  // ── 2 · An admin-shell viewer is sent to the admin twin, not the command center ──────────────
  const desk = { canOpenPersonalInbox: false, canOpenRecruitment: true };
  assert.equal(
    adminTwinOfPortalCandidatesHref({ ...desk, candidateId: CANDIDATE_ID }),
    ADMIN_PAGE,
    "Super Admin / HR Advisory pressing the link land on the candidate — the bounce to /overview was the bug",
  );
  assert.equal(adminTwinOfPortalCandidatesHref({ ...desk, candidateId: [CANDIDATE_ID, "second"] }), ADMIN_PAGE);
  assert.equal(adminTwinOfPortalCandidatesHref({ ...desk, candidateId: undefined }), "/recruitment");
  assert.equal(
    adminTwinOfPortalCandidatesHref({ ...desk, candidateId: "not-a-uuid" }),
    "/recruitment",
    "an edited or cut-off link goes to the hub, not to a candidate page that would say 'not found'",
  );
  assert.equal(
    adminTwinOfPortalCandidatesHref({ canOpenPersonalInbox: true, canOpenRecruitment: true, candidateId: CANDIDATE_ID }),
    ADMIN_PAGE,
    "somebody who can open both gets the candidate — it carries the notes and the history",
  );
  assert.equal(
    adminTwinOfPortalCandidatesHref({ canOpenPersonalInbox: true, canOpenRecruitment: false, candidateId: CANDIDATE_ID }),
    `/recruitment/candidates?${CANDIDATE_LINK_PARAM}=${CANDIDATE_ID}`,
    "the CEO cannot open the recruitment pages, but has his own inbox — the admin twin of this very list, opened on that CV",
  );
  assert.equal(
    adminTwinOfPortalCandidatesHref({ canOpenPersonalInbox: true, canOpenRecruitment: false, candidateId: "not-a-uuid" }),
    "/recruitment/candidates",
    "a cut-off id still opens his list, without a candidate the page would refuse",
  );
  assert.equal(
    adminTwinOfPortalCandidatesHref({ canOpenPersonalInbox: false, canOpenRecruitment: false, candidateId: CANDIDATE_ID }),
    null,
    "no admin twin for this viewer — the page keeps its old /overview rather than forwarding to a refusal",
  );

  // The page itself: it must actually use that decision, read the address, and keep the old landing
  // as the last resort. `navigation-granted-but-unreachable` reads the literal /overview after the
  // shell gate, so it must stay a literal.
  const portalPage = read("app/employee-portals/recruitment-candidates/page.tsx");
  assert.match(
    portalPage,
    /resolveNavigationMode\(access\) !== "employee-portal"\) \{[\s\S]*?adminTwinOfPortalCandidatesHref\(\{[\s\S]*?candidateId: params\[CANDIDATE_LINK_PARAM\],[\s\S]*?\}\);\s*if \(adminTwin\) redirect\(adminTwin\);\s*redirect\("\/overview"\);\s*\}/,
    "the portal page must forward an admin-shell viewer to the admin twin and keep a literal /overview as the last resort",
  );
  assert.match(portalPage, /searchParams: Promise<Record<string, string \| string\[\] \| undefined>>/);
  assert.match(portalPage, /await searchParams/, "the candidate named in the link is read off the address");
  assert.doesNotMatch(
    portalPage,
    /resolveNavigationMode\(access\) !== "employee-portal"\) \{\s*redirect\("\/overview"\);/,
    "an admin-shell viewer must not be answered with a bare /overview any more",
  );

  // ── 3 · The Super Admin is told in the app, and only in the app ──────────────────────────────
  assert.deepEqual([...IN_APP_ONLY_CHANNELS], ["in_app"], "the administrators' copy is in-app and nothing else");

  // The addressing: never the author, never anybody the email already reaches, once each, spelt as
  // given so the row is stored in the form the database uses.
  assert.deepEqual(
    resolveInAppOnlyAudience({
      addressed: ["B-155", "A-8"],
      authorHrId: "B-10",
      hrIds: ["B-10", "b-155", "B-20", "b-20", "B-30", null, undefined, "  ", "a-8"],
    }),
    ["B-20", "B-30"],
    "the author and everyone the thread already reaches are skipped, duplicates collapse, blanks fall away",
  );
  assert.deepEqual(
    resolveInAppOnlyAudience({ addressed: [], authorHrId: null, hrIds: ["b-20", "B-20"] }),
    ["b-20"],
    "first spelling wins",
  );
  assert.deepEqual(resolveInAppOnlyAudience({ addressed: [], authorHrId: "B-10", hrIds: [] }), []);

  const notify = read("src/lib/conversations/notify.ts");
  const inAppBlock = /const inAppOnlySends = inAppOnlyKeys\.map[\s\S]*?\n {4}\}\)\);/.exec(notify)?.[0] ?? "";
  assert.ok(inAppBlock.length > 0, "the in-app-only send must exist in notifyConversationMessage");
  assert.match(inAppBlock, /channels: \[\.\.\.IN_APP_ONLY_CHANNELS\]/, "the administrators' send takes its channels from the pinned list");
  assert.doesNotMatch(
    inAppBlock,
    /"email"|"telegram"|"push"|\bemail:/,
    "the administrators' copy must never carry an email envelope, a Telegram send or a push — who is emailed is the owner's call",
  );
  assert.match(
    notify,
    /if \(notifyKeys\.length === 0 && ccKeys\.length === 0 && inAppOnlyKeys\.length === 0\) return;/,
    "a comment with nobody in its thread must still reach the Super Admin",
  );

  // Who the copy goes to: the active accounts with an HR id, once each, in display form.
  assert.deepEqual(
    activeAdministratorHrIds([
      { hr_id: "b-10", is_active: true },
      { hr_id: "B-10", is_active: true },
      { hr_id: "C-77", is_active: null },
      { hr_id: "D-5", is_active: false },
      { hr_id: null, is_active: true },
      { hr_id: "", is_active: true },
      { is_active: true },
    ]),
    ["B-10", "C-77"],
    "active accounts only, in display form, once each — a deactivated account and the HR-id-less canary are skipped",
  );
  assert.deepEqual(activeAdministratorHrIds([]), []);

  // And that a comment the Super Admin wrote is not told back to them: the notifier's own addressing.
  assert.deepEqual(
    resolveInAppOnlyAudience({ addressed: [], authorHrId: "b-10", hrIds: ["B-10"] }),
    [],
    "the only administrator writing a comment has nobody left to tell — compared by canonical key, not spelling",
  );
  assert.deepEqual(resolveInAppOnlyAudience({ addressed: [], authorHrId: "D-99", hrIds: ["B-10"] }), ["B-10"]);

  const comments = read("src/lib/recruitment/candidate-comments.ts");
  assert.match(
    comments,
    /actionUrl: portalCandidatesHref\(input\.candidateId\),/,
    "the thread's link must name the candidate",
  );
  assert.match(
    comments,
    /inAppOnly: \{ actionUrl: adminCandidateHref\(input\.candidateId\), hrIds: administrators \},/,
    "the administrators must be handed to the notifier as the in-app-only audience, on the candidate's admin page",
  );
  assert.match(
    comments,
    /const administrators = resolveInAppOnlyAudience\(\{\s*addressed: \[\],\s*authorHrId: input\.authorHrId,\s*hrIds: await administratorHrIds\(\),\s*\}\);/,
    "the author is taken out of the administrators' copy before the early return reads how many are left",
  );
  assert.match(
    comments,
    /participantHrIds,\s*\n\s*recordId: input\.candidateId,/,
    "the administrators must NOT be added to participantHrIds — that list is the email's CC line",
  );
  assert.match(
    comments,
    /\.in\("role", \[\.\.\.systemAdministratorRoles\]\)/,
    "the copy goes to the Super Admin by the app's own administrator role list",
  );
  assert.doesNotMatch(
    comments,
    /recruitmentManageRoles|HR_SEAT_ROLES/,
    "HR Advisory is not on the copy — the owner answered the Super Admin only",
  );
  assert.doesNotMatch(
    comments,
    /"Super Admin"|"HR Advisory"|"HR Operations"/,
    "no role written out by name in this file — the role comes from systemAdministratorRoles",
  );
  assert.match(
    comments,
    /candidate_comment_administrators_failed/,
    "a failed lookup logs and falls back to nobody, so the thread's own notice still goes",
  );
  assert.doesNotMatch(
    comments,
    /"\/employee-portals\/recruitment-candidates"/,
    "the bare literal is gone — the link is built by portalCandidatesHref so it always names the candidate",
  );
}
