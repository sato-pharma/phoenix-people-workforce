import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  hiringManagerDecisionStatus,
  hiringManagerDecisions,
  isHiringManagerDecision,
} from "../src/lib/recruitment/candidate-status.ts";
import {
  buildDailyCvDigest,
  dailyCvDigestMessage,
  dailyCvDigestTitle,
  isDailyCvDigestHour,
  isDailyCvDigestTime,
  inboundCvAlertReason,
  shouldAlertImmediatelyForInboundCv,
  type DailyCvDigestRow,
} from "../src/lib/recruitment/inbound/daily-cv-digest.ts";
import { isStatedNonEgyptian, nonEgyptianFlagTitle } from "../src/lib/recruitment/nationality.ts";
import {
  enforceRecruitmentCvEmailBlock,
  isRecruitmentCvReceivedEvent,
} from "../src/lib/notifications/recruitment-cv-channel-guard.ts";

/**
 * The recruitment module exists to do three things: receive the CV, let the AI read it, and put the
 * person in front of the District Manager who is hiring. This file pins the round trip that was
 * missing from the third one, plus the two screen rules and the alerting change that came with it.
 *
 * Measured against production on 2026-08-15, before any of this:
 *
 *   • A pushed candidate reached a manager's phone with a link to /employee-portals/cv-database,
 *     which answers a District Manager with "available to HR Advisory and Super Admin only".
 *     The entire flow ended on a locked door, for exactly the people it was built to reach.
 *   • A manager had no way to answer. 226 candidates, 1 interview ever.
 *   • 3 of the 10 candidates carrying a stated nationality were not Egyptian, against a standing
 *     Egyptian-nationals-only hiring rule that appeared nowhere on screen.
 *   • 628 "new CV" deliveries reached 3 HR Advisory reviewers in 30 days — one per CV.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function digestRow(overrides: Partial<DailyCvDigestRow> = {}): DailyCvDigestRow {
  return {
    // 09:00 UTC on 15 Aug is 12:00 in Cairo — comfortably inside the same Cairo day either side of
    // the DST boundary, so this fixture never depends on the offset in force.
    createdAt: "2026-08-15T09:00:00.000Z",
    missingAnswerKeys: [],
    // Filed by the applicant's own replies: Medical Rep, the Alex-BHR region, one AU area.
    placements: [{ areaCode: "AB2", areaName: "Smouha", regionCode: "AB", tab: "medical_rep" }],
    source: "email",
    status: "new",
    ...overrides,
  };
}

export async function runRecruitmentManagerInboxTests() {
  // ── 1 · The manager can SEE what was sent to them ───────────────────────────
  //
  // The push stamps manager_notified_hr_id with whatever the dropdown carried, and the caller
  // arrives with whatever their session carries. PostgREST `eq` is case-sensitive, so a bare
  // .eq() here matches nothing — and a filter matching nothing is indistinguishable from "nobody
  // sent you anything", which is the exact defect that made the manager dropdown itself empty
  // earlier the same day.
  const candidates = read("src/lib/recruitment/candidates.ts");
  assert.match(
    candidates,
    /export async function listCandidatesSentToManager/,
    "a manager needs a query that returns the people pushed straight to them",
  );
  // Re-cut 2026-08-30. This pin and the 42703 one below both measured a fixed DISTANCE through the
  // whole file, and both false-failed the moment listCandidatesSentToManager grew the comment
  // explaining why it now reads TWO sources. Distance was never the property. They now slice the
  // function body and assert the property itself, which is also strictly stronger: the old regex
  // would have been satisfied by an .eq() sitting anywhere else inside its 400-character window.
  const inboxStart = candidates.indexOf("export async function listCandidatesSentToManager");
  const inboxEnd = candidates.indexOf("\nexport ", inboxStart + 1);
  const inboxBody = candidates.slice(inboxStart, inboxEnd === -1 ? undefined : inboxEnd);
  assert.ok(
    inboxBody.includes("const keys = hrIdLookupKeys(managerHrId);"),
    "the HR_ID must go through hrIdLookupKeys — the ids in this database are mixed case",
  );
  assert.ok(
    inboxBody.includes('.in("manager_notified_hr_id", keys)'),
    "the HR_ID must be matched with .in() across every spelling, never as a single value",
  );
  assert.doesNotMatch(
    inboxBody,
    /\.eq\("manager_notified_hr_id"/,
    "a bare .eq() is case-sensitive and silently returns nothing — which reads to a manager as 'nobody sent you anything'",
  );
  assert.match(
    candidates,
    /\.order\("manager_notified_at", \{ ascending: false \}\)/,
    "newest send first, so the person named in the alert is at the top of the screen it links to",
  );
  // The pre-migration answer used to be `return []`. It cannot be any more: the function now reads a
  // second source, so a missing legacy column has to fall THROUGH to that source rather than abandon
  // the page — an empty list is the wrong answer when the send table has rows. What is pinned is the
  // half that still matters, that a missing column is tolerated and everything else is thrown.
  assert.match(
    inboxBody,
    /code\s*!==\s*"42703"\)\s*throw/,
    "the legacy column arrives in its own migration, so its absence must degrade, not 500 the page",
  );
  assert.doesNotMatch(
    inboxBody,
    /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    "nothing here may swallow an error — a manager silently shown an empty list is the exact invisibility this module exists to end",
  );

  // Reading the list is not enough: opening the CV goes through a different route with its own
  // scope check, and without this a manager could see a name and not the CV attached to it.
  const managerView = read("src/lib/recruitment/hiring-manager-view.ts");
  assert.match(
    managerView,
    /export async function isCandidateSentToCaller/,
    "the file-access scope must recognise a direct push, not only a requisition-based application",
  );
  assert.match(
    managerView,
    /assertCandidateInHiringManagerScope[\s\S]{0,300}?if \(await isCandidateSentToCaller\(access, candidateId\)\) return;/,
    "a candidate pushed to this caller is in scope for their own CV",
  );
  // Added 2026-08-30, and it closes a hole opened by the fan-out itself. Seeing a name in the list
  // and being allowed to open the CV are two different routes with two different checks, and this
  // one read ONLY manager_notified_hr_id — the column that holds the LAST manager. So the moment a
  // CV went to a second person, the first was refused the file while still seeing the name. Salim
  // Salim Abdo Ibrahim Gomaa is the live case: his send exists only in the send table, because the
  // column moved to Hany Saad Mohamed Omar 31 seconds after he got it.
  assert.match(
    managerView,
    /isCandidateSentToManager\(candidateId, access\.hrId\)/,
    "opening the CV must consult the send trail too — the candidate row names only the manager it went to LAST",
  );

  // ── 2 · The manager can ANSWER ──────────────────────────────────────────────
  //
  // Two answers, landing on the five statuses that already exist rather than inventing a sixth
  // that every filter, counter and stat card would have to be taught.
  assert.deepEqual(
    [...hiringManagerDecisions],
    ["interview", "not_interested"],
    "exactly two answers — a manager choosing from a longer list is how this stops being used",
  );
  assert.equal(hiringManagerDecisionStatus.interview, "shortlisted");
  assert.equal(hiringManagerDecisionStatus.not_interested, "rejected");
  assert.equal(isHiringManagerDecision("interview"), true);
  assert.equal(isHiringManagerDecision("shortlisted"), false, "a status is not a decision — the two vocabularies must not blur");
  assert.equal(isHiringManagerDecision(null), false);

  const decisionRoute = read("app/api/recruitment/hiring-manager/candidates/[candidateId]/decision/route.ts");
  // The permission resource is the whole reason a District Manager can reach any of this.
  // `candidates` is hard-boundary-locked to Super Admin / HR Advisory and can never be
  // granted to a DM — not scoped, not by override. `hiring_interviews` is the narrow resource that
  // exists for precisely this.
  assert.match(
    decisionRoute,
    /requireRecruitmentAccess\(request, "hiring_interviews", "update"\)/,
    "gated on hiring_interviews — `candidates:update` can never be granted to a District Manager",
  );
  assert.doesNotMatch(
    decisionRoute,
    /requireRecruitmentAccess\(request, "candidates"/,
    "if this ever asks for `candidates`, every District Manager loses the feature entirely",
  );
  // Permission alone is far too wide: holding hiring_interviews must not let a manager rule on
  // somebody else's candidate.
  assert.match(
    decisionRoute,
    /if \(!\(await isCandidateSentToCaller\(access, candidateId\)\)\)[\s\S]{0,300}?status: 403/,
    "the candidate must have been sent to THIS caller by name — permission is not scope",
  );
  assert.match(
    decisionRoute,
    /decision === "not_interested" && !note[\s\S]{0,200}?validationError\(/,
    "a refusal with no reason tells HR Advisory nothing, which defeats the point of asking",
  );

  // ── 3 · The alert points at a door the manager can open ─────────────────────
  const push = read("src/lib/recruitment/hiring-manager-notify.ts");
  assert.match(
    push,
    /actionUrl: "\/employee-portals\/recruitment-candidates"/,
    "the manager's own screen — the CV database answers a District Manager with a denial",
  );
  assert.doesNotMatch(
    push,
    /actionUrl: "\/employee-portals\/cv-database"/,
    "this link is what made the whole flow end on a locked door",
  );
  // And that screen has to actually load the pushes, or the link lands on an empty page.
  const portalPage = read("app/employee-portals/recruitment-candidates/page.tsx");
  assert.match(
    portalPage,
    /listCandidatesSentToManager\(access\.hrId\)/,
    "the destination page must load the direct pushes, not only requisition-based applications",
  );
  const adminMirror = read("app/(admin)/recruitment/candidates/page.tsx");
  assert.match(
    adminMirror,
    /listCandidatesSentToManager\(access\.hrId\)/,
    "the CEO's admin twin renders the same component and must feed it the same list",
  );

  // ── 4 · The Egyptian-nationals-only rule is visible ─────────────────────────
  //
  // Substring, not equality: a dual national holding Egyptian nationality IS an Egyptian national.
  assert.equal(isStatedNonEgyptian("Egyptian"), false);
  assert.equal(isStatedNonEgyptian("egyptian"), false, "matching must not depend on how the CV was capitalised");
  assert.equal(isStatedNonEgyptian("Egyptian Arab Republic"), false);
  assert.equal(isStatedNonEgyptian("Egyptian / British"), false, "a dual national holding Egyptian nationality is eligible");
  assert.equal(isStatedNonEgyptian("مصر"), false, "the Arabic spelling is the same answer");
  assert.equal(isStatedNonEgyptian("Pakistani"), true);
  assert.equal(isStatedNonEgyptian("Sudanese"), true);
  // The important half. 216 of the 226 production candidates state no nationality at all, so
  // treating blank as foreign would paint a warning on the whole pool and the flag would be dead
  // within a day.
  assert.equal(isStatedNonEgyptian(null), false);
  assert.equal(isStatedNonEgyptian(""), false);
  assert.equal(isStatedNonEgyptian("   "), false);
  assert.match(nonEgyptianFlagTitle("Pakistani"), /Pakistani/, "the hover text says what the CV actually claimed");

  const workspace = read("src/components/recruitment/recruitment-workspace.tsx");
  // Three places, because each is reached without the others: the desktop table, the mobile card,
  // and the profile — which is where Reject is actually pressed.
  const flagSites = workspace.match(/isStatedNonEgyptian\(/g) ?? [];
  assert.ok(
    flagSites.length >= 3,
    `the flag must appear on the desktop row, the mobile card and the profile header — found ${flagSites.length}`,
  );
  // It flags, it never rejects — the same rule the expense engine follows by the owner's decision.
  assert.doesNotMatch(
    workspace,
    /isStatedNonEgyptian\([^)]*\)\)\s*return false;/,
    "nothing may filter a candidate out of the pool on nationality — a human makes that call",
  );

  // ── 5 · The pool filters on pharma experience, three ways ───────────────────
  //
  // null is a real and common answer here (66 production rows) and means "the CV did not say",
  // which is not "no". A checkbox would quietly hide those people.
  //
  // The variable name changed on 2026-08-24, when the filter started reading the RESOLVED fact
  // instead of the raw column: 14 people have a medical-rep answer the CV reader hedged, so the
  // column is null while the row itself shows "Pharma rep", and a filter that disagrees with the
  // row it is filtering is the fault this rebuild exists to fix. The shape is what is pinned —
  // `typeof x === "boolean"`, never a `!== null` that would keep an undefined.
  assert.match(
    workspace,
    /experienceFilter === "unknown" && typeof [A-Za-z.]+ === "boolean"/,
    "unknown must test for the ABSENCE of a boolean — `!== null` wrongly keeps an undefined",
  );
  assert.match(
    workspace,
    /const pharma = candidateScreeningFacts\(c\)\.pharmaRep\?\.value \?\? null;/,
    "and it must read the same resolved fact the row shows, or it hides people the row calls pharma reps",
  );
  // Same reason as the branch above: the filter reads the resolved fact, so the variable is not
  // the raw column any more. The three branches must stay three, and "yes" must stay strict.
  assert.match(workspace, /experienceFilter === "yes" && [A-Za-z.]+ !== true/);
  assert.match(workspace, /experienceFilter === "no" && [A-Za-z.]+ !== false/);
  assert.match(
    workspace,
    /setExperienceFilter\("all"\)/,
    "Clear filters must clear this one too, or the pool silently keeps hiding people",
  );

  // ── 6 · One digest a day, not one alert per CV ──────────────────────────────
  const rows: DailyCvDigestRow[] = [
    digestRow(),
    digestRow({ missingAnswerKeys: ["salary"], status: "shortlisted" }),
    digestRow({ placements: [{ regionCode: "CA", tab: "district_manager" }], source: "whatsapp" }),
    // Nobody filed them — their replies named no role a tab holds.
    digestRow({ placements: [] }),
    // Yesterday in Cairo — must not be counted, and must not be silently included by an
    // off-by-one on the day boundary.
    digestRow({ createdAt: "2026-08-14T09:00:00.000Z" }),
    digestRow({ createdAt: null }),
    digestRow({ createdAt: "not a date" }),
  ];
  const digest = buildDailyCvDigest(rows, "2026-08-15");
  assert.equal(digest.total, 4, "only the four rows stamped on that Cairo day count");
  assert.equal(digest.awaitingReview, 3, "the shortlisted one has been looked at; the other three have not");
  assert.equal(digest.dayKey, "2026-08-15");
  // By the workspace's own tabs and the places the applicant's replies gave (owner's plan, 20 Oct
  // 2026) — never by the CV-read "Applying for", which a CV fills and which may never decide a tab.
  assert.deepEqual(
    digest.byPlace,
    [
      { area: "AB2", count: 2, incomplete: 1, label: "Medical Rep · Smouha", region: "AB", tab: "medical_rep" },
      { area: null, count: 1, incomplete: 0, label: "District Manager · Cairo", region: "CA", tab: "district_manager" },
      { area: null, count: 1, incomplete: 0, label: "Needs placing", region: null, tab: "needs_placing" },
    ],
    "RED the owner's tab order, the AU area's own name (or the region's), and nobody filed is Needs placing, never dropped",
  );
  assert.deepEqual(
    digest.bySource,
    [
      { count: 3, label: "Email" },
      { count: 1, label: "WhatsApp" },
    ],
    "the channel is shown the way a person writes it, never the raw stored code",
  );
  // The numbers under the total have to add up to it, or the digest is lying about the day.
  assert.equal(
    digest.byPlace.reduce((sum, group) => sum + group.count, 0),
    digest.total,
    "one tab each here, so the places add up to the day",
  );
  assert.equal(
    digest.bySource.reduce((sum, group) => sum + group.count, 0),
    digest.total,
  );

  const message = dailyCvDigestMessage(digest);
  assert.match(message, /3 of them are still waiting for a first look\./);
  assert.match(message, /Medical Rep · Smouha: 2 new, 1 incomplete/, "RED the owner's own example line");
  assert.match(message, /District Manager · Cairo: 1 new\n/, "no ', 0 incomplete' noise when nothing is missing");
  assert.match(message, /Needs placing: 1 new/);
  assert.doesNotMatch(message, /Applying for/, "the CV-read role is gone from the summary");
  assert.doesNotMatch(message, /…|\.\.\.|and \d+ (more|others)/, "the owner's rule: text is never truncated");
  assert.equal(dailyCvDigestTitle(digest), "4 CVs arrived today");
  assert.equal(dailyCvDigestTitle(buildDailyCvDigest([digestRow()], "2026-08-15")), "1 CV arrived today");

  // A quiet day sends nothing at all. Silence already means "nothing came in", and a daily "0 CVs"
  // push is exactly how a channel gets muted.
  const emptyDay = buildDailyCvDigest(rows, "2026-08-13");
  assert.equal(emptyDay.total, 0);
  assert.equal(dailyCvDigestMessage(emptyDay), "");
  const notify = read("src/lib/recruitment/inbound/recruitment-notify.ts");
  assert.match(
    notify,
    /export async function notifyDailyCvDigest[\s\S]{0,400}?if \(digest\.total === 0\) return;/,
    "an empty digest must not be sent",
  );

  // The per-CV flood stops for the FORWARDS, which is all it ever really was: 427 of the last 437
  // WhatsApp arrivals came off the owner's own handset. An applicant's CV is not the flood and is
  // alerted immediately — this assertion was inverted until 2026-08-30 and pinned the defect.
  assert.equal(
    shouldAlertImmediatelyForInboundCv({ bulkArrival: true, fileAttached: true }),
    false,
    "a forwarded CV is reported in the daily digest, not as its own alert",
  );
  assert.equal(
    shouldAlertImmediatelyForInboundCv({ fileAttached: true }),
    true,
    "but a CV a real applicant sent pages a human NOW — the digest is up to 24 hours away",
  );
  assert.equal(
    shouldAlertImmediatelyForInboundCv({ fileAttached: false }),
    true,
    "a candidate record with no CV behind it needs a human now — that is not routine arrival",
  );
  // no_file wins over bulkArrival: whoever forwarded it, a candidate with no CV needs repairing.
  assert.equal(inboundCvAlertReason({ bulkArrival: true, fileAttached: false }), "no_file");
  assert.equal(inboundCvAlertReason({ fileAttached: true }), "applicant");
  assert.equal(inboundCvAlertReason({ bulkArrival: true, fileAttached: true }), null);
  assert.match(
    notify,
    // The Talent Acquisition fence check (owner, 2026-10-20) sits between the gate and the lookup — a
    // database read too, so it must also come AFTER the gate.
    /const reason = inboundCvAlertReason\(input\);\s*\n\s*if \(!reason\) return;[\s\S]{0,700}?candidateHiddenFrom\([\s\S]{0,400}?hrIdsForRoles/,
    "the gate must come BEFORE the fence check and the recipient lookup — this runs on every single inbound CV",
  );
  // The two events share one notification, so neither may inherit the other's words. An applicant
  // being told their CV "could not be attached" is the failure this guards.
  assert.match(notify, /reason === "no_file"[\s\S]{0,400}?could not be attached/);
  assert.match(notify, /sent a CV on \$\{channelLabel\}/, "the arrival says the CV is ON FILE");

  // THE WIRING. A correct rule nobody calls is what made the owner say "the CV does not appear" —
  // the last two intake fixes were both a working handler that no branch reached. bulkArrival has
  // to survive three hops: worker -> ingestInboundCv -> notifyTalentAcquisitionOfInboundCv.
  const worker = read("src/lib/recruitment/inbound/intake-worker.ts");
  assert.match(
    worker,
    /const bulkArrival = isImport \|\| payload\.historical === true;/,
    "the worker derives bulkArrival from the forwarding handset AND the history replay",
  );
  const derived = worker.indexOf("const bulkArrival =");
  const ingested = worker.indexOf('ingestInboundCv({ channel: "whatsapp"');
  assert.ok(derived > 0 && ingested > derived, "and derives it BEFORE the ingest that consumes it");
  assert.match(
    worker.slice(ingested, ingested + 160),
    /bulkArrival/,
    "and actually passes it — deriving it and dropping it is the silent half of this bug",
  );
  const service = read("src/lib/recruitment/inbound/cv-intake-service.ts");
  assert.equal(
    (service.match(/bulkArrival: input\.bulkArrival === true/g) ?? []).length,
    2,
    "BOTH notify call sites forward it — the successful arrival and the failed upload",
  );

  // The throttle. Six cron ticks fall inside the digest hour; the Cairo-dated idempotency key is
  // what makes exactly one of them deliver, claimed atomically per recipient by the notification
  // layer. There is deliberately no "have I sent today" read, and therefore no race.
  assert.match(
    notify,
    /idempotencyKey: `recruitment-daily-cv-digest:\$\{digest\.dayKey\}`/,
    "the Cairo date is the throttle bucket — one digest per day, per recipient",
  );
  assert.equal(isDailyCvDigestHour(18), true);
  assert.equal(isDailyCvDigestHour(17), false);
  assert.equal(isDailyCvDigestHour(19), false, "one hour only — 138 of the day's 144 ticks must cost nothing");
  // Against a real instant, in Cairo terms rather than the server's UTC clock. 15:30 UTC is 18:30
  // in Cairo on a summer-time date; 18:30 UTC is 21:30 there and must NOT fire.
  assert.equal(isDailyCvDigestTime(new Date("2026-08-15T15:30:00.000Z")), true);
  assert.equal(
    isDailyCvDigestTime(new Date("2026-08-15T18:30:00.000Z")),
    false,
    "the gate must read Cairo's hour — a UTC hour check would fire at the wrong time of day",
  );

  const cron = read("app/api/cron/recruitment-email-intake/route.ts");
  assert.match(
    cron,
    /if \(!isDailyCvDigestTime\(\)\) return;/,
    "the hour gate is checked before any database work",
  );
  assert.match(
    cron,
    /await reportDailyCvDigest\(\)\.catch\(/,
    "best-effort — a summary that fails to send must never turn the mailbox poll red",
  );

  // ── 7 · The digest is still the "new CV" notice, so it still never emails ───
  //
  // Owner rule, live in production since 2026-08-15. It needed adding explicitly: the
  // `recruitment.*` policy row the digest would otherwise fall through to carries email.
  assert.equal(isRecruitmentCvReceivedEvent("recruitment", "recruitment_daily_cv_digest"), true);
  assert.equal(isRecruitmentCvReceivedEvent("recruitment", "recruitment_inbound_cv"), true);
  assert.equal(
    isRecruitmentCvReceivedEvent("recruitment", "RECRUITMENT_DAILY_CV_DIGEST"),
    true,
    "matching must stay case-insensitive for the digest too",
  );
  assert.deepEqual(
    enforceRecruitmentCvEmailBlock(["email", "in_app", "telegram", "push"], "recruitment", "recruitment_daily_cv_digest"),
    ["in_app", "telegram", "push"],
    "email is stripped from the digest exactly as it is from the per-CV notice",
  );
  const policy = read("src/lib/notifications/policy.ts");
  assert.match(
    policy,
    /"recruitment\.recruitment_daily_cv_digest": \{ channels: \["in_app", "telegram", "push"\]/,
    "the policy row states the intent; the guard enforces it — both layers, same as the per-CV notice",
  );
  assert.doesNotMatch(
    notify,
    /notifyDailyCvDigest[\s\S]{0,900}?channels: \[[^\]]*"email"/,
    "the call site must not re-introduce email either",
  );
}
