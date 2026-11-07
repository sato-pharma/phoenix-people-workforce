// Recruitment / Medical Rep hiring — the words beside the microphone on every comment box.
//
// The owner, 7 Nov 2026: "in all the comments section in this module … make the same mic [as Phoenix CRM's
// visit form] so I can talk and it is written instead of me typing". The engine is the CRM's own
// (`startDictation`, src/lib/phoenix-crm/dictation.ts — Egyptian Arabic, words written as they settle,
// appended, never replacing what was typed). Only the TEXT half: no sound is recorded or uploaded, so no
// sentence may say a recording is kept — the CRM's own messages do, which is why these are separate.
//
// PURE, so the wording is pinned by a test (tests/recruitment-mr-hiring-dictation.test.ts).

export const MR_DICTATE_LABEL = "Speak";
export const MR_DICTATE_LISTENING = "Listening — speak now. Press Stop when you finish.";

// After Stop, the words said in that turn come back professionally written, in the language spoken (owner, 8 Nov 2026: "it fix the
// spelling and the grammar … rephrase it into professional corporate language" — polish.ts). Owner rule
// 2026-08-04: users never learn a model was involved, so no sentence here names one.
export const MR_DICTATE_POLISHING = "Rewriting your words professionally…";
export const MR_DICTATE_POLISHED = "Rewritten professionally.";
export const MR_DICTATE_KEEP_OWN = "Keep my own words";
export const MR_DICTATE_KEPT = "Your words were kept as you said them.";

/** What to show for an engine error worth showing. Each ends with the way out: typing is always open. */
export function mrDictationMessage(code: string): string {
  if (code === "language-not-supported") return "This browser cannot write Arabic while you talk. Type the comment instead, or open Phoenix in Chrome or Edge.";
  if (code === "not-allowed" || code === "service-not-allowed") return "The microphone is blocked for this site. Allow it in the browser's settings, or type the comment instead.";
  if (code === "audio-capture") return "No microphone was found. Type the comment instead.";
  return "Dictation stopped. Check your connection, or type the comment instead.";
}
