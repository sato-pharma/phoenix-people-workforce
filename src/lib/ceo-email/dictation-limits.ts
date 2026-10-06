/**
 * The dictation ceilings and the container allowlist, with nothing server-only in the file.
 *
 * 🔴 SPLIT OUT FOR THE SAME REASON AS `sato-email/media-limits.ts`: the control that records is a
 * client component, and it needs the recording cap. Importing it from `./dictation.ts` would drag
 * the speech client — `process.env.GROQ_API_KEY`, the AI metrics recorder, the logger — into the
 * browser bundle. These two numbers and one map have no dependencies at all, so both halves can
 * read them and neither has to duplicate one.
 */

/**
 * How long one dictation may run.
 *
 * Three minutes, against the CRM voice note's one. A rep speaks a sentence about a visit; a chief
 * executive dictating a letter speaks paragraphs, and a cap that cuts him off mid-thought makes the
 * microphone useless for the one job it is here for. Three minutes of mono Opus at 24 kbps is about
 * 540 KB, comfortably inside the 8 MB the speech service accepts.
 */
export const CEO_DICTATION_MAX_SECONDS = 180;

/**
 * The largest upload the route will read.
 *
 * Generous against the 540 KB the cap above produces, because a browser that ignored the bitrate
 * hint records fatter — Safari's AAC runs several times Opus for the same speech. It is a backstop
 * against a careless upload, not a second opinion on the recording length.
 */
export const CEO_DICTATION_MAX_BYTES = 6 * 1024 * 1024;

/**
 * The languages he may dictate in, each one NAMED to the speech service.
 *
 * 🔴 THERE IS NO "DETECT IT" OPTION, AND THAT IS MEASURED, NOT TIMID. Sending no `language` field
 * makes Whisper translate the speech into fluent English — measured in this repo on Egyptian Arabic,
 * and the reason the CRM path hardcodes `ar` (`src/lib/ai/groq-transcription.ts`). A letter the chief
 * executive dictated in Arabic arriving as an English instruction is the worst possible outcome here,
 * because it reads exactly like a working feature. So the language is named, and he names it.
 *
 * The browser's own engine is not an alternative: `SpeechRecognition.lang` is mandatory there too and
 * has no auto value, so it would need this same control AND would be wrong on Firefox.
 *
 * ISO-639-1 codes only — this field is not a locale and not a dialect selector, so `ar-EG`, `arz` and
 * `egy` are all refused by the API. Arabic is first because it is what he speaks.
 */
export const CEO_DICTATION_LANGUAGES = [
  { code: "ar", label: "العربية" },
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "es", label: "Español" },
  { code: "tr", label: "Türkçe" },
] as const;

/** What the mic opens on. His own language. */
export const CEO_DICTATION_DEFAULT_LANGUAGE = "ar";

/**
 * The code to send, or the default.
 *
 * The browser posts this, so it is read rather than trusted: an unknown code reaching the API would
 * be refused and the whole clip lost, which on a three-minute dictation is the expensive failure.
 */
export function normalizeCeoDictationLanguage(value: unknown): string {
  const wanted = String(value ?? "").trim().toLowerCase();
  const found = CEO_DICTATION_LANGUAGES.find((entry) => entry.code === wanted);
  return found ? found.code : CEO_DICTATION_DEFAULT_LANGUAGE;
}

/** Containers a browser actually produces from MediaRecorder, and nothing else. */
const ALLOWED_AUDIO = new Map<string, string>([
  ["audio/webm", ".webm"],
  ["audio/ogg", ".ogg"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/mpga", ".mp3"],
  ["audio/wav", ".wav"],
  ["audio/x-m4a", ".m4a"],
]);

/**
 * The extension for what was recorded, or null if it is not a container we accept.
 *
 * The speech service reads the container from the FILENAME, so an upload whose name says one thing
 * and whose bytes say another is refused rather than guessed at. The browser sends
 * `audio/webm;codecs=opus` — the codec parameter is cut before the lookup and never matched, because
 * the container is what the reader needs and the codec list varies by browser.
 */
export function dictationExtension(contentType: string): string | null {
  const base = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  return ALLOWED_AUDIO.get(base) ?? null;
}
