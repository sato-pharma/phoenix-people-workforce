import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classifyTextOnlyEnquiry,
  textOnlyReplyText,
} from "../src/lib/recruitment/inbound/whatsapp-text-only-applicant.ts";

// The auto-reply on the advertised WhatsApp line answered a question nobody had asked.
//
// Every text-only message got the same words — "to apply, send your CV as a file" — including the
// one person in the first ten who actually asked us something: "قريت الاعلان ... وكنت عايز اعرف
// التفاصيل ايه" (I read the advert and wanted to know what the details are). He asked what the job
// was; Phoenix told him how to attach a document. From outside the company that reads as nobody
// being home, on a number printed across live job adverts.
//
// The corpus this is built on, measured on production 2026-08-29/30 — the first ten real text-only
// messages the channel ever recorded: SEVEN pure greetings, one naming a role and area, one
// announcing an attachment, and exactly ONE question. So the greeting path is the common case and
// must not regress, while the question path is the defect.
//
// What this pins:
//   1. the classifier catches a real question, in Arabic as it is actually typed, and does not
//      fire on a plain greeting;
//   2. BOTH replies still carry the file instruction — the question variant answers first and asks
//      second, it never drops the ask; and
//   3. the reply invents NOTHING. This message goes to a member of the public in the company's
//      name, and `ats_requisitions` held five rows on 2026-08-30 with no open Medical
//      Representative — so the live campaign exists nowhere in this database and there is no
//      source for a salary, a deadline or a requirement. A future session wiring one in from a
//      model, or from memory, is what assertion 3 exists to stop.

const APPLICANT_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/recruitment/inbound/whatsapp-text-only-applicant.ts", import.meta.url)),
  "utf8",
);

const NOTIFY_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/recruitment/inbound/recruitment-notify.ts", import.meta.url)),
  "utf8",
);

export async function runWhatsAppReplyAnswersTheQuestionTests(): Promise<void> {
  // ── 1. A real question is recognised ───────────────────────────────────────
  // The first entry is verbatim from production (wamid recorded 2026-08-30). The rest are the
  // shapes the same intent arrives in — Egyptian colloquial spelling, both alef forms, both
  // question marks, and English from the applicants who write in it.
  const questions = [
    "السلام عليكم قريت الاعلان بتاع الوظيفه وكنت عايز اعرف التفاصيل ايه",
    "ممكن اعرف تفاصيل الوظيفة؟",
    "عاوز اعرف المرتب كام",
    "إيه شروط التقديم",
    "ما هي المطلوب للوظيفة؟",
    "أريد أن أعرف معلومات عن الوظيفة",
    "What are the details of the Gharbia 1 vacancy?",
    "hello, can you tell me about the salary package",
    "which area are you hiring in",
    "Is this still open?",
  ];
  for (const question of questions) {
    assert.equal(
      classifyTextOnlyEnquiry(question),
      "asked_about_the_job",
      `a question must be answered as one, not instructed at: ${question}`,
    );
  }

  // ── 2. A greeting is still a greeting ──────────────────────────────────────
  // Seven of the first ten. If these started taking the long reply the fix would be noise, not a
  // fix — so the common case is pinned as hard as the rare one.
  const greetings = [
    "السلام عليكم",
    "مساء الخير",
    "صباح الخير",
    "Hello",
    "hi",
    "MR Gharbia1 Tanta",
    "ازيك يا فندم",
    "لو سمحت",
  ];
  for (const greeting of greetings) {
    assert.equal(
      classifyTextOnlyEnquiry(greeting),
      "plain",
      `a greeting must get the short reply, not a job briefing: ${greeting}`,
    );
  }

  // An empty or absent body is a greeting, never a question — it must never produce the longer
  // message. `handleTextOnlyMessage` passes `body: string | null` straight through.
  assert.equal(classifyTextOnlyEnquiry(null), "plain", "a null body is not a question");
  assert.equal(classifyTextOnlyEnquiry(undefined), "plain", "an absent body is not a question");
  assert.equal(classifyTextOnlyEnquiry("   \n  "), "plain", "whitespace is not a question");

  // Arabic normalisation is what makes the keyword list work against a real phone keyboard: the
  // same word arrives with different alef forms, with a ta-marbuta or a ha, and with diacritics.
  assert.equal(classifyTextOnlyEnquiry("عايز اعرف التفاصيل"), "asked_about_the_job");
  assert.equal(classifyTextOnlyEnquiry("عايز أعرف التفاصيل"), "asked_about_the_job", "hamza is folded");
  assert.equal(classifyTextOnlyEnquiry("عَايز اعرف التفاصيل"), "asked_about_the_job", "diacritics are stripped");
  assert.equal(classifyTextOnlyEnquiry("عايز اعرف التفاصيلَ"), "asked_about_the_job");

  // ── 3. Both replies keep the instruction that recovers a photographed CV ───
  // `ignored_unsupported_attachment` is 20 events from 5 people — CVs photographed rather than
  // attached. The ask is the second-largest recovery on this channel and must survive BOTH paths.
  const plain = textOnlyReplyText("plain");
  const answered = textOnlyReplyText("asked_about_the_job");
  for (const [name, reply] of [
    ["plain", plain],
    ["asked_about_the_job", answered],
  ] as const) {
    assert.ok(/[؀-ۿ]/.test(reply), `${name}: the reply speaks Arabic — that is what applicants write in`);
    assert.ok(reply.includes("PDF"), `${name}: it names the formats that work`);
    assert.ok(reply.includes("Word"), `${name}: both formats, not just PDF`);
    assert.ok(/photo/i.test(reply), `${name}: it rules out the photographed CV`);
    assert.ok(reply.includes("‏⚠️ الصورة الفوتوغرافية"), `${name}: the Arabic warning is present verbatim`);
    const arabicIndex = reply.search(/[؀-ۿ]/);
    assert.ok(arabicIndex < reply.indexOf("Thanks"), `${name}: Arabic comes first, not buried under English`);
  }

  // The default is the SHORT one. `textOnlyReplyText()` is called with no argument in older code
  // paths and by any future caller that forgets — the safe default is the message that promises
  // nothing.
  assert.equal(textOnlyReplyText(), plain, "the no-argument default stays the plain reply");

  // ── 4. The question variant answers, and the plain one does not over-answer ─
  assert.ok(
    answered.includes("Medical Representative"),
    "a question about the job is answered with the role we are actually hiring",
  );
  assert.ok(
    answered.includes("مندوبين دعاية طبية"),
    "and answered in Arabic too — the question was asked in Arabic",
  );
  assert.ok(
    /recruitment team will send you the full details/i.test(answered),
    "it says a human sends the specifics, which is the only honest thing this system can promise",
  );
  assert.ok(
    !plain.includes("Medical Representative"),
    "a plain greeting does not get an unsolicited job briefing — 7 of the first 10 messages were greetings",
  );
  assert.ok(answered.length > plain.length, "the answer is the longer message, by construction");

  // ── 5. IT INVENTS NOTHING ─────────────────────────────────────────────────
  // The hard rule. This text is sent to a member of the public in Sato Pharma's name, and nothing
  // in this database describes the live campaign — so any figure here would be fabricated. A
  // currency amount, a numeric requirement, or a deadline appearing in this string is the failure
  // this assertion exists to catch, whoever adds it and however plausible it looks.
  const forbidden: ReadonlyArray<readonly [RegExp, string]> = [
    [/\b\d[\d,]{2,}\b/, "a number that could read as a salary or a headcount"],
    [/EGP|جنيه|ج\.?م/i, "a currency"],
    [/\bsalary is\b|\bالمرتب\s*[:=]/i, "a stated salary"],
    [/deadline|آخر موعد|ينتهي في/i, "a deadline nothing in this system can keep current"],
    [/\byears? of experience\b|\bسنوات خبرة\b/i, "an eligibility rule the recruiters have not agreed"],
  ];
  for (const [pattern, what] of forbidden) {
    assert.ok(
      !pattern.test(answered),
      `the reply must not state ${what} — ats_requisitions has no open Medical Rep row to source it from`,
    );
    assert.ok(!pattern.test(plain), `the plain reply must not state ${what} either`);
  }

  // ── 6. The wiring — the half that can silently regress ────────────────────
  // A classifier nothing calls is dead code, and the reply would quietly stay one-size-fits-all.
  assert.ok(
    /textOnlyReplyText\(classifyTextOnlyEnquiry\(input\.body\)\)/.test(APPLICANT_SOURCE),
    "askForCvFile classifies what they wrote — without this every sender gets the greeting reply again",
  );
  assert.ok(
    /askForCvFile\(\{\s*body: input\.body/.test(APPLICANT_SOURCE),
    "and handleTextOnlyMessage passes the body down; dropping it is silent, since body is optional",
  );

  // The question reply PROMISES a human will follow up. That promise is kept by a person or not at
  // all, so the owner's phone alert has to say a question was asked — otherwise it renders as an
  // ordinary "no CV attached" and the promise goes silently unkept.
  assert.ok(
    /askedAboutTheJob: classifyTextOnlyEnquiry\(input\.body\)/.test(APPLICANT_SOURCE),
    "the notification is told whether they asked a question",
  );
  assert.ok(
    NOTIFY_SOURCE.includes("Someone asked about the job on WhatsApp"),
    "and the alert titles it distinctly, so it is legible on a phone without being opened",
  );
  assert.ok(
    /that part needs a human/.test(NOTIFY_SOURCE),
    "the alert names the obligation the reply created — the details for their area still need answering",
  );
}
