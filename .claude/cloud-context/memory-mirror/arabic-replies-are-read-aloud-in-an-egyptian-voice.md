---
name: arabic-replies-are-read-aloud-in-an-egyptian-voice
description: "Claude speaks a reply aloud ONLY when the owner asks (never automatically) — Arabic in colloquial Egyptian via Gemini, English in a natural voice; arm it with ~/.claude/speak/next-<session id>"
metadata:
  node_type: memory
  type: user
  originSessionId: 8578f8c2-63bd-4ac2-a2eb-8db973c383e2
  modified: 2026-11-20T16:34:24.057Z
---

Since 20 Nov 2026 a Stop hook (`~/.claude/hooks/speak-arabic-reply.mjs` → `~/.claude/scripts/speak-arabic-reply.py`) can read the turn's reply aloud: Arabic through Google's Gemini speech models tried in order `gemini-3.8-flash-tts` → `gemini-3.1-flash-tts-preview` → `gemini-2.5-flash-preview-tts` → `gemini-3.8-flash-lite-tts` (voice Charon, told to speak colloquial Cairene Egyptian, with the owner's own `GEMINI_API_KEY`), English with an English style; if Gemini fails, edge-tts `ar-EG-SalmaNeural` / `en-US-AndrewNeural` reads it. The `**Next step:**` line, code, links and markdown are left out.

🔴 **It is NEVER automatic.** It speaks only when the session armed it for that turn: create the empty file `~/.claude/speak/next-<session id>` (the session id is this session's transcript filename without `.jsonl`) before the turn ends; the script uses it once and deletes it. With no flag, nothing is said, in any language.

**Why:** the app's own "Read aloud" button uses Anthropic's online voice, which cannot be changed and is not Egyptian. He first chose "every Arabic reply read automatically", then Salma sounded like broken Fusha to him ("عربي بس مش مصري"), so he approved Gemini with his key (text goes to Google). Then, the same evening: "مش عايزك اوتوماتيك تتكلم… لو انا طلبت منك انك تتكلم" — speak only when he asks, whether the reply is Arabic or English. He rejected a desktop shortcut or hotkey.

**Every session, automatically on his words:** `~/.claude/hooks/speak-on-request.mjs` (global UserPromptSubmit) catches "اقراها", "بصوتك", "اقرالي", "read it aloud"…; a short request (≤6 words) speaks the reply he already has at once (`--previous`), a longer one arms the flag so this turn's reply is spoken. He asked for it in every session after the app's own button read a reply in the bad voice ("انا عايز في كله").

**How to apply:** if the hook missed his words, arm the flag yourself (`touch ~/.claude/speak/next-<id>`) in the same turn, and write the reply in plain spoken language (Egyptian if he wrote Arabic: short sentences, no Fusha, almost no English words mid-sentence). Never arm it on your own. Off switch for everything: `~/.claude/speak/off`. Log: `~/.claude/speak/speak.log` (`OK Gemini`/`OK Salma`/`WARN`/`FAIL`). 🔴 His key is FREE TIER: **10 requests a day PER MODEL** (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, resets ~10:00 Cairo), so a 429 moves to the next model and Salma speaks only when all four are spent — never burn them on tests. Pro TTS is 0 on free tier. 🔴 A hook's child is killed when the hook returns (a `detached` spawn died silently, 20 Nov 2026): `hooks/lib-speak-launch.mjs` starts the script through WMI `Win32_Process.Create` (parent `WmiPrvSE`); every run logs `START` first. A `403` from `speech.platform.bing.com` on the fallback means edge-tts is too old: `python -m pip install --user --upgrade edge-tts`.
