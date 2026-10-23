import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GROQ_TRANSCRIPTION_LANGUAGE,
  GROQ_TRANSCRIPTION_MODEL,
  groqTranscriptionMessage,
  GroqTranscriptionError,
  isHallucinatedTranscript,
  stripPromptEcho,
} from "../src/lib/ai/groq-transcription.ts";
import { DICTATION_LANG } from "../src/lib/phoenix-crm/dictation.ts";
import { foldArabicLetters, normalizeArabic } from "../src/lib/phoenix-crm/dictation-correct.ts";
import { PRODUCT_VOCABULARY } from "../src/lib/phoenix-crm/dictation-vocabulary.ts";
import { TRANSCRIPTION_PROMPT } from "../src/lib/phoenix-crm/server/voice-transcribe.ts";
import { KEY_SHAPES, checkSecretShape } from "../scripts/secret-shape-rules.mjs";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix CRM — writing out a visit voice note where the BROWSER cannot (owner, 2026-09-25).
//
// WHY THIS PATH EXISTS. The visit form's microphone runs two halves, and the text half is the browser's
// own free speech engine. Firefox does not have one — not disabled, not behind a flag: there is no
// `SpeechRecognition` constructor on any platform, so a rep on Firefox got the recording and an empty
// comment. Firefox 157 does not fix it either (its on-device engine is NVIDIA's Parakeet, which has no
// Arabic). The owner: "un browsers must be text and audio." So on those browsers the finished RECORDING
// is written out server-side instead.
//
// AND WHY IT IS NOT OPENAI. His cost ruling the same day, in his words: "I don't want it to use it open
// AI or find a free way to use it in it." Groq serves the Whisper models on a free tier, and only the
// engine-less browsers ever reach this path — the Chrome, Edge, Safari and Android majority keep using
// the browser's own engine and never call it. The request below is OpenAI-SHAPED, which is exactly why
// the assertions here are about what it must never be pointed at.
//
// AND WHICH ARABIC IT WRITES. He recorded Egyptian and read the answer back the same day: "very, very,
// very weak in Arabic … it dictate in Khaliji." There is no dialect field to fix that with — `ar-EG`,
// `arz` and `egy` are each refused HTTP 400 "unsupported language" by the live API — so the fix is the
// FULL model plus an Egyptian sample in the prompt, and both are pinned below along with the price of the
// second one: a prompt the decoder can hand back instead of transcribing.
//
// WHAT IS PINNED, and each line is a way this goes wrong while every screen still renders:
//
//   1. IT IS NOT OPENAI AND CANNOT BECOME OPENAI BY CONFIGURATION. The endpoint is written out rather
//      than read from AI_BASE_URL — the variable the sales AI paths use to swap providers — because
//      swapping THIS one would silently reverse the owner's decision, with nothing on any screen saying
//      the bill had moved.
//   2. THE LANGUAGE IS `ar`, NOT `ar-EG`. The same string the browser engine takes is REJECTED here: the
//      field is ISO-639-1, not BCP-47. Leaving it off is worse than wrong — Whisper then translates to
//      English, which returns a fluent comment in the wrong language rather than an error.
//   3. HALLUCINATIONS ARE DROPPED, NOT PASSED ON. Whisper does not fail loudly on silence; it emits
//      subtitle boilerplate, or repeats one phrase until its budget runs out. Either one lands in a
//      clinical record as something a doctor supposedly said.
//   4. THE RECORDING IS FETCHED BY PATH, AND ONLY THE PERSON WHO JUST MADE IT MAY ASK. That is a COST
//      rule, not a privacy one: playback is free and reading a colleague's note is the point of the
//      feature, but transcription is charged per second of audio, so "anything in my scope" would turn
//      one request into a bill for every note a district ever recorded.
//   5. THE KEY'S SHAPE IS CHECKED BEFORE A KEY EXISTS. OPENAI_API_KEY held a masked paste for days and
//      was found only after every AI feature had silently died; this one is pasted into Railway by hand
//      in exactly the same way.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SYNTHETIC, and built at runtime rather than written out, for the reason railway-secret-shape.test.ts
 * already records: gitleaks is a required check here and it flagged a convincing literal in that file's
 * first draft. This has a real key's SHAPE and none of its texture.
 */
const SYNTHETIC_GROQ_KEY = `gsk_${"abcdefghijklmnop".repeat(4)}`;

const CLIENT = "src/lib/ai/groq-transcription.ts";
const SERVICE = "src/lib/phoenix-crm/server/voice-transcribe.ts";
const ROUTE = "app/api/phoenix-crm/voice/transcribe/route.ts";

export function runPhoenixCrmVoiceTranscribeTests() {
  const client = stripComments(readFileSync(CLIENT, "utf8"));
  const service = stripComments(readFileSync(SERVICE, "utf8"));
  const route = stripComments(readFileSync(ROUTE, "utf8"));

  // ── 1. It is Groq, and it cannot be re-pointed at OpenAI by configuration ──────
  // The owner refused OpenAI on cost. A provider-swapping env var reaching this file would move the bill
  // back to the account he said not to use, with nothing on any screen recording that it had moved.
  assert.match(client, /https:\/\/api\.groq\.com\/openai\/v1\/audio\/transcriptions/, `${CLIENT} calls Groq's transcription endpoint`);
  assert.doesNotMatch(client, /AI_BASE_URL|OPENAI_API_KEY|OPENAI_BASE_URL/, `${CLIENT} reads no OpenAI variable and no provider override — the endpoint is fixed on purpose`);
  assert.doesNotMatch(client, /from "openai"|require\("openai"\)/, `${CLIENT} does not import the OpenAI SDK — using it here would put the OpenAI client in the call stack of a feature that must not use OpenAI`);
  assert.doesNotMatch(service, /openai|OPENAI/i, `${SERVICE} names OpenAI nowhere`);
  assert.match(client, /process\.env\.GROQ_API_KEY/, `${CLIENT} reads its own key`);

  // ── 2. The language is the API's, not the browser's ───────────────────────────
  assert.equal(GROQ_TRANSCRIPTION_LANGUAGE, "ar", "the field is an ISO-639-1 language, and `ar` is what it takes");
  assert.notEqual(
    GROQ_TRANSCRIPTION_LANGUAGE,
    DICTATION_LANG,
    "it is NOT the browser engine's ar-EG: that is a BCP-47 locale and this API rejects it, so sharing one constant between the two engines would break whichever one was changed second",
  );
  // 🔴 THE INVARIANT IS "A LANGUAGE IS ALWAYS NAMED", NOT "THE LANGUAGE IS ALWAYS `ar`". On
  // 2026-10-06 the CEO Email Composer's microphone became a second caller and names a language of its
  // own, so `ar` is now the DEFAULT rather than the only value. What must never come back is a code
  // path that sends no `language` field: with it omitted, Whisper translates the speech into fluent
  // ENGLISH text, which reads as a working feature. These three assertions pin that, in both halves —
  // the `set` is unconditional, and the fallback is this constant.
  assert.match(client, /form\.set\("language", language\)/, `${CLIENT} names the language on every path`);
  assert.match(
    client,
    /const language = request\.language\?\.trim\(\) \|\| GROQ_TRANSCRIPTION_LANGUAGE/,
    `${CLIENT} falls back to ${GROQ_TRANSCRIPTION_LANGUAGE} — and uses || so a blank code cannot reach the API empty`,
  );
  assert.doesNotMatch(
    client,
    /if \([^)]*language[^)]*\) form\.set\("language"/,
    `${CLIENT} must not make the language field conditional — omitted, Whisper translates the speech into English`,
  );
  // And the CRM's own caller passes none, which is how it keeps getting `ar`.
  assert.doesNotMatch(service, /language:/, `${SERVICE} names no language, so the client's ${GROQ_TRANSCRIPTION_LANGUAGE} default applies`);
  // 🔴 The FULL model, and the owner's own finding is why. Turbo shipped here first on the reasoning that
  // its accuracy cost was small next to "some text vs no text" — true about the PRESENCE of text and wrong
  // about its KIND. Turbo is the same weights with the decoder distilled 32 layers to 4, and the decoder is
  // where dialect lives: it chooses which Arabic to spell the sounds as. He read the result back as Khaliji.
  assert.equal(GROQ_TRANSCRIPTION_MODEL, "whisper-large-v3", "the FULL model, not turbo — the distilled decoder is what wrote his Egyptian speech back as Gulf Arabic, and it is on the same free tier");
  assert.notEqual(GROQ_TRANSCRIPTION_MODEL, "whisper-large-v3-turbo", "turbo is faster and cheaper and must not come back for either reason: a rep reads the words before saving, so speed buys nothing that being right does not buy more of");
  assert.match(client, /form\.set\("temperature", TEMPERATURE\)/, `${CLIENT} pins the temperature — sampling is what turns an unclear second into an invented sentence`);

  // ── 3. Canned and looping output is dropped ───────────────────────────────────
  // The direction of the error is the whole design, the same as the product corrector's: leaving a rep
  // with nothing costs him the typing he would have done anyway, and handing him a sentence nobody said
  // puts a claim in a clinical record that no one knows to doubt.
  assert.equal(isHallucinatedTranscript(""), true, "nothing at all is not a transcript");
  assert.equal(isHallucinatedTranscript("   "), true);
  assert.equal(isHallucinatedTranscript("اشترك في القناة"), true, "a subscribe line is what Whisper emits over silence, and no rep has ever said it on a call");
  assert.equal(isHallucinatedTranscript("ترجمة نانسي قنقر"), true, "a subtitle credit — the commonest Arabic Whisper hallucination there is");
  assert.equal(isHallucinatedTranscript("Subtitles by the Amara.org community"), true, "and its English twin, matched case-insensitively");
  assert.equal(
    isHallucinatedTranscript("زيارة كويسة الدكتور طلب عينات تيبوفورتين وقال انه هيكتب للاطفال"),
    false,
    "a real visit comment passes — this guard must not be the reason Firefox reps get nothing",
  );
  assert.equal(
    isHallucinatedTranscript("تيبوفورتين تيبوفورتين تيبوفورتين تيبوفورتين تيبوفورتين تيبوفورتين تيبوفورتين تيبوفورتين تيبوفورتين"),
    true,
    "a decoder stuck on one word repeats it past any point a person would",
  );
  assert.equal(
    isHallucinatedTranscript("قابلت الدكتور وقال تيبوفورتين تيبوفورتين كتير للاطفال في العيادة"),
    false,
    "and Egyptian Arabic really does repeat a word for emphasis, so the threshold is deliberately high — a false positive here silently throws away a real comment",
  );
  assert.equal(isHallucinatedTranscript("ايوه ايوه"), false, "a short answer is never judged: there is not enough of it to tell emphasis from a loop");

  // ── The vocabulary primes the decoder, and primes it with ARABIC only ─────────
  // Whisper's `prompt` is preceding CONTEXT, not an instruction — anything imperative written there is
  // transcribed into the answer. And seeding the Latin spellings makes it answer a wholly Arabic sentence
  // in Latin script, which is the rep's own words rewritten into a language he did not use.
  for (const entry of PRODUCT_VOCABULARY) {
    assert.ok(TRANSCRIPTION_PROMPT.includes(entry.arabic), `the prompt carries ${entry.latin} in Arabic — it is the one class of word a general Arabic model has never heard`);
    assert.ok(!TRANSCRIPTION_PROMPT.includes(entry.latin), `the prompt does NOT carry ${entry.latin} in Latin — seeding it makes the model answer an Arabic sentence in Latin script`);
  }
  assert.ok(!/\b(transcribe|write|correct|please|do not)\b/i.test(TRANSCRIPTION_PROMPT), "the prompt gives no instructions — it cannot be instructed, and an instruction written there is transcribed into the comment");

  // ── The prompt is also the ONLY dialect control there is ──────────────────────
  // He speaks Egyptian and got Gulf Arabic back. `language` cannot fix it (`ar-EG`, `arz` and `egy` are
  // each refused HTTP 400 by the live API), so the steer is a sample of Egyptian text the decoder is told
  // came just before the audio — a decoder continuing an Egyptian sentence keeps writing Egyptian.
  for (const marker of ["دلوقتي", "شويه", "اللي", "مش", "عشان", "هيكتب"]) {
    assert.ok(
      TRANSCRIPTION_PROMPT.includes(marker),
      `the prompt carries the Egyptian marker ${marker} — these are the words that mark the dialect in WRITING, which is the only thing a prompt can influence`,
    );
  }
  const sampleAt = TRANSCRIPTION_PROMPT.indexOf("دلوقتي");
  const lastProductAt = Math.max(...PRODUCT_VOCABULARY.map((entry) => TRANSCRIPTION_PROMPT.indexOf(entry.arabic)));
  assert.ok(
    sampleAt > lastProductAt,
    "the Egyptian sample comes LAST, after the product names: the closest preceding text is the strongest influence and dialect is what was wrong, while ending on a comma-separated list biases the answer towards writing a list",
  );
  // The 224-token cap keeps the FINAL tokens of a prompt and drops the ones at the START, silently. Arabic
  // runs about three tokens a word, so this budget keeps both halves inside it with room to spare — and if
  // the cap is ever reached it is the product NAMES, at the head, that go, not the sample at the tail. The
  // order does not protect the names; staying well under the cap does, which is what this pins.
  assert.ok(
    TRANSCRIPTION_PROMPT.length <= 400,
    `the prompt stays well inside the 224-token cap (${TRANSCRIPTION_PROMPT.length} characters) — over it the model drops the HEAD with no error, and the head is the product names`,
  );
  // 🔴 It can be handed back verbatim instead of transcribed, so every claim in it can surface in a comment
  // as something a doctor supposedly said. It therefore states nothing about anybody.
  assert.doesNotMatch(TRANSCRIPTION_PROMPT, /\d/, "the prompt names no quantity — an echoed number in a visit comment is an order nobody placed");
  assert.doesNotMatch(TRANSCRIPTION_PROMPT, /[A-Za-z]/, "the prompt is wholly Arabic — Latin in it makes the model answer an Arabic sentence in Latin script");
  assert.doesNotMatch(TRANSCRIPTION_PROMPT, /دكتور |د\.|عيادة د/, "the prompt names no doctor: a vivid, specific sample is a better steer and a worse lie");

  // ── And the prompt is taken back OUT of the answer ────────────────────────────
  // On a quiet recording the decoder's most natural continuation of the preceding text IS the preceding
  // text. That was survivable while the prompt was a bare product list — an echo looked like a list. An
  // echoed Egyptian visit sentence looks exactly like a real note about a real doctor.
  assert.equal(
    stripPromptEcho("زيارة دلوقتي في العيادة وقعدت معاه شويه", "زيارة دلوقتي في العيادة وقعدت معاه شويه"),
    "",
    "the prompt handed straight back leaves nothing — and nothing is the correct answer, because nothing was said",
  );
  assert.equal(
    stripPromptEcho(`${TRANSCRIPTION_PROMPT} الدكتور طلب عينات`, TRANSCRIPTION_PROMPT),
    "الدكتور طلب عينات",
    "an echo followed by real speech keeps the real speech and drops the echo",
  );
  assert.equal(
    stripPromptEcho("الدكتور طلب عينات تيبوفورتين", TRANSCRIPTION_PROMPT),
    "الدكتور طلب عينات تيبوفورتين",
    "a real comment naming a product is untouched — the product names are in the prompt, and removing a rep's own words is the failure this guard must not become",
  );
  assert.equal(stripPromptEcho("  زيارة   كويسة  ", undefined), "زيارة كويسة", "with no prompt it still collapses whitespace, the way the answer was always normalised");
  assert.equal(
    stripPromptEcho("قابلت الدكتور وقال تيبوفورتين، لاكتو كتير", TRANSCRIPTION_PROMPT),
    "قابلت الدكتور وقال تيبوفورتين، لاكتو كتير",
    "two product names in a row are a real thing a rep says: only a whole four-word-plus sentence of the prompt is removed, never a short run",
  );
  assert.match(client, /export function stripPromptEcho/, `${CLIENT} owns the echo guard — the prompt and the answer meet in one place`);
  const stripAt = client.indexOf("stripPromptEcho(answered, request.prompt)");
  const guardAt = client.indexOf("isHallucinatedTranscript(text)");
  assert.ok(
    stripAt >= 0 && guardAt > stripAt,
    `${CLIENT} strips the echo BEFORE judging the answer: an echoed Egyptian sentence is fluent, unrepetitive and about a doctor, so the hallucination guard would pass it through`,
  );

  // ── The four review fixes are pinned so a later edit cannot quietly undo them ──
  // 2026-09-26. Each is a behaviour a source-fingerprint pass would miss and a plain refactor could revert
  // while every screen still renders; the review that found them is only paid for once if these fire on the
  // way back in.

  // (a) The echo comparison and product matching fold the SAME letters, because they ARE one function. A
  // form the decoder reaches for that one folds and the other does not is how an echo slips the compare and
  // the fabricated sample sentence lands in a comment; sharing foldArabicLetters shuts that path for good.
  for (const [raw, folded] of [["أإآٱ", "اااا"], ["ى", "ي"], ["ة", "ه"], ["چ", "ج"], ["ڤ", "ف"], ["گ", "ك"]] as const) {
    assert.equal(foldArabicLetters(raw), folded, `foldArabicLetters folds ${raw} → ${folded}`);
    assert.equal(normalizeArabic(raw), folded, `normalizeArabic folds ${raw} identically — the two normalisers cannot drift`);
  }
  assert.match(client, /foldArabicLetters\(/, `${CLIENT}'s echo guard folds through the shared foldArabicLetters, so a fold added for product matching reaches it with no second edit`);

  // (b) The edge strip cleans a removed echo's leftover mark WITHOUT eating a real ending. A head echo can
  // strand a dangling terminal mark and a comment never opens on one, so the leading edge strips . ! ? ؟;
  // the trailing edge must not, or a rep's own «...؟» reaches the manager as a flat statement.
  assert.equal(
    stripPromptEcho("الدكتور مهتم بالمنتج؟", TRANSCRIPTION_PROMPT),
    "الدكتور مهتم بالمنتج؟",
    "a real comment ending in ؟ keeps it — the trailing strip must not eat a comment's own final mark",
  );
  assert.equal(
    stripPromptEcho("؟ الدكتور مهتم بالمنتج", TRANSCRIPTION_PROMPT),
    "الدكتور مهتم بالمنتج",
    "a leading terminal mark — all a head echo can strand — is still cleaned",
  );
  assert.equal(
    stripPromptEcho("الدكتور مهتم بالمنتج،  ", TRANSCRIPTION_PROMPT),
    "الدكتور مهتم بالمنتج",
    "trailing whitespace and a separator comma are still trimmed",
  );

  // (c) The two browser-only halves keep the behaviour the review restored. They run in a real browser — a
  // React effect and a MediaRecorder — so this node suite pins them by source: a revert turns one red.
  const speakSource = stripComments(readFileSync("src/components/phoenix-crm/speak.tsx", "utf8"));
  const recorderSource = stripComments(readFileSync("src/lib/phoenix-crm/voice-recorder.ts", "utf8"));
  // The engine-handover breadcrumb is throttled by TIME, not latched once for the tab's life: a permanent
  // boolean hid every handover after the first, so a server path that began failing left no trace.
  assert.match(speakSource, /handoverReportedAt/, "speak.tsx throttles the handover log by timestamp, not a one-shot boolean");
  assert.match(speakSource, /now - handoverReportedAt > HANDOVER_LOG_INTERVAL_MS/, "speak.tsx logs again once the interval passes — a later handover is never silently swallowed");
  assert.doesNotMatch(speakSource, /handoverReported\s*=\s*true/, "speak.tsx keeps no permanent latch — restoring one is the regression this pins");
  // The two stop paths build the Recording through ONE settle(), so a recorder already inactive returns the
  // same typed blob and one-second floor as the recorder's own onstop.
  assert.match(recorderSource, /const settle = \(\): Recording =>/, "voice-recorder.ts builds the Recording in one place");
  assert.match(recorderSource, /new Blob\(chunks, \{ type \}\)/, "voice-recorder.ts gives the blob its codec type so the <audio> preview can play it");
  assert.match(recorderSource, /Math\.max\(1, elapsed\(\)\)/, "voice-recorder.ts floors the length to a second so a recording never reports 0:00");
  assert.match(recorderSource, /resolve\(settle\(\)\)/, "voice-recorder.ts's inactive-stop fallback returns the shared settle(), not a hand-copied second build");

  // The same corrector the live engine's words go through. A general Arabic model has never heard
  // "تيبوفورتين" either, so the failure it fixes is identical and the fix must not be duplicated.
  assert.match(service, /correctDictatedProducts\(spoken\)\.text/, `${SERVICE} runs the same product corrector as the live engine — one lexicon, measured against one corpus`);

  // ── 4. Only the person who just recorded it, and only by path ─────────────────
  assert.match(service, /\.eq\("issued_to_hr_id", viewer\.hrId\)/, `${SERVICE} transcribes only a note this person recorded — a cost rule: charged per second of audio, "anything in my scope" is a bill for a district's whole history`);
  assert.match(service, /\.gte\("issued_at", since\)/, `${SERVICE} bounds it to a window, so an old path replayed from a copied payload buys nothing`);
  assert.match(service, /voicePathTerritory\(path\)/, `${SERVICE} refuses a path that is not shaped like a voice note before it touches storage`);
  // It fetches the stored object itself — the phone sends a path, never the audio a second time — but it
  // asks the bucket's OWNER for those bytes. phoenix-crm-boundary.test.ts allows each server file exactly
  // one bucket and names the owner by filename, so a second file opening this one is the thing that rule
  // exists to stop; the read lives in voice-notes.ts and this module holds the proof that earns it.
  assert.match(service, /downloadVoiceNote\(path\)/, `${SERVICE} reads the recording through its bucket's owner`);
  assert.doesNotMatch(service, /\.storage\.from\(/, `${SERVICE} never opens the bucket itself — one file per bucket, so the module's storage access stays readable in one place`);
  const ownershipAt = service.indexOf('.eq("issued_to_hr_id", viewer.hrId)');
  assert.ok(
    ownershipAt >= 0 && service.indexOf("downloadVoiceNote(path)") > ownershipAt,
    `${SERVICE} proves the note is his own BEFORE it reads the bytes — the helper authorises nothing, so moving it above that check is the hole`,
  );
  assert.doesNotMatch(service, /FormData|multipart/, `${SERVICE} takes no upload: there is exactly one way audio enters this system, and it is the voice slot`);

  // The window is a cost rule; so is transcribing each recording at most once. The check is an UPDATE that
  // claims the row — sets transcribed_at only where it is still null — so the SAME path cannot be
  // resubmitted into a run of paid calls inside its two-hour window, and two requests racing for one path
  // cannot both bill the service (one row lock). Total transcriptions then sit under the slot ceiling a rep
  // already lives under. A failure after the claim releases it, so no recording is permanently un-writable.
  assert.match(service, /\.update\(\{ transcribed_at: new Date\(\)\.toISOString\(\) \}\)/, `${SERVICE} claims the recording for one transcription instead of only reading its slot`);
  assert.match(service, /\.is\("transcribed_at", null\)/, `${SERVICE} claims only a recording not already written out — the same path cannot be re-charged inside its window`);
  const claimAt = service.indexOf('.is("transcribed_at", null)');
  assert.ok(
    claimAt >= 0 && service.indexOf("downloadVoiceNote(path)") > claimAt,
    `${SERVICE} claims the single transcription BEFORE it reads the bytes or calls the paid service`,
  );
  assert.match(service, /transcribed_at: null/, `${SERVICE} releases the claim on any failure after it, so a read-back miss or a transient outage never burns a recording's one shot`);

  // The route spends money at a third party, so it carries a save's refusals even though it reads.
  assert.match(route, /assertSameOriginMutation\(request\)/, `${ROUTE} refuses a cross-site POST — it spends money per request`);
  assert.match(route, /assertPermission\(access, "phoenix_crm", "create"\)/, `${ROUTE} gates the words behind the same permission as entering a visit`);
  assert.match(route, /export const dynamic = "force-dynamic"/, `${ROUTE} is never cached or prefetched`);
  assert.match(route, /isVoiceTranscriptionConfigured\(\)/, `${ROUTE} answers whether this can write words at all — the control asks BEFORE it promises any, because a browser cannot see the key`);
  assert.doesNotMatch(route, /GROQ_API_KEY|Groq/, `${ROUTE} never names the service or its key to a phone — a boolean is the whole answer, and the rest belongs in /admin/system-audit`);

  // ── Every failure is a sentence the rep can act on, and none is fatal ─────────
  // The transcription runs after the upload has landed, so the recording is already safe: a refusal costs
  // him the typing he would have done anyway. Each message therefore ends by naming the way out.
  for (const code of ["auth_failed", "empty", "failed", "not_configured", "quota_exceeded", "rate_limited", "timeout", "too_large"] as const) {
    const message = groqTranscriptionMessage(new GroqTranscriptionError(code, "internal detail"));
    assert.match(message, /[Tt]ype the comment/, `the ${code} refusal names typing as the way out — speaking was always an accelerator`);
    assert.doesNotMatch(message, /internal detail|whisper|groq|HTTP|\b\d{3}\b/i, `the ${code} refusal never shows a rep a model name, a vendor or a status code`);
  }
  assert.match(
    groqTranscriptionMessage(new GroqTranscriptionError("not_configured", "x")),
    /not set up/,
    "an unconfigured key is not an error the rep caused, and is not described as one",
  );
  assert.match(groqTranscriptionMessage(new Error("something else")), /[Tt]ype the comment/, "an unrecognised failure still ends with the way out rather than nothing");

  // No body is ever logged, for the reason the OpenAI client already carries: on a 401 an OpenAI-shaped
  // API echoes a fragment of the key back inside its own error message.
  assert.doesNotMatch(client, /logError\([^)]*body/, `${CLIENT} never logs the response body — a 401 from an OpenAI-shaped API quotes the key back at you`);

  // ── 5. The key's shape is pinned before a key exists ──────────────────────────
  // OPENAI_API_KEY sat in Railway holding a masked paste, and the rule that would have caught it was
  // written only afterwards. This one is registered with the feature.
  assert.ok(KEY_SHAPES.some((entry) => entry.name === "GROQ_API_KEY"), "GROQ_API_KEY has a shape rule — it is pasted into Railway by hand, exactly like the key that failed");
  assert.deepEqual(checkSecretShape("GROQ_API_KEY", SYNTHETIC_GROQ_KEY), [], "a real-shaped key passes");
  assert.ok(
    checkSecretShape("GROQ_API_KEY", `gsk_...${SYNTHETIC_GROQ_KEY}...`).length > 0,
    "a paste copied off an already-masked screen is refused — that is the exact failure this exists for",
  );
  assert.ok(
    checkSecretShape("GROQ_API_KEY", `${SYNTHETIC_GROQ_KEY}\n`).length > 0,
    "and so is a trailing newline, which is what `railway variables --stdin` adds to a value",
  );
  assert.deepEqual(checkSecretShape("GROQ_API_KEY", undefined), [], "unset is a supported state, not a failure — the control stops promising words instead");
}
