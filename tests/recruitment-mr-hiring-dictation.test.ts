import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The owner, 7 Nov 2026: "in all the comments section in this module … make the same mic [as the Phoenix
// CRM visit form] so I can talk and it is written instead of me typing." And 8 Nov 2026: "when I talk first,
// it fix … the spelling and the grammar … rephrase it into professional corporate language."

import { appendDictated } from "../src/lib/phoenix-crm/dictation.ts";
import {
  MR_DICTATE_KEEP_OWN,
  MR_DICTATE_KEPT,
  MR_DICTATE_LABEL,
  MR_DICTATE_POLISHED,
  MR_DICTATE_POLISHING,
  mrDictationMessage,
} from "../src/lib/recruitment/mr-hiring/dictation.ts";
import {
  buildMrPolishPrompt,
  findMrPolishViolations,
  mrNumberTokens,
  mrPolishLimit,
  normalizeSpoken,
  sanitizeMrPolished,
  westernDigits,
} from "../src/lib/recruitment/mr-hiring/polish.ts";
import { MR_BOOKING_NOTES_LIMIT, MR_COMMENT_LIMIT } from "../src/lib/recruitment/mr-hiring/vocabulary.ts";
import { stripComments } from "./support/comment-strip.ts";

const codeOnly = (path: string) => stripComments(readFileSync(path, "utf8"));

export function runRecruitmentMrHiringDictationTests() {
  // EVERY comment box of the module carries the microphone — a new box without one fails here.
  const forms = codeOnly("src/components/recruitment/mr-hiring/mr-forms.tsx");
  const boxes = forms.match(/<textarea\b/g) ?? [];
  const mics = forms.match(/<MrDictate\b/g) ?? [];
  assert.ok(boxes.length >= 3, "the result comment, the recommendation note and the interviewer's notes are all here");
  assert.equal(mics.length, boxes.length, "every comment box in Medical Rep hiring has the microphone under it");
  for (const [kind, limit, setter, value] of [
    ["result", "MR_COMMENT_LIMIT", "setComment", "comment"],
    ["recommendation", "MR_COMMENT_LIMIT", "setNote", "note"],
    ["booking", "MR_BOOKING_NOTES_LIMIT", "setNotes", "notes"],
  ]) {
    assert.match(
      forms,
      new RegExp(`<MrDictate candidateId=\\{[\\w.]+\\} disabled=\\{busy\\} kind="${kind}" limit=\\{${limit}\\} onChange=\\{${setter}\\} value=\\{${value}\\} />`),
      `${kind}: the microphone writes into its own box, within the box's own cap, for this candidate`,
    );
  }

  // THE SAME MIC as the CRM visit form: its engine, not a second one.
  const mic = codeOnly("src/components/recruitment/mr-hiring/mr-dictate.tsx");
  assert.match(mic, /startDictation\(/, "the CRM visit form's own speech engine");
  assert.match(mic, /useSyncExternalStore\(noSubscribe, isDictationSupported, \(\) => false\)/, "no microphone is drawn where the browser has no engine");
  assert.doesNotMatch(mic, /MediaRecorder|startRecording|getUserMedia/, "it writes words; it records nothing");
  assert.equal(MR_DICTATE_LABEL, "Speak");
  assert.match(mic, /onChange\(\(current\) => \{\s*const next = appendDictated\(current, text, limit\);/, "each phrase is APPENDED to what was typed, within the cap");

  // THEN PROFESSIONALLY REWRITTEN — after Stop, only what was said in that turn, never what was typed before.
  assert.match(mic, /onEnd: \(\) => \{[^}]*void polish\(\);/, "pressing Stop sends the words to be rewritten professionally");
  assert.match(mic, /\/api\/recruitment\/mr-hiring\/\$\{encodeURIComponent\(candidateId\)\}\/polish/, "to this candidate's own gated route");
  assert.match(mic, /\{ kind, spoken \}\)/, "only the spoken words and the kind of box are sent");
  assert.match(mic, /if \(!text \|\| latest\.current !== spokenValue\) return;/, "a box edited while the words were away keeps what he typed");
  assert.match(mic, /appendDictated\(before\.current, text, limit\)/, "what was typed before Speak stays in front, unchanged");
  assert.match(mic, /onChange\(undo\.spokenValue\)/, "Keep my own words puts the spoken words back");
  for (const words of [MR_DICTATE_POLISHING, MR_DICTATE_POLISHED, MR_DICTATE_KEEP_OWN, MR_DICTATE_KEPT]) {
    assert.doesNotMatch(words, /\b(ai|gpt|chatgpt|openai|model|generated|record)/i, `"${words}" never names a model or promises a recording`);
  }

  // The route: the TA fence, then only someone who reads this journey and can write on it — never the CEO.
  const route = codeOnly("app/api/recruitment/mr-hiring/[candidateId]/polish/route.ts");
  const fence = route.indexOf("assertCandidateVisible(access, candidateId)");
  const gate = route.indexOf("assertMayPolishMrWords(access, candidateId)");
  const call = route.indexOf("polishMrSpokenWords(");
  assert.ok(fence > 0 && gate > fence && call > gate, "the fence and the journey gate are asked before the paid call");
  const server = codeOnly("src/lib/recruitment/mr-hiring/server.ts");
  assert.match(
    server,
    /assertMayPolishMrWords[\s\S]{0,200}if \(viewer\.isCeo && !viewer\.canWork\) throw forbiddenError[\s\S]{0,200}await readableMrRecord\(access, candidateId\)/,
    "the CEO records nothing, and anyone outside the journey is told the candidate is not there",
  );

  // The rewrite's guards — pure.
  assert.equal(westernDigits("١٥٠٠٠ و ۳"), "15000 و 3");
  assert.deepEqual(mrNumberTokens("15,000 / 15000.00 / ١٥٠٠٠"), ["15000", "15000", "15000"]);
  assert.deepEqual(findMrPolishViolations("The proposed salary is EGP 15,000.", "المرتب ١٥٠٠٠"), [], "a number said in Arabic digits is the same number written");
  assert.match(findMrPolishViolations("The candidate has 15 years of experience.", "عنده خبرة كويسة").join(" "), /never said \(15\)/, "an invented number fails the rewrite");
  assert.match(findMrPolishViolations("This note was rewritten by ChatGPT.", "كويس").join(" "), /how it was written/, "never says how it was written");
  assert.deepEqual(findMrPolishViolations("The candidate suits the AI line.", "ينفع في خط ال AI"), [], "\"AI\" the speaker said is the Anti Infective line, his to keep");
  assert.deepEqual(findMrPolishViolations("   ", "x"), ["it came back empty"]);
  // A small number said as a word, and a number said with ألف, are the speaker's own (owner, 8 Nov 2026:
  // "it doesn't change anything" — refusing them threw whole rewrites away).
  assert.deepEqual(findMrPolishViolations("The candidate rated the interview 4 out of 5.", "اربعة من خمسة"), [], "a small number said as a word");
  assert.deepEqual(findMrPolishViolations("The expected salary is EGP 15,000.", "متوقع 15 ألف"), [], "15 ألف is 15,000");
  assert.match(findMrPolishViolations("The expected salary is EGP 18,000.", "متوقع 15 ألف").join(" "), /never said \(18000\)/, "a salary that was not said still fails the rewrite");

  // THE STRONG TIER, CLAUDE SONNET FIRST (owner, 8 Nov 2026: "put an Anthropic Sonnet agent … very weak").
  const polish = codeOnly("src/lib/recruitment/mr-hiring/polish.ts");
  assert.match(polish, /anthropicModel: ANTHROPIC_STRONG_MODEL,/, "Claude Sonnet writes it");
  assert.match(polish, /preferProvider: "anthropic",/, "Claude is asked first");
  assert.match(polish, /model: OPENAI_STRONG_MODEL,/, "never the nano tier, even when OpenAI answers");
  assert.match(polish, /route: "\/ai\/recruitment\/mr-hiring-dictation-polish\/refused"/, "a refused rewrite leaves a row");
  // The Egyptian pharma hiring words (owner's screenshot, 8 Nov 2026: امتياز came back as "franchise").
  assert.match(polish, /امتياز[^\n]*internship year[^\n]*never \\"franchise\\"/, "امتياز is the internship year");
  assert.match(polish, /تكليف[^\n]*government assignment/, "تكليف is the government assignment");
  // THE SPEAKER'S OWN LANGUAGE (owner, 8 Nov 2026: "I needed to be able to understand Egyptian Arabic and
  // enhance the Egyptian Arabic … هو عربي مصري ده الاساسي, وبيبقى في كلام انجلش في النص"): Arabic speech comes back
  // as professional Arabic with the English work terms in English letters, never translated into English.
  assert.match(polish, /Spoken mainly in Arabic → write it in clear, professional written Arabic/, "Arabic said stays Arabic");
  assert.match(polish, /English work term the speaker used in English letters/, "attitude, language, accent stay in English letters");
  assert.match(polish, /Never translate the whole comment into the other language\./, "never translated into the other language");
  assert.doesNotMatch(polish, /Always English|leave no Arabic word/, "the old English-only rule is gone");
  // GLUED WORDS ARE NEVER A NAME (owner, 8 Nov 2026: "fix the glued هي بنت mishearing"): the speech engine
  // wrote «هي بنت» as «نهيبنت» and the rewrite kept it as the candidate's name.
  assert.match(polish, /نهيبنت is \\"هي بنت\\"[^\n]*never a name/, "a made-up glued word is split, never kept as a name");
  assert.equal(sanitizeMrPolished('"**The candidate** communicates clearly."', "result"), "The candidate communicates clearly.");
  const long = sanitizeMrPolished("The candidate is confident. ".repeat(60), "booking");
  assert.ok(long.length <= mrPolishLimit("booking") && long.endsWith("confident.") && !long.includes("…"), "cut at a whole sentence inside the box's cap, never an ellipsis");
  assert.equal(mrPolishLimit("booking"), MR_BOOKING_NOTES_LIMIT);
  assert.equal(mrPolishLimit("result"), MR_COMMENT_LIMIT);
  assert.equal(normalizeSpoken("  كويس   جدا \n", "result"), "كويس جدا");
  const prompt = buildMrPolishPrompt("كويس جدا", "recommendation");
  assert.match(prompt, /National Sales Manager/, "the register follows the box");
  assert.match(prompt, /كويس جدا/);

  // Nothing is recorded here, so no sentence may promise a recording; each names the way out.
  for (const code of ["language-not-supported", "not-allowed", "audio-capture", "network"]) {
    const message = mrDictationMessage(code);
    assert.doesNotMatch(message, /record/i, `${code}: never says a recording is kept`);
    assert.match(message, /type the comment/i, `${code}: typing is always the way out`);
  }

  // Appended within the cap, never replacing.
  assert.equal(appendDictated("Good communication.", " يتكلم بثقة ", MR_COMMENT_LIMIT), "Good communication. يتكلم بثقة");
  assert.equal(appendDictated("x".repeat(MR_BOOKING_NOTES_LIMIT), "more", MR_BOOKING_NOTES_LIMIT).length, MR_BOOKING_NOTES_LIMIT, "a full box stays as it was");
}
