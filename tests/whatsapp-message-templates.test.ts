import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  variableLabel,
} from "../src/lib/recruitment/whatsapp-templates/variables.ts";

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
  const resolver = contextSrc.match(/async function resolveOfferStartDate[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(resolver.length > 0, "the start-date resolver must still be here — re-point this test if it moved");
  assert.ok(
    resolver.includes("offer_id"),
    "the start date must be resolved through the stored offer_id pointer",
  );
  for (const forbidden of ["candidate_name", "candidate_email", "full_name", "ilike"]) {
    assert.ok(
      !resolver.includes(forbidden),
      `the resolver must never match an offer by ${forbidden} — free-text matching put the wrong `
        + "start date in reach, and only the stored pointer is trustworthy",
    );
  }

  // And the STORED name is never rewritten — an identity field is evidence, not display text.
  assert.equal(
    softenShoutedName("SHAABAN"),
    "Shaaban",
    "the softener is a pure function on a COPY of the token; ats_candidates.full_name is untouched",
  );
}
