import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createAccessContext, canAccess, isHrAuthorityRole, permissionMatrix, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { chooseApplicationRow } from "../src/lib/recruitment/whatsapp-applicants-loader.ts";
import { canOpenWhatsAppApplications } from "../src/lib/recruitment/whatsapp-application-access.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Interview calendar — "Download application" and "Print application" beside the CV (the owner, 2026-09-19).
//
// The two buttons already on WhatsApp Applicants, drawn in the header of the CV screen the calendar opens,
// next to the CV's own Download. The calendar adds no way to build the file: it asks one question — does
// this interviewee have a WhatsApp application, and under which conversation? — and the buttons reuse the
// WhatsApp Applicants route and print page, each behind its own gate. Pinned here:
//
//   1. the conversation a press opens is the one the list would show for that person: a finished one
//      first, then the newest, compared as instants;
//   2. the buttons are offered only to someone who could open the same file from WhatsApp Applicants — and
//      the calendar can be shared with people who hold no recruitment permission at all;
//   3. the lookup goes through the calendar's own gate first (the candidate must be on a week open to the
//      caller), answers an id and nothing else, builds nothing, and is registered as a session route;
//   4. the four places that decide who may open an application say the same three things;
//   5. the calendar draws the buttons beside the CV's Download, only when the lookup found one, and its
//      own state is only ever set from the answer.
// ─────────────────────────────────────────────────────────────────────────────

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

/** From `export async function name(` to its closing brace at column 0. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} ends`);
  return source.slice(start, end + 2);
}

function runChoiceTests() {
  const row = (id: string, appliedAt: string, finished: boolean) => ({ appliedAt, finished, id });

  assert.equal(chooseApplicationRow([]), null, "no conversation, no buttons");
  const only = row("only", "2026-09-10T08:00:00.000Z", false);
  assert.equal(chooseApplicationRow([only]), only, "one conversation is the one");

  // A finished application beats a newer one still being answered, whichever way the list arrives.
  const finishedOld = row("finished-old", "2026-09-01T08:00:00.000Z", true);
  const openNew = row("open-new", "2026-09-15T08:00:00.000Z", false);
  assert.equal(chooseApplicationRow([openNew, finishedOld])?.id, "finished-old", "finished first, even when older");
  assert.equal(chooseApplicationRow([finishedOld, openNew])?.id, "finished-old", "and the order it arrives in changes nothing");

  // Among the same kind the newest wins.
  const finishedNew = row("finished-new", "2026-09-12T08:00:00.000Z", true);
  assert.equal(chooseApplicationRow([finishedOld, finishedNew])?.id, "finished-new", "the newest finished one");
  assert.equal(chooseApplicationRow([finishedNew, finishedOld])?.id, "finished-new", "in either order");
  const openOld = row("open-old", "2026-09-02T08:00:00.000Z", false);
  assert.equal(chooseApplicationRow([openOld, openNew])?.id, "open-new", "the newest unfinished one when none finished");

  // Dates compare as instants, never as text: 10:12 in Cairo (+02:00) is 08:12 UTC — EARLIER than 09:12 UTC
  // although it sorts after it as a string.
  const utcNine = row("nine-utc", "2026-09-14T09:12:00.000Z", true);
  const cairoTen = row("ten-cairo", "2026-09-14T10:12:00+02:00", true);
  assert.equal(chooseApplicationRow([utcNine, cairoTen])?.id, "nine-utc", "an instant, not a string");
  assert.equal(chooseApplicationRow([cairoTen, utcNine])?.id, "nine-utc", "in either order");
}

async function runAccessTests() {
  const context = (role: PhoenixRole) => createAccessContext({ hrId: "A-17", role });

  // "move recruiting off the HR Business Partner" (owner, 2026-10-08).
  assert.equal(await canOpenWhatsAppApplications(context("HR Resourcing")), true, "the Talent Acquisition seat runs recruiting and opens applications");
  assert.equal(await canOpenWhatsAppApplications(context("HR Advisory")), false, "HR Advisory gave recruiting up on 2026-10-08");
  assert.equal(await canOpenWhatsAppApplications(context("Super Admin")), true, "so does the Super Admin");
  assert.equal(
    await canOpenWhatsAppApplications(context("HR Operations")),
    false,
    "an HR authority WITHOUT recruitment:read and candidates:read is not offered them (owner rule 2026-09-01: HR Operations does not open recruiting)",
  );
  assert.equal(await canOpenWhatsAppApplications(context("CEO")), false, "the CEO can be shared the calendar and is not offered the application");
  assert.equal(await canOpenWhatsAppApplications(context("Employee")), false, "an employee is not");

  // A copy-link visitor who never signed in.
  assert.equal(
    await canOpenWhatsAppApplications({ ...context("HR Advisory"), source: "guest" }),
    false,
    "a guest is not offered them, whatever role the link borrowed",
  );

  // A system-scope account passes every canAccess; the role check alone must still hold it back.
  assert.equal(
    await canOpenWhatsAppApplications({ ...context("CEO"), scope: "system" }),
    false,
    "the role must be an HR authority, however wide the account's scope",
  );

  // The helper is exactly the three conditions, for every role there is, and both answers occur.
  const answers = new Set<boolean>();
  for (const role of Object.keys(permissionMatrix) as PhoenixRole[]) {
    const subject = context(role);
    const expected =
      isHrAuthorityRole(role)
      && (await canAccess(subject, "recruitment", "read"))
      && (await canAccess(subject, "candidates", "read"));
    const actual = await canOpenWhatsAppApplications(subject);
    assert.equal(actual, expected, `${role}: the calendar offers the buttons exactly when WhatsApp Applicants would open the file`);
    answers.add(actual);
  }
  assert.deepEqual([...answers].sort(), [false, true], "the sweep saw someone allowed and someone refused");
}

function runWiringTests() {
  const domain = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  const lookup = functionBody(domain, "getInterviewCalendarCandidateApplication");

  // The calendar's own door first, then who the caller is, then the WhatsApp lookup — in that order,
  // because the lookup reads a stranger's conversations.
  const order = [
    'requireCalendarAccess(caller, "view", "any")',
    "assertCandidateOnCalendar(caller, candidateId)",
    "isSignedInCaller(caller.access)",
    "canOpenWhatsAppApplications(caller.access)",
    "findWhatsAppApplicationSessionId(candidateId)",
  ].map((needle) => {
    const index = lookup.indexOf(needle);
    assert.ok(index >= 0, `${needle} is in the lookup`);
    return index;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the calendar's gate, then the candidate on the calendar, then the caller, then the read");
  assert.ok(/return sessionId \? \{ sessionId \} : null;/.test(lookup), "it answers the conversation's id and nothing about the person");
  assert.ok(!/buildWhatsAppApplication|loadWhatsAppApplication\(|application-pdf|application-sheet/.test(lookup), "and builds nothing");
  assert.ok(
    /import \{ canOpenWhatsAppApplications \} from "@\/lib\/recruitment\/whatsapp-application-access";/.test(domain),
    "the domain asks the shared predicate",
  );

  // The route: the calendar's caller, one GET, no caching, an id and nothing else.
  const route = stripComments(read("app/api/recruitment/interview-calendar/candidates/[candidateId]/application/route.ts"));
  const resolved = route.indexOf("resolveAccessContext(request)");
  const caller = route.indexOf("interviewCalendarCaller(access, request)");
  const asked = route.indexOf("getInterviewCalendarCandidateApplication(caller, candidateId)");
  assert.ok(resolved > 0 && caller > resolved && asked > caller, "who is asking, then the copy link they came through, then the lookup");
  assert.ok(!/export async function (POST|PATCH|PUT|DELETE)\(/.test(route), "read only");
  assert.ok(route.includes('"Cache-Control": "no-store"'), "the answer is about one person and is never cached");
  assert.ok(route.includes("NextResponse.json({ application, success: true }"), "it answers the lookup's own result");
  assert.ok(!/application-pdf|application-sheet|whatsapp-application-file/.test(route), "the route builds no file");

  // The registry: its own session route, guarded by the domain helper, GET only.
  const entry = findAccessRegistryEntry("/api/recruitment/interview-calendar/candidates/anything/application", "GET");
  assert.ok(entry, "the lookup is registered");
  assert.equal(entry.pattern, "/api/recruitment/interview-calendar/candidates/*/application", "under the calendar's own prefix");
  assert.equal(entry.authMode, "session");
  assert.equal(entry.permission, null, "the calendar's gate is in the domain helper, like the CV beside it");
  assert.equal(entry.guard, "domain-helper");
  assert.deepEqual([...entry.methods], ["GET"]);
  assert.equal(findAccessRegistryEntry("/api/recruitment/interview-calendar/candidates/anything/application", "POST"), null, "nothing writes there");
}

function runGateParityTests() {
  // Four places decide who may open an application. The calendar's copy exists only so the buttons are
  // not drawn for someone the routes behind them would refuse.
  const helper = stripComments(read("src/lib/recruitment/whatsapp-application-access.ts"));
  const list = stripComments(read("app/(admin)/recruitment/whatsapp-applicants/page.tsx"));
  const page = stripComments(read("app/print/whatsapp-application/[sessionId]/page.tsx"));
  const route = stripComments(read("app/api/recruitment/whatsapp-applicants/[sessionId]/application/route.ts"));

  const sources: Array<[string, string]> = [
    ["the calendar's helper", helper],
    ["the WhatsApp Applicants list", list],
    ["the print page", page],
    ["the download route", route],
  ];
  for (const [name, source] of sources) {
    assert.ok(source.includes("isHrAuthorityRole(access.role)"), `${name} requires an HR authority role`);
    assert.ok(source.includes('canAccess(access, "recruitment", "read")'), `${name} requires recruitment:read`);
  }
  for (const [name, source] of [
    ["the calendar's helper", helper],
    ["the WhatsApp Applicants list", list],
    ["the print page", page],
  ] as const) {
    assert.ok(source.includes('canAccess(access, "candidates", "read")'), `${name} requires candidates:read`);
  }
  assert.ok(route.includes('requireRecruitmentAccess(request, "candidates", "read")'), "the download route requires candidates:read too");
}

function runButtonTests() {
  const view = stripComments(read("src/components/recruitment/interview-calendar/interview-calendar-view.tsx"));

  assert.ok(
    view.includes('import { WhatsAppApplicationActions } from "@/components/recruitment/whatsapp-application-actions";'),
    "the calendar draws the very buttons WhatsApp Applicants has",
  );

  // The lookup: skipped when the CVs are behind a sign-in, and its state is set only from the answer.
  const lookupPath = "`/candidates/${encodeURIComponent(candidateId)}/application`";
  const at = view.indexOf(lookupPath);
  assert.ok(at > 0, "the calendar asks the lookup for the interviewee's own id");
  const effect = view.slice(view.lastIndexOf("useEffect(", at), view.indexOf("}, [api, candidateId, cvsNeedSignIn]);", at));
  assert.ok(effect.includes("if (!candidateId || cvsNeedSignIn) return;"), "no lookup for someone from outside, or before the CVs open");
  assert.ok(effect.includes("if (live) setApplicationSessionId("), "state is set only while mounted");
  assert.ok(effect.indexOf(".then((data)") < effect.indexOf("setApplicationSessionId("), "and only from the answer, never inside the effect body");
  assert.ok(effect.includes(".catch(() => {})"), "a failed lookup draws no buttons and breaks nothing");
  assert.ok(effect.includes('typeof application?.sessionId === "string"'), "only a real id is taken");

  // The buttons: built from that id alone, in the CV header, and in the no-CV dialog too.
  assert.ok(
    /const applicationActions = applicationSessionId \? \(\s*<WhatsAppApplicationActions applicantName=\{booking\.candidateName\} sessionId=\{applicationSessionId\} \/>\s*\) : null;/.test(view),
    "drawn only when the lookup found a conversation, from that conversation's id",
  );
  assert.ok(/<CvPreviewModal[^>]*headerActions=\{applicationActions\}/.test(view),"beside the CV's own Download, in the CV screen's header");
  assert.ok(view.includes('{applicationActions ? <div className="mb-4">{applicationActions}</div> : null}'), "and above the interview when the CV itself cannot open");

  // The CV screen puts them before its own Download link, and what it already had is unchanged.
  const modal = stripComments(read("src/components/recruitment/cv-preview-modal.tsx"));
  assert.ok(/\{headerActions\}\s*\{allowDownload \? \(/.test(modal), "right before the CV's Download link");
}

export async function runInterviewCalendarApplicationTests() {
  runChoiceTests();
  await runAccessTests();
  runWiringTests();
  runGateParityTests();
  runButtonTests();
}
