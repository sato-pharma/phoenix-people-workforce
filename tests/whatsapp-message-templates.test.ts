import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  formatDocumentList,
  selectCandidateSuppliedNames,
} from "../src/lib/hiring-documents/candidate-supplied.ts";
import { candidateGreetingName } from "../src/lib/recruitment/candidate-greeting.ts";
import { firstNameOf, softenShoutedName } from "../src/lib/recruitment/whatsapp-templates/candidate-context.ts";
import {
  formatDialNumberForDisplay,
  isDialableWhatsApp,
  toWhatsAppDialNumber,
  whatsAppSendUrl,
} from "../src/lib/recruitment/whatsapp-templates/send-link.ts";
import { templateDraftViolations } from "../src/lib/recruitment/whatsapp-templates/template.ts";
import {
  extractVariableKeys,
  isAutoVariable,
  manualVariableKeys,
  renderTemplate,
  requiresEmployeeTarget,
  templateAllowedForCandidate,
  variableLabel,
} from "../src/lib/recruitment/whatsapp-templates/variables.ts";
import { stripComments } from "./support/comment-strip.ts";

export function runWhatsAppMessageTemplateTests() {
  // ── The placeholder scanner ──────────────────────────────────────────────────────────────
  //
  // The derived list is the whole feature: it is what makes a template the owner types produce the
  // right boxes on the send screen with nothing in code changing.

  assert.deepEqual(
    extractVariableKeys("Dear {{candidate_first_name}}, on {{interview_date}} at {{interview_time}}."),
    ["candidate_first_name", "interview_date", "interview_time"],
    "keys come back in the order they appear in the message",
  );

  assert.deepEqual(
    extractVariableKeys("{{name}} — {{name}} again, {{ name }} spaced"),
    ["name"],
    "a repeated placeholder is one field, and inner spacing is the same key",
  );

  assert.deepEqual(extractVariableKeys("{{Interview_Date}}"), ["interview_date"], "keys are case-insensitive");

  // A HALF-WRITTEN PLACEHOLDER IS TEXT, NOT A FIELD. This direction is deliberate: the failure
  // nobody would catch is a placeholder silently deleted, leaving a hole in a message that then
  // goes to a candidate.
  assert.deepEqual(extractVariableKeys("Cost is {{ 50%}} and {{}} and { {x} }"), [], "malformed braces are not fields");
  assert.deepEqual(extractVariableKeys("no placeholders here"), [], "plain text has no fields");

  assert.ok(isAutoVariable("candidate_name"), "the candidate's name is filled in for you");
  assert.ok(!isAutoVariable("interview_date"), "a date is a decision nobody has recorded — it must be typed");
  assert.deepEqual(
    manualVariableKeys("Dear {{candidate_first_name}}, on {{interview_date}}"),
    ["interview_date"],
    "only the un-answerable half is asked for",
  );

  // ── Rendering ────────────────────────────────────────────────────────────────────────────

  const rendered = renderTemplate("Dear {{first}}, see you {{when}}.", { first: "Aya", when: "Sunday" });
  assert.equal(rendered.text, "Dear Aya, see you Sunday.", "values are substituted verbatim");
  assert.deepEqual(rendered.missing, [], "a fully filled template reports nothing missing");

  // AN EMPTY VALUE IS A REFUSAL, NOT AN EMPTY STRING. "Dear ," reaching a real candidate is the one
  // outcome that cannot be taken back, so the placeholder survives and the caller is told.
  for (const empty of ["", "   ", null, undefined]) {
    const partial = renderTemplate("Dear {{first}}, see you {{when}}.", { first: empty, when: "Sunday" });
    assert.deepEqual(partial.missing, ["first"], `an empty value (${JSON.stringify(empty)}) is reported as missing`);
    assert.ok(partial.text.includes("{{first}}"), "the unfilled placeholder stays visible rather than vanishing");
    assert.ok(!partial.text.includes("Dear ,"), "an unfilled name must never render as an empty greeting");
  }

  const repeated = renderTemplate("{{a}} {{a}} {{b}}", {});
  assert.deepEqual(repeated.missing, ["a", "b"], "a placeholder used twice is reported once");

  // Values are inserted as typed. Trimming is the only thing done to them — an Arabic address, a
  // Maps URL and bullet characters must all survive untouched.
  const arabic = renderTemplate("Address: {{address}}", {
    address: "  26th of July Corridor, المنطقة السياحية، 6th of October, Giza  ",
  });
  assert.equal(
    arabic.text,
    "Address: 26th of July Corridor, المنطقة السياحية، 6th of October, Giza",
    "Arabic text passes through unchanged, trimmed only at the ends",
  );

  assert.equal(variableLabel("interviewer_name"), "Interviewer name", "a known key reads as words");
  assert.equal(variableLabel("room_number"), "Room Number", "an invented key still reads as words, never as a key");

  // ── The owner's own interview invitation, end to end ─────────────────────────────────────
  //
  // This is the message he pasted when he asked for the feature. If this ever stops rendering, the
  // feature has stopped doing the thing it was built for.

  const invitation = [
    "Dear {{candidate_first_name}}",
    "",
    "Good day,",
    "",
    "As per our call please find below your interview details.",
    "",
    "• Date: {{interview_date}}",
    "• Time: {{interview_time}}",
    "• Interviewer: {{interviewer_name}} ({{interviewer_title}})",
    "• Address: {{address}}",
    "",
    "Good Luck,",
    "{{sender_name}}",
  ].join("\n");

  const invite = renderTemplate(invitation, {
    address: "6th of October, Giza",
    candidate_first_name: "Aya",
    interview_date: "Sunday 12-7-2026",
    interview_time: "1:40 PM",
    interviewer_name: "Mr. Ahmed Nour",
    interviewer_title: "SR HR Manager",
    sender_name: "Amira Mohamed",
  });
  assert.deepEqual(invite.missing, [], "the owner's invitation fills completely");
  assert.ok(invite.text.startsWith("Dear Aya\n"), "it opens with the candidate's first name");
  assert.ok(invite.text.includes("• Time: 1:40 PM"), "the bullet lines survive");
  assert.ok(!invite.text.includes("{{"), "no placeholder is left behind");

  // ── Numbers ──────────────────────────────────────────────────────────────────────────────
  //
  // The Egyptian repair is inherited from the organogram and covered by its own test; what matters
  // HERE is that the Egyptian reading is tried FIRST. An 11-digit local number would otherwise pass
  // the international check as a number in some other country entirely.

  assert.equal(toWhatsAppDialNumber("01012345678"), "201012345678", "an Egyptian local number is repaired, not read as international");
  assert.equal(toWhatsAppDialNumber("1012345678"), "201012345678", "a lost leading zero is repaired");
  assert.equal(toWhatsAppDialNumber("+20 10 1234 5678"), "201012345678", "punctuation is cosmetic");

  // Typed by hand, for a candidate outside Egypt — the manual path the owner asked for.
  assert.equal(toWhatsAppDialNumber("+44 7700 900123"), "447700900123", "a full international number is accepted");
  assert.equal(toWhatsAppDialNumber("00966501234567"), "966501234567", "00 is the other way people write +");

  for (const junk of [null, undefined, "", "   ", "n/a", "abc", "12", "0101234567890123456"]) {
    assert.equal(toWhatsAppDialNumber(junk), null, `unreadable input ${JSON.stringify(junk)} opens no chat`);
  }
  assert.ok(!isDialableWhatsApp("nonsense"), "an unreadable number is not dialable");
  assert.equal(formatDialNumberForDisplay("01012345678"), "+20 10 1234 5678", "the number reads back grouped the way an Egyptian mobile is written");
  assert.equal(formatDialNumberForDisplay("+44 7700 900123"), "+447700900123", "a non-Egyptian number keeps its own shape");

  // ── The URL ──────────────────────────────────────────────────────────────────────────────
  //
  // THE ENCODING IS THE WHOLE RISK. An unescaped newline, `&` or `#` truncates the message at that
  // character — silently, arriving as a half-written invitation. So the assertions below check that
  // the message SURVIVES A ROUND TRIP, not merely that some encoding happened.

  const message = "Dear Aya\n\n• Time: 1:40 PM & 2 PM\nAddress: المنطقة السياحية\nhttps://maps.app.goo.gl/abc#pin";
  const url = whatsAppSendUrl("01012345678", message);
  assert.ok(url.startsWith("https://wa.me/201012345678?text="), "the link points at the repaired number");
  assert.ok(!url.includes("\n"), "a raw newline would truncate the message");
  assert.ok(!url.includes(" & "), "a raw ampersand would truncate the message");

  const roundTripped = decodeURIComponent(url.slice(url.indexOf("?text=") + "?text=".length));
  assert.equal(roundTripped, message, "the message survives the round trip through the URL exactly");

  assert.equal(whatsAppSendUrl("01012345678", "   "), "https://wa.me/201012345678", "an empty message just opens the chat");
  assert.throws(() => whatsAppSendUrl("nonsense", "hi"), /cannot be opened/i, "an unreadable number is refused, never guessed");

  // ── Draft validation ─────────────────────────────────────────────────────────────────────

  const good = { body: "Dear {{candidate_first_name}}", category: "Interview", isActive: true, name: "Invite", sortOrder: 0 };
  assert.deepEqual(templateDraftViolations(good), [], "a well-formed draft has nothing wrong with it");

  assert.ok(
    templateDraftViolations({ ...good, name: "  " }).some((p) => p.includes("name")),
    "a blank name is refused",
  );
  assert.ok(
    templateDraftViolations({ ...good, body: "" }).some((p) => p.includes("message")),
    "a blank message is refused",
  );

  // THE TYPO THAT SURVIVES EVERY OTHER CHECK and reaches a candidate as literal braces.
  const unclosed = templateDraftViolations({ ...good, body: "Dear {{first_name" });
  assert.ok(unclosed.some((p) => p.includes("not closed")), "an unclosed placeholder is caught while it is still being written");

  const tooLong = templateDraftViolations({ ...good, body: "x".repeat(2001) });
  assert.ok(tooLong.some((p) => p.includes("2000")), "a body past the wa.me URL limit is refused with the number in the message");

  // Every problem at once, so the editor never plays whack-a-mole.
  assert.ok(templateDraftViolations({ body: "", category: "", isActive: true, name: "", sortOrder: 0 }).length >= 2, "all problems are reported together");

  // ── First names ──────────────────────────────────────────────────────────────────────────

  assert.equal(firstNameOf("Aya Mohamed Hassan"), "Aya", "Egyptian names are given-name-first");
  assert.equal(firstNameOf("Aya"), "Aya", "a single-token name returns itself, never an empty greeting");
  assert.equal(firstNameOf("  Aya   Mohamed  "), "Aya", "extra whitespace does not become the name");
  assert.equal(firstNameOf("Mr. Ahmed Nour"), "Ahmed", "an honorific from a CV header is not the first name");
  assert.equal(firstNameOf("Dr Sara Ali"), "Sara", "an honorific without a full stop is also stripped");

  // ── "Dr" before every candidate's first name (owner, 2026-10-20) ─────────────────────────────
  // The GREETING only: candidate_first_name carries it, candidate_name stays the stored name, and an
  // employee (a contract renewal, a salary increase) is greeted by the plain first name.
  assert.equal(candidateGreetingName("Aya Mohamed Hassan"), "Dr Aya", "a candidate is greeted Dr and the first name");
  assert.equal(candidateGreetingName("Dr. Sara Ali"), "Dr Sara", "a CV's own Dr. never doubles");
  assert.equal(candidateGreetingName("SHAABAN ABDELHAKIM"), "Dr Shaaban", "the shout is still softened");
  assert.equal(candidateGreetingName("   "), "", "no name stays empty, so the template still refuses to send \"Dear Dr ,\"");
  const candidateContext = readFileSync("src/lib/recruitment/whatsapp-templates/candidate-context.ts", "utf8");
  assert.match(candidateContext, /candidate_first_name: candidateGreetingName\(fullName\)/, "the template's first name is the titled one");
  assert.match(candidateContext, /candidate_name: fullName,/, "while the full name stays exactly as recorded");
  assert.doesNotMatch(readFileSync("src/lib/recruitment/whatsapp-templates/employee-context.ts", "utf8"), /candidateGreetingName/, "an employee is never titled");

  // ── a SHOUTED name is softened for the greeting, and only for the greeting ───────────────────
  //
  // 160 of 890 production candidates — 18%, measured 2026-09-08 — store an ALL-CAPS first name,
  // because that is how the CV said it. Left alone, nearly one applicant in five opens an interview
  // invitation reading "Dear SHAABAN", which is shouting at somebody you are trying to hire.
  assert.equal(firstNameOf("SHAABAN ABDELHAKIM MOHAMMED ABDELHAFZ"), "Shaaban", "an ALL-CAPS name is softened");
  assert.equal(firstNameOf("MONA YOUSSEF SAYED"), "Mona", "the commonest shouted shape");
  assert.equal(firstNameOf("Mr. AHMED NOUR"), "Ahmed", "the honorific goes first, then the shout is softened");
  assert.equal(
    firstNameOf("ABDEL-RAHMAN HASSAN"),
    "Abdel-Rahman",
    "an internal separator keeps its capital — Abdel-rahman is a different mistake, not a fix",
  );

  // THE HALF THAT MATTERS MORE: what it must NOT touch. A blanket title-caser mangles the names it
  // was not aimed at, which is the failure this narrowness exists to avoid — it fires only on a
  // token that is uniformly upper case.
  assert.equal(firstNameOf("McDonald Smith"), "McDonald", "a name already carrying lower case is left exactly as typed");
  assert.equal(firstNameOf("eSSam Ali"), "eSSam", "an unusual capitalisation someone chose is not ours to correct");
  assert.equal(firstNameOf("Thomas Mamdouh Thabet"), "Thomas", "an ordinary name passes through untouched");
  assert.equal(
    firstNameOf("\u0645\u062d\u0645\u062f \u0639\u0628\u062f \u0627\u0644\u0644\u0647"),
    "\u0645\u062d\u0645\u062f",
    "an uncased script has no shout to detect and must fall through unchanged",
  );

  // ── the job title names the role APPLIED FOR, never the one they already hold ────────────────
  //
  // `loadCandidateSendContext` fell back to `current_job_title` when `applied_for_job_title` was
  // absent, which reaches 338 of 890 production candidates (38%). It rendered "your interest in the
  // Senior Product Specialist position at Sato Pharma" to a man whose CURRENT job is Senior Product
  // Specialist elsewhere — naming, as the role we rejected him for, the job he already has. It is
  // silent because the sentence is grammatical and the title is real.
  //
  // The source is asserted rather than the behaviour because the resolver needs a database row: what
  // must never come back is a second `??` reaching for another title column.
  const contextSource = readFileSync("src/lib/recruitment/whatsapp-templates/candidate-context.ts", "utf8");
  const jobTitleLine = contextSource.match(/const jobTitle = [^;]+;/)?.[0] ?? "";
  assert.ok(jobTitleLine.length > 0, "the jobTitle resolver must still be here — re-point this test if it moved");
  assert.ok(
    jobTitleLine.includes("applied_for_job_title"),
    "the job title must come from applied_for_job_title",
  );
  assert.ok(
    !jobTitleLine.includes("current_job_title"),
    "current_job_title must NEVER be a fallback here — it names the job the candidate already holds "
      + "at another company, and a rejection that cites it tells them we turned them down for their "
      + "own job. An absent applied-for title must leave this EMPTY so the send is refused and a "
      + `human types the real one. Found: ${jobTitleLine}`,
  );

  // ── the offer link: direction, and refuse-rather-than-guess ─────────────────────────────────
  //
  // `ats_applications.offer_id` existed from the day the table was created and NOTHING wrote it —
  // 0 of 14 production rows on 2026-09-08 — so an offer letter and the candidate it was written for
  // had never been connected. The bridge now stores it, and the start date is read back through it.
  //
  // 🔴 THE DIRECTION IS THE WHOLE DESIGN, and it is what these assertions defend.
  // `src/lib/offers/types.ts` carries the owner's instruction that the offers module is independent
  // of recruitment — an offer may go to somebody who never entered the ATS, and "the two must not be
  // merged". The obvious implementation (a candidate_id column on `offers`) breaks that; the pointer
  // therefore lives on the recruitment side and `offers` learns nothing.
  const contextSrc = readFileSync("src/lib/recruitment/whatsapp-templates/candidate-context.ts", "utf8");
  const routeSrc = readFileSync("app/api/recruitment/applications/[id]/offer-letter/route.ts", "utf8");

  assert.match(
    contextSrc,
    /from "@\/lib\/offers\/service"/,
    "the start date is read through the offers module's own getOffer — recruitment -> offers is the permitted direction",
  );

  // The reverse import is the breach. Nothing under src/lib/offers/ may reach into recruitment.
  for (const file of ["src/lib/offers/service.ts", "src/lib/offers/types.ts"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(
      !/from "@\/lib\/recruitment/.test(src),
      `${file} must never import from recruitment — the offers module is deliberately independent `
        + '(owner: "the two must not be merged"), and an offer may be issued to somebody who never '
        + "entered the ATS",
    );
    assert.ok(
      !/candidate_id/.test(src),
      `${file} must not learn that a candidate id exists — the pointer lives on the recruitment side`,
    );
  }

  // BOTH branches of the bridge store the link. It reuses an existing draft as often as it creates
  // one, and an application whose letter was reused is exactly as linked as one whose letter is new.
  const linkCalls = routeSrc.match(/recordApplicationOfferLetter\(/g) ?? [];
  assert.equal(
    linkCalls.length,
    2,
    "the bridge must store the link on BOTH branches — the created letter and the reused draft. "
      + `Found ${linkCalls.length}. Storing only one leaves a gap that reads as "no offer yet".`,
  );

  // NEVER matched by name or email. Measured 2026-09-08 on the three live offers: 0 of 3 matched a
  // candidate by email, 1 of 3 by name. A wrong match puts the wrong first working day into a
  // welcome message, so only the stored pointer may be trusted.
  // THE WHOLE START-DATE PATH, not one function. Since 2026-09-28 there are TWO stored pointers and
  // the resolver reads them through a helper each: `ats_candidates.offer_id` first — the one that can
  // answer for an offer written to somebody with no application, which is most of them — then
  // `ats_applications.offer_id` as the fallback. Slicing at the first helper and taking everything to
  // the end of the resolver keeps this assertion on the real path rather than on whichever function
  // happens to hold the query today. The direction and the preference are pinned in
  // tests/candidate-offer-pointer.test.ts, which owns that decision.
  const resolverStart = contextSrc.indexOf("async function candidateOfferId");
  const resolverEnd = contextSrc.indexOf("export type CandidateSendContext");
  assert.ok(
    resolverStart > 0 && resolverEnd > resolverStart,
    "the start-date resolution path must still be here — re-point this test if it moved",
  );
  const resolver = contextSrc.slice(resolverStart, resolverEnd);
  assert.ok(
    resolver.includes("offer_id"),
    "the start date must be resolved through a stored offer_id pointer",
  );
  for (const forbidden of ["candidate_name", "candidate_email", "full_name", "ilike"]) {
    assert.ok(
      !resolver.includes(forbidden),
      `the resolver must never match an offer by ${forbidden} — free-text matching put the wrong `
        + "start date in reach, and only the stored pointer is trustworthy",
    );
  }

  // ── the joining document list, read live from the checklist ──────────
  //
  // THE ONE THAT MATTERS: `hiring_document_definitions` IS NOT A LIST OF THINGS A CANDIDATE BRINGS.
  // It is the whole personnel file, and on production 2026-09-08 eight of its sixteen slots are
  // papers the COMPANY generates - six of them EXIT paperwork. Built from every active row, a
  // "document request" asks somebody who has just accepted a job to bring their own resignation
  // request, their own mutual-termination agreement and their own end-of-service clearances.
  //
  // That message is grammatical, the slot names are real, and nothing errors. This fixture is the
  // exact production shape so the assertion below fires on the real thing rather than on a sketch.
  const PRODUCTION_SLOTS = [
    { hiringPackDocument: null, id: "d-nid", name: "National ID copy" },
    { hiringPackDocument: null, id: "d-birth", name: "Birth certificate" },
    { hiringPackDocument: null, id: "d-grad", name: "Graduation certificate" },
    { hiringPackDocument: null, id: "d-mil", name: "Military status" },
    { hiringPackDocument: null, id: "d-crim", name: "Criminal record" },
    { hiringPackDocument: null, id: "d-bank", name: "Bank account details" },
    { hiringPackDocument: "form1", id: "d-form1", name: "Social insurance form" },
    { hiringPackDocument: "contract", id: "d-contract", name: "Signed employment contract" },
    { hiringPackDocument: "nda", id: "d-nda", name: "Signed confidentiality undertaking" },
    { hiringPackDocument: null, id: "d-med", name: "Medical check" },
    { hiringPackDocument: "form6", id: "d-form6", name: "Signed social insurance Form 6" },
    { hiringPackDocument: "resignation", id: "d-resign", name: "Signed resignation request" },
    { hiringPackDocument: "mutualTermination", id: "d-mutual", name: "Signed mutual termination agreement" },
    { hiringPackDocument: "clearanceEmployee", id: "d-clr-emp", name: "Signed employee clearance" },
    { hiringPackDocument: "clearanceCompany", id: "d-clr-co", name: "Signed company clearance" },
  ];

  assert.deepEqual(
    selectCandidateSuppliedNames(PRODUCTION_SLOTS, []),
    [
      "National ID copy",
      "Birth certificate",
      "Graduation certificate",
      "Military status",
      "Criminal record",
      "Bank account details",
      "Medical check",
    ],
    "only the papers a person supplies themselves - every slot a company paper files into is out",
  );

  for (const exitPaper of [
    "Signed resignation request",
    "Signed mutual termination agreement",
    "Signed employee clearance",
    "Signed company clearance",
    "Signed social insurance Form 6",
  ]) {
    assert.ok(
      !selectCandidateSuppliedNames(PRODUCTION_SLOTS, []).includes(exitPaper),
      `"${exitPaper}" is EXIT paperwork the company issues - asking a new hire to bring it is the `
        + "failure this filter exists to prevent, and it reads as a working message",
    );
  }

  // THE SECOND HALF OF THE FILTER. A company template can file under a slot from the other
  // direction, and that slot then carries a company paper while `hiring_pack_document` is still
  // NULL. Nothing matches this today - it is the case that arrives the first time somebody uploads
  // a company template, with no error to announce itself.
  assert.deepEqual(
    selectCandidateSuppliedNames(PRODUCTION_SLOTS, ["d-med"]),
    [
      "National ID copy",
      "Birth certificate",
      "Graduation certificate",
      "Military status",
      "Criminal record",
      "Bank account details",
    ],
    "a slot a custom company template files under drops out too, though its own column is NULL",
  );

  // THE NAME IS NEVER THE MECHANISM. `name` is admin-editable free text, so renaming a slot must
  // change what the message SAYS and never which slots it lists.
  const renamedSlots = PRODUCTION_SLOTS.map((slot) =>
    slot.id === "d-nid" ? { ...slot, name: "National ID (new wording)" } : slot,
  );
  assert.equal(
    selectCandidateSuppliedNames(renamedSlots, []).length,
    selectCandidateSuppliedNames(PRODUCTION_SLOTS, []).length,
    "renaming a slot changes the wording, never the membership - the column is the mechanism",
  );
  assert.ok(
    selectCandidateSuppliedNames(renamedSlots, []).includes("National ID (new wording)"),
    "and the new wording is what the candidate is asked for, live, with no template edit",
  );

  // A DEACTIVATED SLOT never reaches the pure filter - `is_active` is applied in the query - so the
  // rule here is only about company papers. "Personal photos" is inactive on production and is
  // deliberately absent from the fixture for that reason.

  // FORMATTING. The bullet is the one the owner's own templates are written with.
  assert.equal(
    formatDocumentList(["National ID copy", "Medical check"]),
    "\u2022 National ID copy\n\u2022 Medical check",
    "one bullet per line, joined with newlines - a block that drops into a message body",
  );

  // AN EMPTY LIST IS A REFUSED SEND, NEVER A HEADING WITH NOTHING UNDER IT. If the checklist cannot
  // be read, the message must not go out saying "we need the following documents:" followed by
  // blank space - the recruiter is asked to type the list instead.
  assert.equal(formatDocumentList([]), "", "an empty list renders as nothing, not as a stray bullet");
  const emptyListRender = renderTemplate("We need:\n\n{{document_list}}\n\nThanks", {
    document_list: formatDocumentList([]),
  });
  assert.deepEqual(
    emptyListRender.missing,
    ["document_list"],
    "an unreadable checklist blocks the send and asks for the list, rather than sending an empty one",
  );

  assert.ok(
    isAutoVariable("document_list"),
    "the list is auto-filled - a recruiter never retypes seven bullet points that the system holds",
  );

  // THE SEND PATH MUST NOT CARRY A COPY OF THE LIST. That copy is the whole defect being fixed: a
  // hard-coded list goes stale the moment HR edits the checklist, silently and with no error.
  const docSendPathSource = readFileSync("src/lib/recruitment/whatsapp-templates/candidate-context.ts", "utf8");
  assert.match(
    docSendPathSource,
    /candidateSuppliedDocumentList/,
    "the send context resolves the list live; nothing here may hold a hard-coded copy of it",
  );
  assert.ok(
    !/National ID copy/.test(docSendPathSource),
    "a document name hard-coded in the send path is a second source of truth - the checklist is the only one",
  );

  // ── the employee target, and the probation date ─────────────
  //
  // WHY THE EMPLOYEE TARGET EXISTS. A probationer is not a candidate. Measured on production
  // 2026-09-08: 30 people were inside their 90-day window and exactly ONE had a candidate record
  // carrying a phone number, because nothing links an employee back to the CV they arrived as. A
  // probation message driven off ats_candidates would have been typed by hand 29 times in 30.
  const employeeSource = readFileSync("src/lib/recruitment/whatsapp-templates/employee-context.ts", "utf8");

  assert.ok(
    isAutoVariable("probation_end_date"),
    "the probation end date is auto-filled, so a recruiter never works it out from a hire date",
  );

  // THE DATE IS DERIVED THROUGH THE OWNER-LOCKED HELPER, NEVER READ FROM THE STORED COLUMN.
  // `employees.probation_end_date` is NULL for all 186 production employees and has never been
  // written by anything, so a reader that trusted it would report "no date" for every person alive
  // - which looks like missing data rather than like the wrong source, and would never be traced
  // back to this line.
  assert.match(
    employeeSource,
    /from "@\/lib\/probation\/date"/,
    "the probation end date must come from the locked hire+90 helper, which is the single source of truth",
  );
  assert.ok(
    !/select\([^)]*probation_end_date/.test(employeeSource),
    "employee-context must never SELECT employees.probation_end_date - it is NULL for every employee, "
      + "so trusting it silently blanks the date for everybody",
  );
  assert.ok(
    !/hire_date[^\n]*\+[^\n]*90|addDays|3 months/.test(employeeSource.replace(/\/\/[^\n]*/g, "")),
    "and it must not re-derive hire+90 by hand - the rule is owner-locked in one module so the two "
      + "can never drift",
  );

  // THE NUMBER REPAIR IS LOAD-BEARING HERE, not a nicety. 126 of the 159 employees carrying a mobile
  // number lost the leading zero to a spreadsheet import (production, 2026-09-08), so without the
  // repair four employees in five are undialable and it reads as "no number on file".
  assert.match(
    employeeSource,
    /toWhatsAppDialNumber/,
    "an employee number goes through the Egyptian repair, or 126 of 159 employees cannot be messaged",
  );
  assert.equal(
    toWhatsAppDialNumber("1093216421"),
    "201093216421",
    "a stored number that lost its leading zero is repaired to full international form",
  );

  // AN UNKNOWN HIRE DATE IS A REFUSED SEND, never "your probation ended on —". formatPhoenixLongDate
  // returns an em dash for a null, and rendering that into a message is a hole that looks like text.
  const noDate = renderTemplate("Your probation ended on {{probation_end_date}}.", {
    probation_end_date: "",
  });
  assert.deepEqual(
    noDate.missing,
    ["probation_end_date"],
    "an employee with no hire date blocks the send and asks for the date",
  );
  assert.ok(
    !employeeSource.includes('probationEnd = formatPhoenixLongDate('),
    "the formatter is only reached when a date exists - an unconditional call returns an em dash "
      + "for a null hire date, and the em dash renders as message text rather than as a missing field",
  );

  // ONE VOCABULARY ACROSS BOTH TARGETS. A candidate and an employee answer the SAME auto keys, so a
  // template written once works for either. The moment the two key sets differ, a template has to be
  // written twice and the day they drift is the day one is missing a fix the other got.
  const candidateSource = readFileSync("src/lib/recruitment/whatsapp-templates/candidate-context.ts", "utf8");
  for (const key of ["candidate_first_name", "candidate_name", "company_name", "job_title", "sender_name", "probation_end_date", "start_date", "document_list"]) {
    assert.ok(
      candidateSource.includes(`${key}:`),
      `the candidate path must answer every auto key, including ${key} - a key it omits is a type `
        + "hole that renders as undefined",
    );
    assert.ok(
      employeeSource.includes(`${key}:`),
      `the employee path must answer every auto key, including ${key}`,
    );
  }

  // 🔴 THE EMPLOYEE TARGET CARRIES ITS OWN PERMISSION. This branch resolves a staff member's name,
  // job title and MOBILE NUMBER. `recruitment:update` - the gate the rest of this endpoint runs on -
  // does not cover employee records, so without a second check any recruiter could read the whole
  // directory's mobile numbers one hr_id at a time through a template endpoint.
  for (const routeFile of [
    "app/api/recruitment/whatsapp-templates/route.ts",
    "app/api/recruitment/whatsapp-templates/send/route.ts",
  ]) {
    const routeSource = readFileSync(routeFile, "utf8");
    assert.match(
      routeSource,
      /assertPermission\(access, "employees", "read"\)/,
      `${routeFile} must gate the employee target on employees:read - the recruitment gate does not `
        + "cover staff records, and this branch returns a mobile number",
    );
    assert.match(
      routeSource,
      /if \(employeeHrId\) await assertPermission/,
      `${routeFile} must check BEFORE loading the employee, not after - a check that runs after the `
        + "read has already done the thing it was meant to prevent",
    );
  }

  // ── which templates a CV screen is offered ──────────────────────────
  //
  // A probation template opened from a CV was refused rather than sent with a hole, which was safe
  // but left two rows a recruiter could never use. They are no longer offered there.

  assert.ok(
    requiresEmployeeTarget("Your probation ended on {{probation_end_date}}."),
    "a body needing the probation date can only be filled from an employee record",
  );
  assert.ok(
    !requiresEmployeeTarget("Dear {{candidate_first_name}}, your interview is on {{interview_date}}."),
    "an ordinary candidate template is unaffected",
  );
  assert.ok(
    !requiresEmployeeTarget("Dear {{candidate_first_name}}\n\n{{document_list}}"),
    "document_list is filled on BOTH paths, so it must not push a template off the CV screen",
  );

  const variablesSource = stripComments(
    readFileSync("src/lib/recruitment/whatsapp-templates/variables.ts", "utf8"),
  );
  const routeSource = readFileSync("app/api/recruitment/whatsapp-templates/route.ts", "utf8");
  for (const [label, source] of [["variables.ts", variablesSource], ["the templates route", stripComments(routeSource)]]) {
    // TWO SHAPES, because one operator is not the rule. Written as `=== "Probation"` an earlier
    // version of this assertion caught it; written the natural way for a filter,
    // `!== "Probation"`, the same assertion sailed through and reported category-keyed code as
    // clean. So: any comparison against a template's category, and the bare category literal.
    //
    // NOT a blanket ban on the word. `variables.ts` legitimately carries the human label
    // "Probation end date", and forbidding the word outright fails on correct code — which is how
    // a pinning test ends up deleted rather than obeyed.
    assert.ok(
      !/\.category\s*[!=]==/.test(source),
      `${label} must not branch on a template's category — a category is admin-editable free text, `
        + "and renaming it from the template editor would silently put an unfillable template back "
        + "on the CV screen. The placeholders a body uses decide what can be filled.",
    );
    assert.ok(
      !/["'`]Probation["'`]/.test(source),
      `${label} must not name the "Probation" category as a literal — same reason: the category is `
        + "a label the owner can rename, not a mechanism",
    );
  }

  // ONLY the candidate screen filters. The template MANAGER calls this route with no target and must
  // keep every template, because it is where they are written: a template hidden from its own editor
  // cannot be edited, switched off, or deleted.
  assert.match(
    routeSource,
    /const templates = candidateId/,
    "the filter is conditional on a candidate being named",
  );
  assert.ok(
    !/includeInactive[^\n]*requiresEmployeeTarget|requiresEmployeeTarget[^\n]*includeInactive/.test(routeSource),
    "the manager path (includeInactive, no target) must never be filtered",
  );

  // The employee screen keeps everything too - hiding candidate-flavoured templates there is a
  // separate question nobody has asked, and doing it silently would be a second rule pretending to
  // be this one.
  assert.ok(
    !/employeeHrId[^\n]*requiresEmployeeTarget/.test(routeSource),
    "the employee target is not filtered by this rule",
  );

  // ── the contract renewal date ────────────────────────────────────
  //
  // 🔴 THE CONTRACTS DASHBOARD AND THIS MESSAGE ASK DIFFERENT QUESTIONS, and answering the second
  // with the first is the defect this pins. `renewalDateForEmployee` falls back to
  // `nextContractAnniversary(hireDate)` so the dashboard always has something to sort and colour by.
  // Measured on production 2026-09-09: `employee_contracts` holds ZERO rows and
  // `employees.contract_renewal_date` is NULL for all 105 active employees — so 100% of the dates
  // that dashboard shows are that computed anniversary, and none of them is a recorded fact.
  //
  // Fine on a screen HR reads as "renewals are due around here". Not fine in a message that states
  // it back to the employee as their contract date. `date-rules.ts` claims no policy for the
  // anniversary; contrast `probation/date.ts`, which opens by naming hire+90 as an owner-locked
  // business rule. One is a rule, the other a convenience, and only the rule may be asserted.
  const contractsSource = readFileSync("src/lib/contracts/service.ts", "utf8");
  const contractResolver = contractsSource.match(/export async function recordedContractRenewalDate[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(contractResolver.length > 0, "the recorded-date contractResolver must still be here — re-point this test if it moved");
  assert.ok(
    !contractResolver.includes("nextContractAnniversary"),
    "the message's date must never come from the hire-date anniversary — that is the dashboard's "
      + "display fallback, carrying 100% of production, and stating it to an employee asserts a "
      + "contract date nobody recorded",
  );
  assert.ok(
    !/hireDate|hire_date/.test(contractResolver),
    "and it must not reach the hire date by another name either",
  );

  const employeeSrc = readFileSync("src/lib/recruitment/whatsapp-templates/employee-context.ts", "utf8");
  assert.match(
    employeeSrc,
    /recordedContractRenewalDate/,
    "the send context asks the contracts module what is RECORDED, and nothing else",
  );
  assert.ok(
    !employeeSrc.includes("nextContractAnniversary"),
    "the send path must not compute an anniversary of its own",
  );

  // AN UNRECORDED DATE IS A TYPED FIELD, not a guess. Today that is every employee.
  const noContract = renderTemplate("due for renewal on {{contract_renewal_date}}.", {
    contract_renewal_date: "",
  });
  assert.deepEqual(
    noContract.missing,
    ["contract_renewal_date"],
    "with no recorded contract the send screen asks a human for the date rather than inventing one",
  );

  // EMPLOYEE-ONLY, so it never reaches a CV screen: a candidate has no contract at all.
  assert.ok(
    requiresEmployeeTarget("renewal on {{contract_renewal_date}}"),
    "a contract template is not offered on the CV screen — a candidate has no contract to renew",
  );
  assert.ok(
    isAutoVariable("contract_renewal_date"),
    "it is an auto key, so it fills in by itself the day contracts are actually recorded",
  );

  // Both context paths answer it, per the one-vocabulary rule pinned above.
  for (const source of [employeeSrc, readFileSync("src/lib/recruitment/whatsapp-templates/candidate-context.ts", "utf8")]) {
    assert.ok(
      source.includes("contract_renewal_date:"),
      "both the candidate and employee paths must answer the key — an omitted one is a type hole "
        + "that renders as undefined",
    );
  }

  // ── audience: the template that says nothing about who it is for ─────────────
  //
  // A salary increase has NO employee-only placeholder: the amount and the effective month are both
  // typed, because nothing in the database records that a raise happened or when. Every field in it
  // is answerable for a candidate, so the derived rule offers it on the CV screen — where a
  // recruiter could send a serving employee's pay rise to a job applicant. Nothing errors. The
  // message is simply wrong, and it cannot be recalled.
  const salaryBody = "Dear {{candidate_first_name}}, your salary is now {{new_salary}} from {{effective_month}}.";

  assert.ok(
    !requiresEmployeeTarget(salaryBody),
    "the derived rule CANNOT see this one — that is the gap the audience column exists to close, and "
      + "this assertion is what stops someone deleting the column as redundant",
  );
  assert.ok(
    !templateAllowedForCandidate({ audience: "employee", body: salaryBody }),
    "marked employee-only, it is withheld from a candidate screen even though its body looks ordinary",
  );
  assert.ok(
    templateAllowedForCandidate({ audience: "any", body: salaryBody }),
    "and an unmarked template with an ordinary body is still offered — the column defaults to 'any', "
      + "so adding it changed nothing about the templates that existed before it",
  );

  // EITHER SIGNAL IS SUFFICIENT, and the derived one still stands on its own.
  assert.ok(
    !templateAllowedForCandidate({ audience: "any", body: "ends on {{probation_end_date}}" }),
    "an employee-only FIELD still withholds a template that is not marked",
  );

  // ONE-WAY, deliberately: no value of audience can make a template MORE widely offered than its
  // body allows. Without this, marking a probation template 'any' would put it back on the CV screen.
  for (const audience of ["any", "employee", undefined, "nonsense"]) {
    assert.ok(
      !templateAllowedForCandidate({ audience, body: "on {{contract_renewal_date}}" }),
      `audience=${String(audience)} must not widen a template whose body needs an employee record`,
    );
  }

  // 🔴 THE LIST FILTER IS UX; THE SEND ROUTE IS THE BOUNDARY. Hiding a template from the screen does
  // not stop a POST naming a candidateId and that template's id. For a salary increase every field
  // is typed, so nothing downstream would refuse it — the refusal has to be explicit and on the
  // server, which is the same rule as "system-navigation hiding a link is UX only".
  const sendRouteSrc = readFileSync("app/api/recruitment/whatsapp-templates/send/route.ts", "utf8");
  assert.match(
    sendRouteSrc,
    /if \(candidateId && !templateAllowedForCandidate\(template\)\)/,
    "the SEND route must refuse an employee-only template aimed at a candidate — filtering the list "
      + "is a screen decision and stops nobody posting directly",
  );

  // The store must READ the column, or every template silently reads as its default.
  const storeSrc = readFileSync("src/lib/recruitment/whatsapp-templates/store.ts", "utf8");
  assert.match(storeSrc, /audience/, "the store selects and maps the audience column");
  assert.match(
    storeSrc,
    /TEMPLATE_COLUMNS = "[^"]*audience/,
    "audience is in the SELECT list — a mapper reading a column the query never asked for gets "
      + "undefined for every row, which is the failure that looks like the feature working",
  );

  // And the STORED name is never rewritten — an identity field is evidence, not display text.
  assert.equal(
    softenShoutedName("SHAABAN"),
    "Shaaban",
    "the softener is a pure function on a COPY of the token; ats_candidates.full_name is untouched",
  );
}
