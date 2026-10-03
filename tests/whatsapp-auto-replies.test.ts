import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applyAutoReplyTokens,
  AUTO_REPLY_BODY_MAX,
  AUTO_REPLY_KEYS,
  AUTO_REPLY_META,
  AUTO_REPLY_REQUIRED_TOKENS,
  autoReplyViolations,
  isAutoReplyKey,
  MAX_MB_TOKEN,
  resolveAutoReply,
} from "../src/lib/recruitment/inbound/whatsapp-auto-replies.ts";
import { autoReplyDefault } from "../src/lib/recruitment/inbound/whatsapp-auto-replies-catalogue.ts";
import {
  areaMenu,
  classifyThankYouText,
  CLOSING_INTRO_DEFAULT,
  CLOSING_OUTRO_DEFAULT,
  regionMenu,
} from "../src/lib/recruitment/inbound/whatsapp-classify-menus.ts";
import {
  areaPlaceHints,
  regionPlaceHints,
} from "../src/lib/recruitment/inbound/whatsapp-classify-place-hints.ts";
import { builtInPrompts } from "../src/lib/recruitment/inbound/whatsapp-question-prompts.ts";
import {
  textOnlyReplyDefault,
  textOnlyReplyText,
} from "../src/lib/recruitment/inbound/whatsapp-text-only-applicant.ts";
import {
  unreadableCvReplyDefault,
  unreadableCvReplyText,
} from "../src/lib/recruitment/inbound/whatsapp-unreadable-cv.ts";

// The owner's 2026-10-03 ruling — "i want to be in control to freely edit them through phoenix
// anytime" — made the bot's four automatic replies (and the two editable lines of the closing
// summary) owner-editable, the way the six screening questions already were.
//
// What this pins is everything that would make that feature WORSE than the hard-coded text it
// replaced, because each failure is invisible from this repo and only a member of the public would
// ever see it:
//
//   1. a reworded message reaches the right SITUATION. Swap two keys and an applicant who asked
//      about the job is answered with the message for somebody who asked nothing — a defect no
//      typecheck can see, since both are strings.
//   2. a message can never come out EMPTY. Silence, after somebody sends a photo of their CV, is
//      the exact failure the replies exist to prevent, so blank means "back to the default".
//   3. a message can never come out longer than WhatsApp accepts. Over 4,096 Meta refuses the whole
//      send, so an over-long reply is not untidy — it is an applicant who hears nothing.
//   4. the size limit stays a TOKEN. A reworded too-large reply quoting a fixed "15 MB" sends real
//      people away to shrink a file Phoenix would have accepted the day that setting changes.
//   5. the default text is never copied into the database, so improving it in code still reaches
//      every message nobody has reworded.
//   6. the senders actually LOAD the saved wording. The wiring is the half that silently does
//      nothing: every save would land in the table and no applicant would ever read it.

const SENDER_SOURCES = {
  classifySession: "../src/lib/recruitment/inbound/whatsapp-classify-session.ts",
  store: "../src/lib/recruitment/inbound/whatsapp-auto-replies-store.ts",
  textOnly: "../src/lib/recruitment/inbound/whatsapp-text-only-applicant.ts",
  unreadable: "../src/lib/recruitment/inbound/whatsapp-unreadable-cv.ts",
} as const;

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/**
 * Source with every comment removed.
 *
 * A source assertion is otherwise satisfied by the COMMENT that explains the call: these files
 * document their own wiring in prose that repeats the function name, so `includes("…")` would stay
 * green with the call itself deleted. Strips block comments first, then line comments, and leaves
 * string contents alone — crude, and enough, because nothing asserted below is a `//` inside a
 * string.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The override map the store hands the senders. */
function saved(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

export async function runWhatsAppAutoRepliesTests(): Promise<void> {
  // --- 1. the catalogue is complete, and every key has somewhere for its words to come from ------

  assert.equal(new Set(AUTO_REPLY_KEYS).size, AUTO_REPLY_KEYS.length, "no duplicate reply keys");
  for (const key of AUTO_REPLY_KEYS) {
    assert.ok(AUTO_REPLY_META[key]?.label, `${key} has a label the owner can recognise`);
    assert.ok(AUTO_REPLY_META[key]?.note, `${key} says on screen WHEN it is sent`);
    assert.ok(Array.isArray(AUTO_REPLY_REQUIRED_TOKENS[key]), `${key} declares its required tokens`);
    const fallback = autoReplyDefault(key);
    assert.ok(
      typeof fallback === "string" && fallback.trim().length > 0,
      `${key} resolves to real default words — a blank default would send silence`,
    );
    assert.ok(
      autoReplyViolations({ bodyText: fallback, key }).length === 0,
      `${key}'s own default passes the validator the owner's wording is held to`,
    );
  }
  assert.ok(!isAutoReplyKey("closing"), "a near-miss key is not accepted");
  assert.ok(!isAutoReplyKey(""), "an empty key is not accepted");

  // The defaults are read FROM the senders, never copied. If someone re-types one of these into the
  // catalogue, improving the sender's wording would stop reaching applicants and nothing else would
  // complain.
  // Every assertion below carries a message on purpose: breaking the fix to watch one fire is the
  // only thing that makes a regression test worth having, and a messageless `assert.equal` reports a
  // generated diff that cannot be tied back to the defect it was written for.
  assert.equal(
    autoReplyDefault("text_only_plain"),
    textOnlyReplyDefault("plain"),
    "the plain reply's default comes from its sender, not a copy in the catalogue",
  );
  assert.equal(
    autoReplyDefault("text_only_job_enquiry"),
    textOnlyReplyDefault("asked_about_the_job"),
    "and so does the job-enquiry reply's",
  );
  assert.equal(
    autoReplyDefault("unreadable_photo"),
    unreadableCvReplyDefault("not_recognised"),
    "and the photo reply's",
  );
  assert.equal(
    autoReplyDefault("unreadable_too_large"),
    unreadableCvReplyDefault("too_large"),
    "and the too-large reply's",
  );
  assert.equal(autoReplyDefault("closing_intro"), CLOSING_INTRO_DEFAULT, "and the summary's first line");
  assert.equal(autoReplyDefault("closing_outro"), CLOSING_OUTRO_DEFAULT, "and its last line");

  // --- 2. with nothing saved, every message is byte-identical to the text it replaced ------------

  assert.equal(
    textOnlyReplyText("plain"),
    textOnlyReplyDefault("plain"),
    "no override means the code wording, unchanged",
  );
  assert.equal(textOnlyReplyText(), textOnlyReplyDefault("plain"), "the no-argument default is still the plain reply");
  assert.equal(
    textOnlyReplyText("plain", saved({})),
    textOnlyReplyDefault("plain"),
    "an empty override map is not an override",
  );
  assert.equal(
    textOnlyReplyText("plain", saved({ text_only_plain: "   " })),
    textOnlyReplyDefault("plain"),
    "a whitespace-only saved row falls back to the default — the bot never sends blank",
  );
  assert.equal(
    textOnlyReplyText("plain", null),
    textOnlyReplyDefault("plain"),
    "a null override map (the shape a failed read produces) keeps the default",
  );

  // --- 3. a saved message reaches the right SITUATION, and only it -------------------------------

  const plainOverride = "‏ابعت السيرة الذاتية ملف PDF.\n\nPlease send your CV as a PDF file.";
  assert.equal(
    textOnlyReplyText("plain", saved({ text_only_plain: plainOverride })),
    plainOverride,
    "the saved plain reply is what a plain message is answered with — reading it under another key is the defect this names",
  );
  assert.equal(
    textOnlyReplyText("asked_about_the_job", saved({ text_only_plain: plainOverride })),
    textOnlyReplyDefault("asked_about_the_job"),
    "rewording the plain reply leaves the job-enquiry reply alone — the two keys are not interchangeable",
  );

  const enquiryOverride = "We are hiring medical reps. Send your CV as a file.";
  assert.equal(
    textOnlyReplyText("asked_about_the_job", saved({ text_only_job_enquiry: enquiryOverride })),
    enquiryOverride,
    "the saved job-enquiry reply is what somebody asking about the job is answered with",
  );
  assert.equal(
    textOnlyReplyText("plain", saved({ text_only_job_enquiry: enquiryOverride })),
    textOnlyReplyDefault("plain"),
    "and the reverse: the job-enquiry wording never answers somebody who asked nothing",
  );

  const photoOverride = "Please send the CV as a document, not a photo.";
  assert.equal(
    unreadableCvReplyText("not_recognised", undefined, saved({ unreadable_photo: photoOverride })),
    photoOverride,
    "the saved photo reply answers an unreadable picture",
  );
  assert.ok(
    unreadableCvReplyText("too_large", 15 * 1024 * 1024, saved({ unreadable_photo: photoOverride })).includes("15 MB"),
    "rewording the photo reply leaves the too-large reply on its own default",
  );

  // --- 4. the file-size token ---------------------------------------------------------------------

  assert.ok(
    unreadableCvReplyDefault("too_large").includes(MAX_MB_TOKEN),
    "the too-large default carries the token rather than a fixed number",
  );
  assert.ok(
    !unreadableCvReplyDefault("not_recognised").includes(MAX_MB_TOKEN),
    "and the photo reply, which quotes no limit, does not",
  );
  const atTwentyFive = unreadableCvReplyText("too_large", 25 * 1024 * 1024);
  assert.ok(atTwentyFive.includes("25 MB"), "the default is filled with the limit in force");
  assert.ok(!atTwentyFive.includes(MAX_MB_TOKEN), "and no token is left standing in a sent message");
  assert.ok(
    unreadableCvReplyText("too_large").includes("15 MB"),
    "with no limit passed, the default ceiling is quoted",
  );

  // An override goes through the SAME token, which is the whole reason it is required of one.
  const tokenised = `‏الملف كبير. أقل من ${MAX_MB_TOKEN} ميجابايت.\n\nToo large — keep it under ${MAX_MB_TOKEN} MB.`;
  const rendered = unreadableCvReplyText("too_large", 8 * 1024 * 1024, saved({ unreadable_too_large: tokenised }));
  assert.ok(rendered.includes("8 MB"), "the owner's own wording is filled with the live limit too");
  assert.ok(!rendered.includes(MAX_MB_TOKEN), "with nothing left to leak to the applicant");

  assert.deepEqual(
    AUTO_REPLY_REQUIRED_TOKENS.unreadable_too_large,
    [MAX_MB_TOKEN],
    "the too-large reply is the one message with a required token",
  );
  const missingToken = autoReplyViolations({
    bodyText: "Your file was too large — please send it under 15 MB.",
    key: "unreadable_too_large",
  });
  assert.equal(missingToken.length, 1, "a too-large reply with a hard-coded number is refused");
  assert.ok(
    missingToken[0].includes(MAX_MB_TOKEN),
    "and the refusal names the token to write, rather than saying only that it is wrong",
  );
  assert.equal(
    autoReplyViolations({ bodyText: tokenised, key: "unreadable_too_large" }).length,
    0,
    "the same message with the token is accepted",
  );
  // Belt and braces on the filler itself: an unknown token is left visible rather than blanked.
  assert.equal(
    applyAutoReplyTokens("under {maxMb} MB", {}),
    "under {maxMb} MB",
    "a token with no value is left visible — somebody reports that, where 'under  MB' reads as sloppy copy nobody owns",
  );
  assert.equal(
    applyAutoReplyTokens("{maxMb} and {maxMb}", { maxMb: 9 }),
    "9 and 9",
    "every occurrence is filled, not only the first — the Arabic and English halves each carry one",
  );

  // --- 5. length, and the refusals that keep a message sendable ----------------------------------

  const atMax = "x".repeat(AUTO_REPLY_BODY_MAX);
  assert.equal(
    autoReplyViolations({ bodyText: atMax, key: "closing_intro" }).length,
    0,
    "exactly at the ceiling is allowed",
  );
  const overMax = autoReplyViolations({ bodyText: `${atMax}x`, key: "closing_intro" });
  assert.equal(overMax.length, 1, "one character over is refused");
  assert.ok(
    overMax[0].includes(String(AUTO_REPLY_BODY_MAX)),
    "and the refusal states the limit, so the owner knows how much to cut",
  );
  assert.equal(
    autoReplyViolations({ bodyText: "", key: "closing_intro" }).length,
    0,
    "blank is NOT a violation — it is the reset gesture, which the store turns into a row delete",
  );
  assert.equal(
    autoReplyViolations({ bodyText: "anything", key: "not_a_reply" }).length,
    1,
    "an unknown key is refused rather than silently stored",
  );

  // --- 6. the closing summary: the owner's lines move, the recorded answers do not ---------------

  const summary = classifyThankYouText({
    areaName: "Tanta",
    backgroundLabel: "Pharmacy",
    expectedSalary: "12000",
    experienceLabel: "1-2 years",
    overrides: saved({ closing_intro: "Your application is in.", closing_outro: "We will call you." }),
    regionLabel: "Delta",
    roleLabel: "Medical Representative",
  });
  const summaryLines = summary.split("\n");
  assert.equal(summaryLines[0], "Your application is in.", "the first line is the owner's");
  assert.equal(summaryLines[summaryLines.length - 1], "We will call you.", "and so is the last");
  // The generated middle is NOT editable, and that is the safety property: a free-typed copy of
  // these lines could tell somebody their application was recorded against a role they never chose.
  assert.ok(summary.includes("Role: Medical Representative"), "the role line still comes from the answer");
  assert.ok(summary.includes("Region: Delta"), "and the region");
  assert.ok(summary.includes("Area: Tanta"), "and the area");
  assert.ok(summary.includes("Expected salary: 12000"), "and the salary they typed");

  const defaultSummary = classifyThankYouText({
    areaName: null,
    backgroundLabel: null,
    expectedSalary: null,
    experienceLabel: null,
    regionLabel: null,
    roleLabel: "Medical Representative",
  });
  assert.ok(defaultSummary.startsWith(CLOSING_INTRO_DEFAULT), "with nothing saved, the code intro is used");
  assert.ok(defaultSummary.endsWith(CLOSING_OUTRO_DEFAULT), "and the code outro");

  // --- 7. resolveAutoReply's own contract --------------------------------------------------------

  assert.equal(
    resolveAutoReply({ fallback: "fallback words", key: "closing_intro", overrides: saved({ closing_outro: "other" }) }),
    "fallback words",
    "a saved row for ANOTHER key never answers for this one",
  );
  assert.equal(
    resolveAutoReply({ fallback: "fallback", key: "closing_intro", overrides: saved({ closing_intro: "  saved  " }) }),
    "saved",
    "a saved message is trimmed, so trailing whitespace cannot reach WhatsApp",
  );

  // --- 8. the wiring: the senders actually load the saved wording --------------------------------
  //
  // Asserted against comment-stripped source. These files explain their own wiring in prose that
  // repeats the function name, so a plain `includes` would stay green with the call deleted.

  const textOnlyCode = stripComments(source(SENDER_SOURCES.textOnly));
  assert.ok(
    /textOnlyReplyText\(\s*classifyTextOnlyEnquiry\(input\.body\),\s*await loadAutoReplyOverrides\(\)\s*\)/.test(
      textOnlyCode,
    ),
    "askForCvFile sends the SAVED wording, classified at the point of sending",
  );

  const unreadableCode = stripComments(source(SENDER_SOURCES.unreadable));
  assert.ok(
    /unreadableCvReplyText\(\s*input\.cause,\s*input\.maxBytes,\s*await loadAutoReplyOverrides\(\)\s*\)/.test(
      unreadableCode,
    ),
    "askForCvAsFile sends the saved wording for whichever cause it is answering",
  );

  const classifyCode = stripComments(source(SENDER_SOURCES.classifySession));
  assert.ok(
    /overrides:\s*await loadAutoReplyOverrides\(\)/.test(classifyCode),
    "the closing summary is built with the saved first and last lines",
  );

  // The store is the one place a bad row could reach an applicant, so it re-checks on the way OUT.
  const storeCode = stripComments(source(SENDER_SOURCES.store));
  assert.ok(
    storeCode.includes("autoReplyViolations"),
    "the store validates a stored row on READ as well as on save — a row hand-edited in SQL must not reach a real applicant",
  );
  assert.ok(
    /\.delete\(\)\.eq\("reply_key"/.test(storeCode),
    "reset DELETES the row rather than storing a copy of the default, which would go stale the day the default improves",
  );

  // Nothing seeds the table: an absent row IS the default, which is what makes reset a delete.
  const migration = source("../supabase/migrations/20261003223324_ats_whatsapp_auto_replies.sql");
  assert.ok(!/insert\s+into/i.test(migration), "the migration seeds no wording at all");
  assert.ok(
    migration.includes("ats_whatsapp_auto_replies_key_check"),
    "and the table refuses a key the code does not know",
  );
  for (const key of AUTO_REPLY_KEYS) {
    assert.ok(migration.includes(`'${key}'`), `${key} is in the table's CHECK constraint`);
  }

  // The route is gated like its two siblings on the same screen. CI's own registry check would also
  // catch an unregistered route, but not that it was registered with the wrong permission.
  const registry = source("../src/lib/security/access-registry.ts");
  const entry = registry
    .split("\n")
    .find((line) => line.includes('pattern: "/api/admin/whatsapp-auto-replies"'));
  assert.ok(entry, "the editor's route is declared in the access registry");
  assert.ok(entry.includes('resource: "recruitment"'), "under recruitment, like the question editors");
  assert.ok(entry.includes("csrfRequired: true"), "and it requires a same-origin mutation");
  // -- EVERY WORD AN APPLICANT READS IS ENGLISH (owner, 2026-10-04) -----------------------------
  //
  // "i want whatsapp replies all to be in english". Before that ruling four of these six replies
  // opened with an Arabic block and the region and area lists carried Arabic second lines, and the
  // tests of the day pinned exactly that ("Arabic comes FIRST"). Those assertions are now inverted
  // rather than removed, and this sweep is what makes the rule hold across the SET: the replies,
  // the questions, the region list and the area lists are built by four different modules, so a
  // per-file check leaves three doors open.
  //
  // It pins the DEFAULTS in code. It deliberately says nothing about a saved override — the owner
  // can word a reply in any language he likes on the Screening Questions screen, which is the
  // feature this file exists for.
  //
  // What the bot READS is untouched: the Arabic enquiry markers in whatsapp-text-only-applicant.ts
  // are how an Arabic question is recognised at all, and they are asserted elsewhere.
  const arabic = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
  const outbound: Array<[string, string | null]> = [];

  for (const key of AUTO_REPLY_KEYS) outbound.push([`reply ${key}`, autoReplyDefault(key)]);

  for (const prompt of builtInPrompts()) {
    outbound.push([`question ${prompt.key} body`, prompt.defaultBody]);
    outbound.push([`question ${prompt.key} list button`, prompt.defaultButtonLabel ?? null]);
    outbound.push([`question ${prompt.key} answer heading`, prompt.defaultSectionTitle ?? null]);
    for (const option of prompt.options) {
      outbound.push([`question ${prompt.key} answer ${option.value} title`, option.defaultTitle]);
      outbound.push([`question ${prompt.key} answer ${option.value} second line`, option.defaultDescription ?? null]);
    }
  }

  for (const [code, hint] of Object.entries(regionPlaceHints)) {
    outbound.push([`region ${code} second line`, hint]);
  }
  for (const [name, hint] of Object.entries(areaPlaceHints)) {
    outbound.push([`area ${name} second line`, hint]);
  }

  // The menus as actually BUILT, not only their ingredients: the second lines are wrapped and the
  // titles substituted on the way out, so this is the shape WhatsApp is handed.
  const builtMenus = [regionMenu(), areaMenu("CA", Object.keys(areaPlaceHints))];
  for (const menu of builtMenus) {
    outbound.push(["menu body", menu.body]);
    outbound.push(["menu button", menu.buttonLabel]);
    outbound.push(["menu heading", menu.sectionTitle]);
    for (const row of menu.rows) {
      outbound.push([`menu row ${row.id} title`, row.title]);
      outbound.push([`menu row ${row.id} second line`, row.description ?? null]);
    }
  }

  const inArabic = outbound.filter(([, text]) => typeof text === "string" && arabic.test(text));
  assert.deepEqual(
    inArabic.map(([where]) => where),
    [],
    `every word a WhatsApp applicant reads must be ENGLISH (owner, 2026-10-04) — these are not: ${
      inArabic.map(([where, text]) => `${where} = ${JSON.stringify(text)}`).join(" | ")
    }`,
  );

  // The sweep must actually be LOOKING at something. Without this, deleting a surface above would
  // make the rule pass by covering nothing — the failure mode a "no bad rows" assertion always has.
  assert.ok(
    outbound.length >= 150,
    `the sweep must cover every outbound surface, not an empty list — it read ${outbound.length} strings`,
  );
  assert.ok(
    outbound.some(([where]) => where.startsWith("reply ")) &&
      outbound.some(([where]) => where.startsWith("question ")) &&
      outbound.some(([where]) => where.startsWith("region ")) &&
      outbound.some(([where]) => where.startsWith("area ")) &&
      outbound.some(([where]) => where.startsWith("menu ")),
    "and all five kinds of outbound string are in it: the replies, the questions, the region hints, the area hints, and the built menus",
  );
}
