// UserPromptSubmit hook, every session: when the owner's message asks to HEAR a reply, the reply is spoken
// (Arabic in colloquial Egyptian through Gemini, English in a natural voice) by
// ~/.claude/scripts/speak-arabic-reply.py. Owner, 20 Nov 2026: never automatic, only when he asks, in every
// session ("انا عايز في كله"). The app's own read-aloud button cannot be changed; this is the way to hear Egyptian.
//
//   A short message that only asks to hear it ("اقراها", "read it aloud") → the reply he already has is spoken now.
//   A longer message that also asks for a spoken answer ("رد عليا بصوتك ...") → this turn's reply is spoken when
//   it ends (the flag ~/.claude/speak/next-<session id>, read by the Stop hook speak-arabic-reply.mjs).
//
// Never blocks. Off switch: the file ~/.claude/speak/off.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { launchSpeak, PYTHONW, SCRIPT } from "./lib-speak-launch.mjs";

const SPEAK = join(homedir(), ".claude", "speak");

// Words that mean "let me hear it". Deliberately narrow: a false hit speaks when he did not ask.
const ASKS_TO_HEAR = new RegExp(
  [
    "بصوتك", "بالصوت", "بصوت", "اسمعني", "سمعني", "سمّعني", "كلمني",
    "اقراها", "اقرأها", "اقراهولي", "اقرالي", "اقرا لي", "اقرأ لي", "اقرا الرد", "اقرأ الرد", "اقرا الكلام", "اقرأ الكلام",
    "read (it|this|that)?\\s*(out loud|aloud)", "read aloud", "speak (it|this|that)", "say it out loud", "out loud",
  ].join("|"),
  "i",
);
const ONLY_SPEAK = /^\s*(اتكلم|إتكلم|speak|talk)\s*[.!؟?]*\s*$/i;

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    if (existsSync(join(SPEAK, "off"))) return;
    const { prompt = "", transcript_path: transcript } = JSON.parse(input || "{}");
    const text = String(prompt).trim();
    if (!transcript || !(ASKS_TO_HEAR.test(text) || ONLY_SPEAK.test(text))) return;
    if (!existsSync(PYTHONW) || !existsSync(SCRIPT)) return;
    mkdirSync(SPEAK, { recursive: true });
    const words = text.split(/\s+/).filter(Boolean).length;
    const readWhatHeHas = words <= 6;
    if (readWhatHeHas) {
      launchSpeak(["--previous", transcript]);
    } else {
      writeFileSync(join(SPEAK, `next-${basename(transcript, ".jsonl")}`), "");
    }
    const context = readWhatHeHas
      ? "The owner asked to HEAR your previous reply: it is being read aloud to him right now by the speak hook " +
        "(Egyptian voice for Arabic). Do not repeat it. Answer in one short line, in his language, that it is playing; " +
        "never say you cannot speak or that the app's button cannot change."
      : "The owner asked for a SPOKEN answer: your reply this turn will be read aloud by the speak hook when the turn " +
        "ends (Egyptian voice for Arabic, natural voice for English). Write it to be heard: plain spoken words, short " +
        "sentences, colloquial Egyptian if he wrote Arabic (no Fusha, almost no English words mid-sentence), no tables.";
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }),
    );
  } catch {
    // a voice problem never reaches a session
  }
});
