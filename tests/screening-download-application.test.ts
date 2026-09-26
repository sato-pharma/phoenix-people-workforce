import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Screening page — "Download application" / "Print application", the WhatsApp Applicants' own two
// buttons, on the screening workstation (the owner, 2026-09-26:
// "/recruitment/screening?...&status=shortlisted ADD DOWNLOAD APPLICATION AS THE WHATSAPP APPLICANTS").
//
// The buttons already live on WhatsApp Applicants and, since 2026-09-19, on the interview calendar's CV
// screen. This puts the SAME component in the screening workstation's decision strip, so a recruiter
// reading a shortlisted CV can save the CV-plus-answer-sheet without leaving the page. It adds no way to
// build the file: it asks one question — does this candidate have a WhatsApp application, and under which
// conversation? — and the buttons reuse the WhatsApp Applicants download route and print page, each of
// which re-checks the caller on its own. Pinned here:
//
//   1. the lookup route is GET-only, gated by the shared `canOpenWhatsAppApplications` predicate on top of
//      candidates:read, answers an id and nothing about the person, builds no file, and is never cached;
//   2. it is covered by the ordinary candidates:read registry gate the screening page already passes;
//   3. the workstation asks it once per candidate and hands the answer to the review header;
//   4. the review header draws the SAME component the applicants list uses, guarded by the id, beside the
//      other ways of reaching the person and before the verdicts, in the fragment BOTH bands render.
// ─────────────────────────────────────────────────────────────────────────────

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function runRouteTests() {
  const route = stripComments(read("app/api/recruitment/candidates/[id]/application/route.ts"));

  assert.ok(/export async function GET\(/.test(route), "the lookup is a GET");
  assert.ok(!/export async function (POST|PATCH|PUT|DELETE)\(/.test(route), "read only — it builds and changes nothing");

  const gate = route.indexOf('requireRecruitmentAccess(request, "candidates", "read")');
  const predicate = route.indexOf("canOpenWhatsAppApplications(access)");
  const lookup = route.indexOf("findWhatsAppApplicationSessionId(id)");
  assert.ok(gate >= 0, "the ordinary candidates:read gate the screening page passes");
  assert.ok(predicate > gate, "then the shared predicate — the same one the download route and the calendar use");
  assert.ok(lookup > predicate, "and only then the read of a stranger's conversations");

  assert.ok(
    /return NextResponse\.json\(\s*\{ application: sessionId \? \{ sessionId \} : null, success: true \}/.test(route),
    "it answers the conversation's id and nothing about the person",
  );
  assert.ok(route.includes('"Cache-Control": "no-store"'), "the answer is about one person and is never cached");
  assert.ok(
    !/buildWhatsAppApplicationPdf|loadWhatsAppApplication\(|application-pdf|application-sheet|whatsapp-application-file/.test(route),
    "the route builds no file — the buttons reuse the WhatsApp Applicants download route",
  );
  assert.ok(
    /import \{ canOpenWhatsAppApplications \} from "@\/lib\/recruitment\/whatsapp-application-access";/.test(route),
    "it asks the SHARED predicate, so it can never drift from the file's own gate",
  );
}

function runRegistryTests() {
  // No entry of its own: it is an ordinary candidate read under the candidates/** blanket the screening
  // page already lives behind, exactly like /seen and /timeline. A guessed id reaches only the same gate.
  const entry = findAccessRegistryEntry("/api/recruitment/candidates/anything/application", "GET");
  assert.ok(entry, "the lookup is covered by the registry");
  assert.equal(entry.authMode, "session");
  assert.deepEqual(entry.permission, { resource: "candidates", action: "read" }, "gated as a candidate read");
}

function runWorkstationTests() {
  const workstation = stripComments(read("src/components/recruitment/workstation/screening-workstation.tsx"));

  assert.ok(
    workstation.includes("const [applicationSessions, setApplicationSessions] = useState<Record<string, string | null>>({});"),
    "the workstation keeps each candidate's application conversation, keyed by candidate id",
  );
  assert.ok(
    workstation.includes("fetch(`/api/recruitment/candidates/${id}/application`)"),
    "it asks the lookup route",
  );
  assert.ok(
    /if \(!id \|\| id in applicationSessions\) return;/.test(workstation),
    "asked once per candidate — a person already answered (even answered null) is not asked again",
  );
  assert.ok(
    /applicationSessionId=\{applicationSessions\[selected\.id\] \?\? null\}/.test(workstation),
    "and the selected candidate's answer is handed to the review header",
  );
}

function runReviewHeaderTests() {
  const source = read("src/components/recruitment/workstation/workstation-review-header.tsx");
  assert.ok(
    /import \{ WhatsAppApplicationActions \} from "@\/components\/recruitment\/whatsapp-application-actions";/.test(source),
    "the review header draws the SAME component the WhatsApp Applicants list uses",
  );

  const header = stripComments(source);
  const decisionsStart = header.indexOf("const decisions = (");
  assert.ok(decisionsStart >= 0, "the decision strip exists");
  const decisionsEnd = header.indexOf("const afterBands", decisionsStart);
  assert.ok(decisionsEnd > decisionsStart, "the decision strip ends");
  const decisions = header.slice(decisionsStart, decisionsEnd);

  assert.ok(
    /applicationSessionId \?\s*\(\s*<WhatsAppApplicationActions applicantName=\{row\.fullName\} sessionId=\{applicationSessionId\} \/>\s*\) : null/.test(
      decisions,
    ),
    "the buttons show only when the person has an application — absent, never disabled, otherwise",
  );

  // Beside the other ways of reaching the person, before the verdicts, in the fragment BOTH bands render.
  const schedule = decisions.indexOf("<ScheduleInterviewButton");
  const application = decisions.indexOf("<WhatsAppApplicationActions");
  const shortlist = decisions.indexOf('label="Shortlist"');
  assert.ok(schedule >= 0 && application > schedule, "it follows Schedule interview");
  assert.ok(shortlist > application, "and comes before the verdicts");
}

export function runScreeningDownloadApplicationTests() {
  runRouteTests();
  runRegistryTests();
  runWorkstationTests();
  runReviewHeaderTests();
}
