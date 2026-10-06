import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HOUSE_COLORS } from "../src/lib/hiring-pack/house-identity.ts";
import {
  CEO_ASSIST_INSTRUCTIONS,
  buildCeoAssistPrompt,
  effectiveCeoGuard,
  figuresLostFromBody,
  findCeoAssistViolations,
  parseCeoAssistIntent,
} from "../src/lib/ceo-email/assist.ts";
import {
  CEO_DICTATION_DEFAULT_LANGUAGE,
  CEO_DICTATION_LANGUAGES,
  CEO_DICTATION_MAX_SECONDS,
  dictationExtension,
  normalizeCeoDictationLanguage,
} from "../src/lib/ceo-email/dictation-limits.ts";
import {
  CEO_DEFAULT_CLOSING,
  CEO_TITLE_AR,
  CEO_TITLE_EN,
  normalizeCeoClosing,
  pickCeoSignature,
} from "../src/lib/ceo-email/identity.ts";
import { ceoLetterDate, renderCeoEmail } from "../src/lib/ceo-email/render.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE CEO EMAIL COMPOSER — the four things about it that must not rot.
 *
 * Owner 2026-10-06: "a module thats called ceo email composr exactly as sato email composer copy
 * paste but a more corporate templete a more capable ai assist that the ceo can type what he wants
 * any language or even open the mic … if the ceo asked to type he understand if asked to polish he
 * understand and tghe templete is wiith the signature of the ceo".
 *
 * Granting that wish removed the two mode buttons the Sato composer has, and those buttons were
 * carrying a safety decision: Write judged a draft leniently, Rewrite judged it strictly. With the
 * buttons gone, the only thing left choosing the strict guard is the model's own report of what it
 * thought it was doing — which is exactly the kind of thing that must not be the last line of
 * defence on a letter mailed to the whole company over the chief executive's name.
 *
 * So the first block here pins the STRUCTURAL FLOOR that sits under the model's report, and the rest
 * pin the signature's provenance, the letterhead's locked look, and the mic's any-language path.
 */

/**
 * Source with its prose comments taken out.
 *
 * A source assertion is otherwise satisfied by the comment that documents the call — the long
 * explanations in these files name every symbol this test looks for, so a check against raw text
 * would stay green after the code under it was deleted.
 *
 * 🔴 IT USES THE REPO'S OWN LEXER, NEVER A BLOCK-COMMENT REGEX. `/\/\*[\s\S]*?\*\//g` cannot tell a
 * comment from a string: `access-registry.ts` holds route patterns ending in a slash-star glob, each
 * of which opens a "comment" running to the next close marker dozens of lines below — it deletes 62%
 * of that file, and it reported all eight declarations below as missing on the first run here.
 * `tests/support/comment-strip.ts` scans for string and template state instead, and
 * `tests/comment-strip-ratchet.test.ts` exists to stop the naive version coming back.
 */
function sourceWithoutComments(path: string): string {
  return stripComments(readFileSync(new URL(path, import.meta.url), "utf8"));
}

export function runCeoEmailAssistTests() {
  // -- the floor: a figure he wrote that the draft no longer states ---------------------------

  const wroteFigures = {
    bodyHtml: "<p>The plant produced 41,000 packs in September against a target of 38,500.</p>",
    instruction: "make this a proper letter",
    subject: "September output",
  };

  assert.deepEqual(
    figuresLostFromBody(
      { bodyHtml: "<p>September output reached 41000 packs against a 38500 target.</p>", subject: "September" },
      wroteFigures.bodyHtml,
    ),
    [],
    "a rewrite that keeps both figures loses none — the comma is a spelling, not a value",
  );

  assert.deepEqual(
    figuresLostFromBody(
      { bodyHtml: "<p>September output was ahead of target.</p>", subject: "September" },
      wroteFigures.bodyHtml,
    ).sort(),
    ["38500", "41000"],
    "a draft that drops his figures and says 'ahead of target' instead must report both as lost",
  );

  assert.deepEqual(
    figuresLostFromBody({ bodyHtml: "<p>anything at all</p>", subject: "x" }, "<p>No figures here.</p>"),
    [],
    "a body with no figures in it can lose none — an empty page is free to be written on",
  );

  // -- the floor overrides the model's own report of what it was doing ------------------------

  assert.equal(
    effectiveCeoGuard("polish", { bodyHtml: "<p>anything</p>", subject: "x" }, { bodyHtml: "<p>anything</p>" }),
    "strict",
    "working on his own words is judged strictly",
  );
  assert.equal(
    effectiveCeoGuard("translate", { bodyHtml: "<p>anything</p>", subject: "x" }, { bodyHtml: "<p>anything</p>" }),
    "strict",
    "a translation is his words in another language, so it is judged strictly too",
  );
  assert.equal(
    effectiveCeoGuard("write", { bodyHtml: "<p>a new letter</p>", subject: "x" }, { bodyHtml: "" }),
    "reporting",
    "writing onto an empty page has nothing of his to contradict",
  );

  // 🔴 THE HEADLINE OF THIS FILE. The model said "write" — i.e. "this was a blank page, judge me
  // leniently" — while the body it was handed carried two figures that are now gone. The floor is
  // what catches that, and it is language-independent and model-honesty-independent.
  assert.equal(
    effectiveCeoGuard(
      "write",
      { bodyHtml: "<p>September was a strong month for the plant.</p>", subject: "September" },
      { bodyHtml: wroteFigures.bodyHtml },
    ),
    "strict",
    "a 'write' that silently dropped figures he had written must be judged STRICTLY anyway",
  );

  // -- the refusals that hold in every intent and under either guard --------------------------

  const lostAnyway = findCeoAssistViolations({
    candidate: { bodyHtml: "<p>September was a strong month.</p>", subject: "September output" },
    guard: "reporting",
    intent: "write",
    sender: wroteFigures,
  });
  assert.ok(
    lostAnyway.some((violation) => /figures you had written are missing \(41000, 38500\)/.test(violation)),
    `losing his own figures must be refused even under the lenient guard, got ${JSON.stringify(lostAnyway)}`,
  );

  const namedIt = findCeoAssistViolations({
    candidate: { bodyHtml: "<p>This letter was drafted with AI assistance.</p>", subject: "September output" },
    guard: "reporting",
    intent: "write",
    sender: { bodyHtml: "", instruction: "write something about September", subject: "September output" },
  });
  assert.ok(
    namedIt.some((violation) => /named the assistant/.test(violation)),
    `a reader must never learn a model was involved, got ${JSON.stringify(namedIt)}`,
  );

  const mintedLink = findCeoAssistViolations({
    candidate: {
      bodyHtml: '<p>Details are on <a href="https://example.com/policy">the policy page</a>.</p>',
      subject: "September output",
    },
    guard: "reporting",
    intent: "write",
    sender: { bodyHtml: "", instruction: "write something about September", subject: "September output" },
  });
  assert.ok(
    mintedLink.some((violation) => /links nobody wrote/.test(violation)),
    `an address nobody wrote must be refused, got ${JSON.stringify(mintedLink)}`,
  );

  const emptyBack = findCeoAssistViolations({
    candidate: { bodyHtml: "   ", subject: "   " },
    guard: "reporting",
    intent: "write",
    sender: { bodyHtml: "", instruction: "write something", subject: "" },
  });
  assert.ok(
    emptyBack.some((violation) => /empty body/.test(violation)),
    `an empty draft is a failure, not a result, got ${JSON.stringify(emptyBack)}`,
  );
  assert.ok(
    emptyBack.some((violation) => /no subject/.test(violation)),
    `a letter with no subject is a failure too, got ${JSON.stringify(emptyBack)}`,
  );

  // -- translation compares the NUMBER of gaps, never their text ------------------------------

  const arabicSender = {
    bodyHtml: "<p>The new shift pattern starts on [effective date] across [the two sites].</p>",
    instruction: "اكتبها بالعربي",
    subject: "Shift pattern",
  };

  const honestTranslation = findCeoAssistViolations({
    candidate: {
      bodyHtml: "<p>يبدأ نظام الورديات الجديد في [تاريخ السريان] في [الموقعين].</p>",
      subject: "نظام الورديات",
    },
    guard: "strict",
    intent: "translate",
    sender: arabicSender,
  });
  assert.deepEqual(
    honestTranslation,
    [],
    "a translation translates the gaps too, so comparing their TEXT would refuse every correct translation",
  );

  const filledOneIn = findCeoAssistViolations({
    candidate: {
      bodyHtml: "<p>يبدأ نظام الورديات الجديد في 1 نوفمبر في [الموقعين].</p>",
      subject: "نظام الورديات",
    },
    guard: "strict",
    intent: "translate",
    sender: arabicSender,
  });
  assert.ok(
    filledOneIn.some((violation) => /filled in 1 of the gaps/.test(violation)),
    `a translation that decided the date for him must be refused, got ${JSON.stringify(filledOneIn)}`,
  );

  // Outside translation, a filled gap is named by its own text, which is the more useful message.
  const filledInEnglish = findCeoAssistViolations({
    candidate: {
      bodyHtml: "<p>The new shift pattern starts on 1 November across [the two sites].</p>",
      subject: "Shift pattern",
    },
    guard: "strict",
    intent: "polish",
    sender: arabicSender,
  });
  assert.ok(
    filledInEnglish.some((violation) => /gaps it filled in by itself \(\[effective date\]\)/.test(violation)),
    `a rewrite that filled a gap must name it, got ${JSON.stringify(filledInEnglish)}`,
  );

  // -- the intent is read, never trusted as a free string -------------------------------------

  assert.equal(parseCeoAssistIntent("write"), "write");
  assert.equal(parseCeoAssistIntent("translate"), "translate");
  assert.equal(parseCeoAssistIntent("document"), "document");
  assert.equal(
    parseCeoAssistIntent("whatever-the-model-said"),
    "polish",
    "an unknown intent falls back to POLISH, the one that is judged strictly — never to write",
  );
  assert.equal(parseCeoAssistIntent(undefined), "polish", "a missing intent falls back strict as well");

  // -- the contract actually reaches the model ------------------------------------------------

  const instructions = CEO_ASSIST_INSTRUCTIONS;
  for (const promise of [
    /never invent a fact/i,
    /square bracket/i,
    /first person/i,
    /dictate/i,
  ]) {
    assert.match(instructions, promise, `the model is never told ${promise}`);
  }
  assert.ok(
    /never write a greeting or a sign-off/i.test(instructions),
    "the letterhead already prints the closing, the name and the office — a sign-off inside the text signs it twice",
  );

  const prompt = buildCeoAssistPrompt({
    bodyHtml: wroteFigures.bodyHtml,
    instruction: "اكتبها بالعربي واعمل جدول بعمودين",
    subject: wroteFigures.subject,
  });
  assert.ok(prompt.includes("اكتبها بالعربي"), "his own instruction must reach the model verbatim");
  assert.ok(prompt.includes("41,000"), "the body he already wrote must reach the model");

  // -- there is no `mode` on the wire ---------------------------------------------------------

  // 🔴 A `mode` the browser could post would hand it the choice of how carefully his own figures are
  // checked, which is the whole thing the floor above exists to take away from it.
  const assistRoute = sourceWithoutComments("../app/api/admin/ceo-email/assist/route.ts");
  assert.ok(
    !/\bmode\b/.test(assistRoute),
    "the assist route must not read a mode from the request — the guard is decided on the server",
  );
  assert.ok(
    /effectiveCeoGuard/.test(sourceWithoutComments("../src/lib/ceo-email/assist.ts")),
    "the guard must be computed by effectiveCeoGuard, not taken from the model's reply",
  );

  // -- the code-fence pattern may not be written as a regex literal ---------------------------
  //
  // 🔴 A BACKTICK INSIDE A REGEX LITERAL BLINDS EVERY COMMENT-ONLY SWEEP BELOW IT. The repo's
  // sanctioned stripper (tests/support/comment-strip.ts) does not track regex literals on purpose,
  // so it reads that backtick as opening a template literal that never closes: every comment after
  // it survives the strip and is handed to the sweep as code. tests/neutral-wording.test.ts, which
  // judges non-comment lines only, reported three of this file's own comments as offenders.
  // Built from a string the backtick is lexed as string content and nothing leaks. This is pinned
  // because the regex literal is the tidier-looking spelling and a later session would restore it.
  const assistSource = readFileSync(new URL("../src/lib/ceo-email/assist.ts", import.meta.url), "utf8");
  assert.ok(
    assistSource.includes('new RegExp("```(?:json)?", "gi")'),
    "the model's code fence must be matched by a RegExp built from a string, never a regex literal",
  );
  const assistComments = stripComments(assistSource).split(/\r?\n/);
  const leaked = assistComments.filter((line) => /^\s*(?:\/\/|\*)\s*\S/.test(line));
  assert.deepEqual(
    leaked,
    [],
    "every comment in this file must survive the strip as blank — a leak means a stray backtick, "
      + "and it makes every comment-only guard read this file's prose as code",
  );
}

export function runCeoEmailSignatureTests() {
  // -- the name comes out of the directory, by seat -------------------------------------------

  const directory = [
    { fullName: "Omar Gawish", jobTitle: "HR Manager" },
    { displayName: "Anwar Gaweesh", fullName: "Anwar Mohamed Gaweesh", jobTitle: "CEO" },
    { fullName: "Someone Else", jobTitle: "National Sales Manager" },
  ];

  const signature = pickCeoSignature(directory);
  assert.equal(signature.name, "Anwar Gaweesh", "the signatory is the person holding the CEO seat");
  assert.equal(signature.fromDirectory, true, "a resolved name must be reported as coming from the directory");
  assert.equal(
    signature.titleEn,
    CEO_TITLE_EN,
    "the letter prints the full office, never the directory's 'CEO' abbreviation",
  );
  assert.equal(signature.titleAr, CEO_TITLE_AR);
  assert.ok(signature.companyEn.length > 0, "the legal person is named in the signature block");

  const noSeat = pickCeoSignature([{ fullName: "Omar Gawish", jobTitle: "HR Manager" }]);
  assert.ok(noSeat.name.length > 0, "a letter must stay signable when the seat cannot be read");
  assert.equal(
    noSeat.fromDirectory,
    false,
    "a fallback name must SAY it is a fallback, so the screen can warn rather than print it silently",
  );

  const blankName = pickCeoSignature([{ fullName: "   ", jobTitle: "CEO" }]);
  assert.equal(
    blankName.fromDirectory,
    false,
    "a seat with no name on it is the same state as no seat — a blank line under a signature rule reads as a fault",
  );

  // -- the closing line is a phrase, and it is all the sender controls ------------------------

  assert.equal(normalizeCeoClosing(""), CEO_DEFAULT_CLOSING, "a cleared field falls back to the house closing");
  assert.equal(normalizeCeoClosing("  With appreciation,  "), "With appreciation", "a trailing comma is the template's");
  assert.equal(normalizeCeoClosing("مع التحية،"), "مع التحية", "an Arabic comma is a comma too");
  assert.equal(
    normalizeCeoClosing('<b onclick="x()">Sincerely</b>'),
    "Sincerely",
    "a closing line is text, never markup — the field must not become a way to put HTML on the letterhead",
  );
  assert.ok(
    normalizeCeoClosing("x".repeat(400)).length <= 60,
    "a paragraph pasted into the closing field is cut to a phrase",
  );

  // -- 🔴 the signature cannot be posted by the browser ---------------------------------------

  // The Super Admin seat can open this screen (see src/lib/ceo-email/access.ts), so a name arriving
  // on the wire would be a name that seat could set, on a letter the company reads as the chief
  // executive's. These three assertions are the whole guarantee.
  const service = sourceWithoutComments("../src/lib/ceo-email/service.ts");
  assert.ok(
    /resolveCeoSignature\(\)/.test(service),
    "the service must resolve the signature itself on every render",
  );
  assert.ok(
    !/signature:\s*draft\./.test(service) && !/draft\.signature/.test(service),
    "the signature must never be read off the posted draft",
  );
  const renderSource = sourceWithoutComments("../src/lib/ceo-email/render.ts");
  assert.ok(
    /signature: CeoSignature/.test(renderSource),
    "the renderer takes a RESOLVED signature — it has no way to read a name out of a draft, which is the point",
  );
}

export function runCeoEmailTemplateTests() {
  const signature = pickCeoSignature([{ fullName: "Anwar Gaweesh", jobTitle: "CEO" }]);
  const { html, text } = renderCeoEmail({
    bodyHtml:
      '<p style="background-color:#ffff00">قرار بشأن مواعيد العمل</p>' +
      "<p>I have decided to move the shift start to 8 AM from 1 November.</p>" +
      '<table><tr><td bgcolor="#eeeeee">Cairo</td></tr></table><script>alert(1)</script>',
    closing: "Sincerely",
    date: "6 October 2026",
    signature,
    subject: "Shift start moves to 8 AM",
  });

  // -- the house document identity ------------------------------------------------------------

  assert.ok(
    html.includes("SATO-DIS-2026-01 v1.0"),
    "every company document wears the Sato standard — AGENTS.md §4, THE DOCUMENT IDENTITY",
  );
  assert.match(
    html,
    /<img src="https:\/\/[^"]+\/brand\/sato-pharma-logo-on-light\.png"/,
    "the mark is the ON-LIGHT png at an absolute https URL — email clients drop data: images",
  );
  // The app's own host name legitimately appears inside the asset URLs — the mark and the ornament
  // are served from this deployment — so the check is on what a READER sees, with every attribute
  // value taken out first. Testing the raw html instead reports the logo's own address as a breach.
  const visible = html.replace(/(?:src|href)="[^"]*"/g, "");
  assert.ok(
    !/Phoenix/i.test(visible),
    "a letter from the chief executive wears the Sato identity, never the app's",
  );

  // -- 🔴 THE INK RULE: no filled areas, and his own pasted ground is stripped ----------------

  assert.ok(
    !/background-color:#ffff00/i.test(html),
    "a highlight he pasted in is stripped by the shared body pipeline — the ink rule reaches his own markup",
  );
  assert.ok(!/bgcolor="#eeeeee"/i.test(html), "a bgcolor attribute is a filled area too");
  assert.ok(!/<script/i.test(html), "the shared sanitizer must still be the one preparing the body");

  // -- 🔴 THE SQUARE-EDGE RULE ----------------------------------------------------------------

  assert.ok(
    !/border-radius/i.test(html),
    "no round or semi-round corners anywhere — AGENTS.md §4, THE SQUARE-EDGE GOLDEN RULE",
  );

  // -- the three things that make this a letter rather than a notice --------------------------

  assert.ok(html.includes("Office of the Chief Executive"), "the masthead says which office is writing");
  assert.ok(html.includes("6 October 2026"), "a chief executive's letter is dated; an announcement is not");
  assert.ok(html.includes("Sincerely,"), "the closing line the sender chose is printed, with the template's comma");
  assert.ok(html.includes("Anwar Gaweesh"), "the resolved name is printed");
  assert.ok(html.includes(CEO_TITLE_EN), "the office is printed under the name");
  assert.ok(html.includes(CEO_TITLE_AR), "and the same office in Arabic, for the bilingual foot");

  // The signature device is a RULE and four lines of type. A tinted card or a bordered panel is what
  // a generic corporate template reaches for, and every one of them is a filled area.
  assert.ok(
    html.includes(`border-top:1px solid ${HOUSE_COLORS.ink}`),
    "the signature sits over the house's own 1px ink rule",
  );
  assert.ok(html.includes('width="200"'), "that rule is signature-width, not column-width");

  // -- an RTL line still sits at the margin it belongs to -------------------------------------

  assert.match(
    html,
    /dir="rtl" lang="ar"[^>]*text-align:left/,
    "dir decides which way the run reads; without the explicit text-align the Arabic office is flung to the far edge away from the English lines it belongs with",
  );

  // -- the frame is still strippable on re-upload ---------------------------------------------

  assert.ok(
    html.includes('class="sato-message"'),
    "the body cell keeps the shared marker on purpose, so unwrapSatoEmailFrame can strip the frame when a sent letter is loaded back in",
  );

  // -- the plain-text twin ---------------------------------------------------------------------

  assert.ok(text.includes("8 AM"), "the text alternative carries the letter's own words");
  assert.ok(!/<[a-z]/i.test(text), "the text alternative carries no markup");

  // -- the date is Cairo local, never UTC -----------------------------------------------------

  // 2026-01-01T00:30:00Z is still 31 December in London and already 2 a.m. on 1 January in Cairo.
  // A letter dated from UTC would be a day behind for every reader of it.
  assert.equal(
    ceoLetterDate(new Date("2026-01-01T00:30:00Z")),
    "1 January 2026",
    "the letter is dated in Africa/Cairo — the owner's standing rule",
  );
  assert.equal(
    ceoLetterDate(new Date("2026-06-30T22:30:00Z")),
    "1 July 2026",
    "and late-evening UTC is already the next day in Cairo",
  );
}

export function runCeoEmailDictationTests() {
  // The extension carries its own dot, because the caller builds a filename out of it and the speech
  // service reads the container from that name.
  assert.equal(dictationExtension("audio/webm"), ".webm");
  assert.equal(
    dictationExtension("audio/webm;codecs=opus"),
    ".webm",
    "a browser sends the codec in the content type — the parameter must be cut before the lookup, or every real recording is refused",
  );
  assert.equal(dictationExtension("audio/mp4"), ".m4a", "Safari records mp4, which is named .m4a for audio");
  assert.equal(dictationExtension(" AUDIO/MPEG "), ".mp3", "the lookup is case- and space-insensitive");
  assert.equal(
    dictationExtension("application/zip"),
    null,
    "the container list is an ALLOWLIST — anything else is refused rather than guessed at",
  );
  assert.equal(dictationExtension(""), null, "a missing content type is refused too");

  assert.ok(
    CEO_DICTATION_MAX_SECONDS >= 60,
    "a dictated letter is minutes of speech, not a voice note",
  );

  // -- 🔴 THE LANGUAGE IS NAMED, NEVER DETECTED, AND THAT IS MEASURED -------------------------

  // Sending the speech service no `language` field makes Whisper TRANSLATE the speech into fluent
  // English — measured in this repo on Egyptian Arabic, and the reason the CRM path hardcodes `ar`.
  // A letter he dictated in Arabic arriving as an English instruction is the worst outcome here,
  // because nothing on screen would look wrong. So he picks from a list and the code is sent.
  assert.deepEqual(
    CEO_DICTATION_LANGUAGES.map((entry) => entry.code),
    ["ar", "en", "fr", "de", "it", "es", "tr"],
    "the languages he may dictate in, as ISO-639-1 codes",
  );
  assert.equal(CEO_DICTATION_DEFAULT_LANGUAGE, "ar", "the mic opens on his own language");
  assert.ok(
    CEO_DICTATION_LANGUAGES.every((entry) => /^[a-z]{2}$/.test(entry.code)),
    "every code is ISO-639-1 — this field is not a locale, so ar-EG, arz and egy are all refused by the API",
  );

  assert.equal(normalizeCeoDictationLanguage("EN"), "en", "the posted code is read case-insensitively");
  assert.equal(normalizeCeoDictationLanguage("  fr "), "fr", "and trimmed");
  assert.equal(
    normalizeCeoDictationLanguage("ar-EG"),
    "ar",
    "a locale tag the API would REFUSE becomes the default rather than losing a three-minute dictation",
  );
  assert.equal(normalizeCeoDictationLanguage("klingon"), "ar", "so does anything else the browser posts");
  assert.equal(normalizeCeoDictationLanguage(undefined), "ar", "and a missing one");

  const dictation = sourceWithoutComments("../src/lib/ceo-email/dictation.ts");
  assert.ok(
    /language: normalizeCeoDictationLanguage\(input\.language\)/.test(dictation),
    "the mic must pass a normalized code — never the browser's string, and never nothing",
  );
  assert.ok(
    !/language:\s*null/.test(dictation),
    "🔴 and never null: omitting the field is what makes Whisper translate him into English",
  );
  assert.ok(
    !/prompt:/.test(dictation),
    "it sends no prompt at all, which removes the prompt-echo failure mode rather than mitigating it",
  );

  // -- the shared client can no longer be asked to omit the field -----------------------------

  const groq = sourceWithoutComments("../src/lib/ai/groq-transcription.ts");
  assert.ok(
    /form\.set\("language", language\)/.test(groq),
    "the language is set unconditionally, so no caller can ask for auto-detect",
  );
  assert.ok(
    /request\.language\?\.trim\(\) \|\| GROQ_TRANSCRIPTION_LANGUAGE/.test(groq),
    "and the CRM's Arabic is the fallback, so its own path is untouched by the CEO mic existing",
  );

  // -- the browser's engine is not used, because it cannot do Arabic everywhere ----------------

  const recorder = sourceWithoutComments("../src/components/admin/assist-dictation.tsx");
  assert.ok(
    !/SpeechRecognition/.test(recorder),
    "the CEO mic records and uploads — Firefox has no engine that does Arabic at all",
  );
  assert.ok(
    /startRecording\(/.test(recorder),
    "it records through the shared recorder and posts the clip to the transcribe route",
  );
  assert.ok(
    /form\.append\("language", language\)/.test(recorder),
    "and it posts the language he picked",
  );
  assert.ok(
    !/rounded/.test(recorder),
    "no round or semi-round corners — AGENTS.md §4, THE SQUARE-EDGE GOLDEN RULE",
  );
  // The cap stops the RECORDER, and only this control collects the clip. If nothing ends the session
  // the screen sits on a dead recorder still showing "Stop" and the dictation is lost. It is ended
  // from the recorder's own tick rather than from an effect watching the counter, because a
  // `setState` inside `useEffect` is a lint error here — the CRM microphone does exactly the same.
  assert.ok(
    /if \(elapsed >= CEO_DICTATION_MAX_SECONDS\) stopRef\.current\(\)/.test(recorder),
    "the cap ends the session from the recorder's tick, so the captured clip is still sent",
  );
  assert.ok(
    !/seconds >= CEO_DICTATION_MAX_SECONDS/.test(recorder),
    "and never from an effect watching the counter, which is where set-state-in-effect bites",
  );

  const route = sourceWithoutComments("../app/api/admin/ceo-email/transcribe/route.ts");
  assert.ok(
    /language: form\.get\("language"\)/.test(route),
    "the route reads the posted language and hands it to the normalizer, rather than trusting it",
  );
}

/**
 * 🔴 THE SECOND SURFACE IN PHOENIX THAT PUTS MAIL IN SOMEBODY'S INBOX — and the only one that signs
 * with the chief executive's name. A sent email cannot be recalled, so the identity it goes out
 * under, the gate it passes through and the privacy of the recipient list are all pinned here, the
 * same way `sato-email-lists-only-composer.test.ts` pins them for its sibling.
 */
export function runCeoEmailSendIdentityTests() {
  const service = sourceWithoutComments("../src/lib/ceo-email/service.ts");
  const settings = sourceWithoutComments("../src/config/system-settings.ts");

  const sendCall = service.slice(service.indexOf("await sendPhoenixEmail({"));
  assert.ok(sendCall.startsWith("await sendPhoenixEmail({"), "the composer must send through sendPhoenixEmail");
  const sendArgs = sendCall.slice(0, sendCall.indexOf("});") + 3);

  // -- the From stays on the send. subdomain ---------------------------------------------------

  // An apex @satopharma.com From was reported verified and every send came back delivered, while
  // email_delivery_events showed 0% opens over 36 sends on the Sato composer: the recipients' own
  // mailboxes live on that apex domain, so mail claiming the same identity from a different relay
  // matches the shape of a spoofed sender. SPF, DKIM and DMARC all passing does not prevent it.
  assert.match(
    settings,
    /ceoComposerFromEmail:\s*"ceo@send\.satopharma\.com"/,
    "the CEO composer's From must sit on the send. subdomain, never the apex the recipients' own mailboxes live on",
  );
  assert.match(
    service,
    /const from = ceoEmailFrom\(systemEmail\.ceoComposerFromEmail, signature\.name\)/,
    "the From is built from the setting and the RESOLVED signature — never from a name on the draft",
  );
  assert.ok(
    !/HR_REPLY_EMAIL_FROM|NOTIFICATION_EMAIL_FROM/.test(service),
    "it must not fall back to the notification sender's From",
  );
  assert.ok(
    !/satoComposerFromEmail|satoComposerReplyToEmail|satoComposerFanoutVisibleTo/.test(service),
    "and it must not borrow the HR composer's addresses — a letter from the chief executive is not from the HR mailbox",
  );

  // -- replies and the visible To are real, deliverable apex mailboxes -------------------------

  // The From subdomain carries no live mailbox, so pointing the fan-out's visible To at it would
  // hard-bounce one recipient on every multi-recipient batch. DMARC keys off the From header and
  // never the To, so an apex address is correct in both of these places.
  assert.match(
    service,
    /const replyTo = systemEmail\.ceoComposerReplyToEmail;/,
    "the Reply-To comes from one setting, for every sender",
  );
  assert.match(
    service,
    /const fanoutVisibleTo = systemEmail\.ceoComposerFanoutVisibleTo;/,
    "the fan-out's visible To must stay a real, deliverable mailbox — never the From subdomain, which has no inbox",
  );
  assert.ok(
    /ceoComposerReplyToEmail:\s*"[^"@]+@satopharma\.com"/.test(settings) &&
      /ceoComposerFanoutVisibleTo:\s*"[^"@]+@satopharma\.com"/.test(settings),
    "both must be apex addresses, which is where a real mailbox is",
  );

  // -- the recipients never see each other ----------------------------------------------------

  assert.ok(
    /fanoutToBcc:\s*true/.test(sendArgs),
    "recipients stay hidden from each other — the owner's choice on the Sato composer, and no less true of a letter from the chief executive",
  );
  assert.ok(/fanoutVisibleTo,/.test(sendArgs), "and the fan-out is given its neutral visible To");

  // -- the confidence gate still runs ----------------------------------------------------------

  // The owner's ruling was that the gate's FAN-OUT hold is for automated mail — "in composer its
  // manual email by human" — and the correct expression of that is to omit `origin`, which makes the
  // fan-out check not-applicable while the gate itself still runs and still records the send. The
  // WRONG expression, and the one a later session reaches for because it reads as the same sentence,
  // is `bypassConfidenceGate: true`, which skips the gate outright.
  assert.ok(
    !/\bbypassConfidenceGate\b/.test(sendArgs),
    "a composer send must NEVER set bypassConfidenceGate — that flag belongs to confidence-gate.ts alone",
  );
  assert.ok(
    !/\borigin\s*:/.test(sendArgs),
    "and it must pass no origin, or the fan-out anomaly check holds a hand-written letter to a large list",
  );

  // -- the send is idempotent under its OWN scope ----------------------------------------------

  // The key is a hash of the request id, the html, the batch and the attachments. Sharing the Sato
  // scope would make two different letters with the same wording collide on retry.
  assert.match(
    service,
    /scope: IDEMPOTENCY_SCOPE/,
    "the idempotency key must carry this composer's own scope",
  );
  assert.match(service, /IDEMPOTENCY_SCOPE = "ceo-email"/, "and that scope is ceo-email");

  // -- an over-budget attachment refuses the WHOLE send ----------------------------------------

  // guardAttachments in send-phoenix-email.ts silently drops one and sends anyway — defensible for a
  // system notification, and completely wrong here: "the paper is attached", over the chief
  // executive's signature, with nothing attached, cannot be recalled.
  const loadIndex = service.indexOf("loadSatoEmailAttachments");
  const sendIndex = service.indexOf("await sendPhoenixEmail({");
  assert.ok(
    loadIndex > -1 && loadIndex < sendIndex,
    "the attachments must be loaded BEFORE any mail leaves, so a problem can refuse the send",
  );
  assert.match(
    service.slice(loadIndex, sendIndex),
    /"problem" in loaded/,
    "and a load problem must fail the send rather than send a letter with nothing attached",
  );
}

/**
 * The CEO composer IS the Sato composer with a variant. Owner 2026-10-06 asked for one "exactly as
 * sato email composer copy paste", and the only way a second screen stays exactly like the first is
 * for it to BE the first — a literal copy drifts on the first fix applied to one of them, and the
 * one left behind is the one that mails the company over the chief executive's signature.
 */
export function runCeoComposerVariantTests() {
  const ceo = sourceWithoutComments("../src/components/admin/ceo-email-composer.tsx");

  assert.ok(
    /from "@\/components\/admin\/sato-email-composer"/.test(ceo),
    "the CEO screen must RENDER the Sato composer, never re-implement it",
  );
  assert.ok(
    ceo.includes('apiBase: "/api/admin/ceo-email"'),
    "and point it at its own routes, which is what keeps the two sends apart",
  );
  assert.ok(ceo.includes('assist: "understood"'), "one box, no mode buttons — the server reads what he asked for");
  assert.ok(ceo.includes("dictation: true"), "the mic is on for this seat");

  // 🔴 Two bundle leaks, each caught once already while this module was being built: both of these
  // limit modules exist ONLY so a client component can read a number the server also reads. Import
  // the parent module instead and the OpenAI client or the Groq client — and the readers of their API
  // keys — are pulled into the browser bundle.
  assert.ok(
    /@\/lib\/ceo-email\/assist-limits/.test(ceo),
    "the instruction cap comes from assist-limits, never from assist.ts, which imports the OpenAI client",
  );
  assert.ok(
    !/@\/lib\/ceo-email\/assist"/.test(ceo),
    "importing assist.ts from a client component would pull the model plumbing into the browser bundle",
  );

  // 🔴 THE HEADING IS THE ONLY PLACE HE LEARNS HOW HE WAS READ, so the mode it branches on must come
  // from the intent the server reported — not from the argument the single "Do it" button passes,
  // which is always "write". Reading that argument labelled a tightening of his own words "Read as:
  // write it", which is precisely the misreading the heading exists to surface.
  const sato = sourceWithoutComments("../src/components/admin/sato-email-composer.tsx");
  assert.match(
    sato,
    /mode: understood\s*\?\s*payload\.result\.intent === "write"\s*\?\s*"write"\s*:\s*"rewrite"/,
    "on the understood variant the reported mode must be derived from the intent, never from the button's argument",
  );

  const recorder = sourceWithoutComments("../src/components/admin/assist-dictation.tsx");
  assert.ok(
    /@\/lib\/ceo-email\/dictation-limits/.test(recorder),
    "the recorder reads its caps from dictation-limits, never from dictation.ts, which imports the Groq client",
  );
  assert.ok(
    !/@\/lib\/ceo-email\/dictation"/.test(recorder),
    "importing dictation.ts from a client component would pull the Groq key's reader into the browser bundle",
  );

  // The CEO routes must be declared, or the required `validate` job goes red on an undeclared route —
  // but a missing declaration is also an unaudited surface, and `send` is one that puts mail in an
  // inbox over the chief executive's name.
  const registry = sourceWithoutComments("../src/lib/security/access-registry.ts");
  for (const route of [
    "assist",
    "document",
    "employees",
    "media",
    "preview",
    "send",
    "templates",
    "transcribe",
  ]) {
    assert.ok(
      registry.includes(`"/api/admin/ceo-email/${route}"`),
      `/api/admin/ceo-email/${route} must be declared in the access registry`,
    );
  }
  assert.match(
    registry,
    /pattern: "\/api\/admin\/ceo-email\/send", permission: null, guard: "domain-helper", csrfRequired: true/,
    "the send route is the one that puts mail in an inbox — it stays audited, gated and same-origin",
  );
}
