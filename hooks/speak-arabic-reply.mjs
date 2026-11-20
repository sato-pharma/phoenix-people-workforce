// Stop hook: hands the session's transcript to ~/.claude/scripts/speak-arabic-reply.py, detached, and returns at
// once. The script speaks the reply only when the session armed ~/.claude/speak/next-<session id> (owner, 20 Nov 2026: never automatic).
// Never blocks and never prints a decision. Off switch: the file ~/.claude/speak/off.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchSpeak, PYTHONW, SCRIPT } from "./lib-speak-launch.mjs";


let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    if (existsSync(join(homedir(), ".claude", "speak", "off"))) return;
    const { transcript_path: transcript } = JSON.parse(input || "{}");
    if (!transcript || !existsSync(PYTHONW) || !existsSync(SCRIPT)) return;
    launchSpeak([transcript]);
  } catch {
    // a voice problem never reaches a session
  }
});
