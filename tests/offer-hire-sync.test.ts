import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The offer letter, the candidate and the Employee Master must tell ONE story.
//
// Owner, 2026-10-14: the Talent Acquisition overview's "job offers vs recruitments" showed extremely
// wrong data. The audit found the three records had drifted because two doors between them never
// wrote back:
//
//   - HR's Add Employee, started from an accepted letter, never pointed the letter at the employee.
//     24 of 26 accepted letters had no `employee_hr_id` while 21 of those people were on the Master,
//     so "Offer to join" read 2 of 26.
//   - "Declined offer" on the Employee Master never touched the letter or the candidate. Four people
//     the Master recorded as declined still had an ACCEPTED letter; one candidate still read hired.
//
// The data was repaired the same day. This file pins the two doors so it stays repaired.
// Source-level on purpose (the writers talk to the database); the pure count has its own behaviour
// test in hired-tile-period.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

function code(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}

function flat(file: string): string {
  return code(file).replace(/\s+/g, " ");
}

/** The text of one exported function, from its signature to the next top-level `export`. */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  // Whitespace-delimited so it works on the flattened copy too, where there is no newline to find;
  // and a function that is the LAST export simply runs to the end of the file.
  const rest = source.slice(start + signature.length);
  const next = /\sexport\s/.exec(rest);
  return source.slice(start, next ? start + signature.length + next.index : undefined);
}

export function runOfferHireSyncTests(): void {
  // ── 1 · The letter is pointed at the employee — conditionally, never an overwrite ──────────────
  const offers = flat("src/lib/offers/service.ts");
  const stamp = bodyOf(offers, "export async function stampOfferHiredByHr(");
  assert.match(stamp, /\.update\(\{ employee_hr_id: employeeHrId \}\)/, "it writes the employee the letter became");
  assert.match(stamp, /\.eq\("status", "accepted"\)/, "RED only an ACCEPTED letter is pointed at a hire");
  assert.match(
    stamp,
    /\.is\("employee_hr_id", null\)/,
    "RED only a letter with NO employee yet — a stale tab or the wrong letter must never repoint one that already names somebody",
  );

  const decline = bodyOf(offers, "export async function declineAcceptedOffersForEmployee(");
  assert.match(decline, /\.update\(\{ status: "declined" \}\)/, "the letter becomes declined");
  assert.match(decline, /\.in\("employee_hr_id", keys\)/, "RED found through the employee the letter POINTS AT");
  assert.match(decline, /\.eq\("status", "accepted"\)/, "and only if it still says accepted");
  assert.ok(
    !/candidate_name|candidate_email|ilike\(/.test(decline + stamp),
    "RED a letter is never found by a name or an address — the same rule as every offer-to-person link",
  );

  // ── 2 · The recruitment side: found by the pointer, moved once, no notice sent ────────────────
  const syncFile = "src/lib/recruitment/offer-outcome-sync.ts";
  const sync = code(syncFile);
  const syncFlat = flat(syncFile);
  assert.match(sync, /candidateForOfferLetter\(offerId\)/, "the candidate is found through the pointer it carries");
  assert.ok(
    !/\.ilike\(|\.like\(|full_name|fullName|email|phone|national_id/.test(sync),
    "RED the candidate is NEVER matched by name, address, phone or national id — a human said which letter is whose",
  );
  assert.ok(
    !/@\/lib\/notifications|sendEmail|sendRejection|resend/i.test(sync),
    "RED moving a status sends nothing — a rejection NOTICE is never automatic",
  );
  assert.match(syncFlat, /if \(candidate\.status === to\) return "already";/, "a second save cannot stack a second history line");
  assert.match(syncFlat, /await recordCandidateStatusEvent\(/, "every move writes the append-only history line");
  assert.match(
    syncFlat,
    /if \(!sameEmployee\(letter\.employeeHrId, hrId\)\) \{ return \{ candidate: "none", letterLinked: false \}; \}/,
    "RED the candidate is promoted only when the letter really points at THIS employee",
  );
  assert.match(syncFlat, /toStatus: to/, "the history line records the status it moved to");
  assert.match(sync, /catch \(error\)[\s\S]*offer_hire_sync_failed/, "a hire sync failure is logged, never thrown");
  assert.match(sync, /catch \(error\)[\s\S]*offer_decline_sync_failed/, "and so is a decline sync failure");
  assert.match(sync, /from "@\/lib\/offers\/service"/, "the arrow runs recruitment -> offers, through the offers module's own writers");

  // ── 3 · Door one: HR's Add Employee, from an accepted letter ──────────────────────────────────
  const hr = code("app/api/employees/route.ts");
  const hrFlat = flat("app/api/employees/route.ts");
  assert.match(hrFlat, /offerId\?: string;/, "the body carries the letter beside the employee, never inside it");
  const upsert = hr.indexOf("await upsertEmployee(");
  const link = hr.indexOf("recordHireFromOfferLetter(");
  const provision = hr.indexOf("await provisionNewHireAccess(");
  assert.ok(upsert >= 0 && link > upsert, "the letter is linked AFTER the employee row exists");
  assert.ok(
    link < provision,
    "RED and BEFORE the follow-ups, any of which can throw and would otherwise leave the letter unlinked for good",
  );
  assert.match(
    hrFlat,
    // Wrapped in the hire hand-off ledger since 2026-11-13 (REC-027) — still awaited, still the same call.
    /if \(isNewEmployee && payload\.offerId\?\.trim\(\)\) \{ await handoff\.run\( "offer_link", [^;]*?\(\) => recordHireFromOfferLetter\(/,
    "on a CREATE only, and only when the form was filled from a letter",
  );

  // The form sends the letter it was ACTUALLY filled from — never the URL, which outlives the form.
  const form = flat("src/components/employees/employee-management.tsx");
  assert.match(form, /const \[offerLinkId, setOfferLinkId\] = React\.useState<string \| null>\(null\);/, "the letter is held in state");
  assert.match(
    form,
    /setForm\(filled\); setIsFormOpen\(true\); setOfferLinkId\(hireOfferId\);/,
    "set only once the letter's draft landed in the form",
  );
  assert.match(form, /\.\.\.\(offerLinkId \? \{ offerId: offerLinkId \} : \{\}\)/, "sent from the state");
  assert.ok(
    !/offerId: hireOfferId/.test(form),
    "RED never from the query string: `?fromOffer=` stays in the bar after the drawer closes and would point a letter at whoever is typed next",
  );
  for (const opener of ["function startCreate() {", "function startEdit(employee: EmployeeDirectoryRow) {", "function closeForm() {"]) {
    const at = form.indexOf(opener);
    assert.ok(at >= 0, `${opener} must exist`);
    assert.ok(
      form.slice(at, at + 220).includes("setOfferLinkId(null)"),
      `RED ${opener} must drop the letter the previous form was filled from`,
    );
  }
  const create = form.slice(form.indexOf('fetch("/api/employees", { body: JSON.stringify({'));
  assert.ok(
    create.indexOf("offerId: offerLinkId") < create.indexOf("employee: formToPayload(form, editingHrId"),
    "the letter travels as a sibling of `employee`",
  );
  assert.ok(
    create.indexOf("editingHrId ? {}") >= 0 && create.indexOf("editingHrId ? {}") < create.indexOf("offerId: offerLinkId"),
    "inside the CREATE-only branch — an edit never carries a letter",
  );

  // ── 4 · Door two: the candidate's own joining form ───────────────────────────────────────────
  const joinService = flat("src/lib/offers/joining-form-service.ts");
  assert.match(joinService, /return \{ hrId, offerId: offer\.id, ok: true,/, "the service hands the letter back to its caller");
  assert.ok(
    !/recruitment/.test(joinService),
    "RED the offers module still never imports recruitment — the route is where the two meet",
  );
  const joinRoute = flat("app/api/public/offer-acceptance/[token]/route.ts");
  assert.match(joinRoute, /const \{ offerId, \.\.\.visible \} = result;/, "the letter id is taken off before the response");
  assert.match(
    joinRoute,
    // Recorded in the hire hand-off ledger since 2026-11-13 (REC-027) — the same call, then the same reply.
    /await runHandoffStep\(result\.hrId, "joining_form", "offer_link", \{ offerId \}, \(\) => recordHireFromOfferLetter\(\{ actorHrId: null, hrId: result\.hrId, offerId \}\), \{ failureOf: syncOutcomeFailure \}\); return json\(visible\);/,
    "RED the candidate behind the letter is marked hired, and the caller is shown what the form always returned",
  );

  // ── 5 · Door three: "declined offer" on the Employee Master ──────────────────────────────────
  const resignations = code("src/lib/resignations/service.ts");
  const declineFn = bodyOf(resignations, "export async function declineOfferAndOpenVacancy(");
  const audit = declineFn.indexOf('entityType: "employee_decline_offer"');
  const sync2 = declineFn.indexOf("recordOfferDeclinedAfterHire(");
  const notify = declineFn.indexOf("notifyResignationWorkflow(");
  assert.ok(audit >= 0 && sync2 > audit, "RED the letter and candidate follow the status — after the audit row, so a failure cannot hide the decline");
  assert.ok(sync2 < notify, "and before the notification");
  assert.match(
    flat("src/lib/resignations/service.ts"),
    /recordOfferDeclinedAfterHire\(\{ actorHrId: access\?\.hrId \?\? null, employeeHrId: employee\.hrId, \}\);/,
    "keyed on the employee's own HR id",
  );

  // ── 6 · Door four: a letter marked DECLINED by hand on the Offers screen ─────────────────────
  // The candidate who said no stops being a live candidate. Live piles only, and withdrawn is not
  // declined: a pulled or expired letter says nothing about the person.
  const offerRoute = flat("app/api/offers/[id]/route.ts");
  assert.match(
    offerRoute,
    /const offer = await setOfferStatus\(id, body\.status as OfferStatus\); .*?if \(offer\.status === "declined"\) \{ await recordOfferDeclinedByCandidate\(\{ actorHrId: access\.hrId \?\? null, offer \}\); \}/,
    "RED the status route closes the candidate behind a letter that ends up declined — after the status is written",
  );
  assert.ok(
    !/status === "withdrawn"[^}]*recordOfferDeclinedByCandidate/.test(offerRoute),
    "RED a withdrawn letter never closes a candidate",
  );
  const declinedByHand = bodyOf(syncFlat, "export async function recordOfferDeclinedByCandidate(");
  assert.match(declinedByHand, /LIVE_CANDIDATE_STATUSES/, "only a candidate in a live pile can be closed by a declined letter");
  assert.match(syncFlat, /const LIVE_CANDIDATE_STATUSES: readonly string\[\] = \["new", "shortlisted", "backup", "sent_to_manager"\];/);
  assert.match(
    syncFlat,
    /if \(onlyFrom && !onlyFrom\.includes\(candidate\.status\)\) return "kept";/,
    "RED a hired or rejected candidate is left exactly where they are — a letter marked declined by mistake must not un-hire anyone",
  );
  assert.match(declinedByHand, /catch \(error\)[\s\S]*offer_candidate_decline_sync_failed/, "a failure here is logged, never thrown");
}
