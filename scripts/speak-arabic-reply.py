# Reads Claude's last reply aloud, ONLY when the owner asked for it: Arabic in colloquial Egyptian, English in
# a natural English voice.
#
# Started detached by ~/.claude/hooks/speak-arabic-reply.mjs at the end of every turn (Stop hook), and silent
# unless the session armed it. The owner, 20 Nov 2026: "مش عايزك اوتوماتيك تتكلم" — speak only when he asks.
# The app's own read-aloud button uses Anthropic's online voice, which cannot be changed and is not Egyptian.
#
#   Speak this turn's reply:  ~/.claude/speak/next-<session id>  (the transcript file's name without .jsonl)
#                             exists when the turn ends; the script reads it once and deletes it.
#   Speak the reply he has:   speak-arabic-reply.py --previous <transcript>  (no flag; reads it at once)
#   Both are started for him by ~/.claude/hooks/speak-on-request.mjs (UserPromptSubmit) in EVERY session when
#   his message asks to hear it ("اقراها", "بصوتك", "read it aloud"...).
#   Turn it off entirely:     create the file  ~/.claude/speak/off
#   Log:                      ~/.claude/speak/speak.log
#
# Voice: Google's Gemini speech model, told to speak colloquial Egyptian (the owner's own GEMINI_API_KEY, his
# choice on 20 Nov 2026 after Microsoft's Salma sounded like broken Fusha). If Gemini fails, Salma
# (ar-EG-SalmaNeural, Microsoft's online service through edge-tts) reads it instead, so a reply is never silent.

import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOME = Path.home() / ".claude" / "speak"
OFF = HOME / "off"
LOG = HOME / "speak.log"
PID = HOME / "player.pid"
VOICE = "ar-EG-SalmaNeural"  # fallback only
# Tried in order: each model has its own free allowance (10 a day on the free key, 20 Nov 2026), so a refused
# one (429) hands over to the next, and Salma speaks only when all four are spent.
# The 3.8 models SPEAK any direction put before the text (27 Nov 2026: every Arabic reply opened with the instruction
# "اقرا الكلام ده باللهجه المصريه..." read aloud, proven by transcribing the audio; an English "Say this in ...:" was
# spoken too, and they refuse systemInstruction with 400). So the two that obey a direction go first and get it; the
# 3.8 pair get the bare text only (proven clean by transcription the same day).
GEMINI_MODELS = ("gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts")
GEMINI_SPEAKS_DIRECTION = {"gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"}
GEMINI_VOICE = "Charon"
GEMINI_STYLE = (
    "اقرأ الكلام ده باللهجة المصرية العامية، بصوت طبيعي ودافي زي واحد قاهري بيتكلم مع صاحبه، "
    "مش فصحى ومش مذيع أخبار. اقرأ الأرقام بالمصري:" + chr(10)
)
GEMINI_STYLE_ENGLISH = "Read this aloud in a natural, warm, conversational voice:" + chr(10)
VOICE_ENGLISH = "en-US-AndrewNeural"  # fallback only
ARABIC = re.compile(r"[؀-ۿ]")
LATIN = re.compile(r"[A-Za-z]")


def log(message: str) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")


def is_prompt(entry: dict) -> bool:
    """A message he typed, not a tool result (tool results are stored as user entries too)."""
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return True
    return isinstance(content, list) and not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)


def last_reply(transcript: Path, before_prompt: bool = False) -> str:
    """The assistant text after the last user or tool-result entry: the reply the owner reads.
    before_prompt: he just typed a new message, so step over it and read the reply he already has."""
    lines = transcript.read_text(encoding="utf-8", errors="replace").splitlines()
    parts: list[str] = []
    for raw in reversed(lines):
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            continue
        kind = entry.get("type")
        if kind == "user":
            if before_prompt and not parts:
                continue  # his new message, or a turn still working: step back to the last text he saw
            break
        if kind != "assistant":
            continue
        content = (entry.get("message") or {}).get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            texts = [block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text"]
            if texts:
                parts.append("\n".join(texts))
    return "\n".join(reversed(parts)).strip()


def is_arabic(text: str) -> bool:
    arabic = len(ARABIC.findall(text))
    latin = len(LATIN.findall(text))
    return arabic >= 20 and arabic >= latin


def for_speech(text: str) -> str:
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    kept = []
    for line in text.splitlines():
        if line.strip().startswith("**Next step:**"):
            continue  # the line the owner sends back, not the answer
        kept.append(line)
    text = "\n".join(kept)
    text = re.sub(r"`[^`]*`", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"^\s*[-*•]\s+", "", text, flags=re.M)
    text = re.sub(r"[*#>|_~“”\"]", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{2,}", "\n", text)
    return text.strip()[:5000]


def stop_previous() -> None:
    try:
        pid = int(PID.read_text().strip())
    except (OSError, ValueError):
        return
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)


def gemini_key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "")
    if key:
        return key
    try:  # a process started before the variable was set still finds it
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as env:
            return str(winreg.QueryValueEx(env, "GEMINI_API_KEY")[0])
    except OSError:
        return ""


def synthesize_gemini(text: str, target: Path, style: str) -> None:
    import base64
    import urllib.error
    import urllib.request
    import wave

    key = gemini_key()
    if not key:
        raise RuntimeError("no GEMINI_API_KEY")
    def body_for(model: str) -> dict:
        spoken = text if model in GEMINI_SPEAKS_DIRECTION else style + text
        return {
            "contents": [{"parts": [{"text": spoken}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": GEMINI_VOICE}}},
            },
        }
    refused = []
    for model in GEMINI_MODELS:
        request = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=json.dumps(body_for(model)).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                answer = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in (429, 404, 503):
                refused.append(f"{model} {error.code}")
                continue
            raise
        part = answer["candidates"][0]["content"]["parts"][0]["inlineData"]
        data = base64.b64decode(part["data"])
        if "wav" in part.get("mimeType", ""):
            target.write_bytes(data)  # already a WAV file
        else:
            with wave.open(str(target), "wb") as audio:  # raw 16-bit PCM, 24 kHz mono
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(24000)
                audio.writeframes(data)
        if refused:
            log(f"NOTE {model} spoke after: {', '.join(refused)}")
        return
    raise RuntimeError("every Gemini voice model refused: " + ", ".join(refused))


async def synthesize_salma(text: str, target: Path, voice: str) -> None:
    import edge_tts

    await edge_tts.Communicate(text, voice).save(str(target))


def play(audio: Path) -> None:
    uri = audio.as_uri()
    script = (
        "Add-Type -AssemblyName PresentationCore; "
        "$p = New-Object System.Windows.Media.MediaPlayer; "
        f"$p.Open([uri]'{uri}'); "
        "$t = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $t -lt 100) { Start-Sleep -Milliseconds 100; $t++ }; "
        "$p.Play(); "
        "Start-Sleep -Seconds ([math]::Ceiling($p.NaturalDuration.TimeSpan.TotalSeconds) + 1); "
        "$p.Close(); "
        f"Remove-Item -LiteralPath '{audio}' -ErrorAction SilentlyContinue"
    )
    player = subprocess.Popen(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    PID.write_text(str(player.pid))


def main() -> None:
    if len(sys.argv) < 2:
        return
    previous = sys.argv[1] == "--previous"
    if previous:
        if len(sys.argv) < 3:
            return
        transcript = Path(sys.argv[2])
    else:
        transcript = Path(sys.argv[1])
        armed = HOME / f"next-{transcript.stem}"
        if not armed.exists():
            return  # he did not ask for this reply to be spoken
        armed.unlink(missing_ok=True)  # one request, one spoken reply
    if OFF.exists():
        return
    log(f"START {'previous reply' if previous else 'this reply'} of {transcript.name}")
    time.sleep(1.5)  # let the transcript finish writing
    reply = last_reply(transcript, before_prompt=previous)
    text = for_speech(reply)
    if not text:
        return
    arabic = is_arabic(reply)
    HOME.mkdir(parents=True, exist_ok=True)
    stamp = int(time.time() * 1000)
    audio = Path(tempfile.gettempdir()) / f"claude-speak-{stamp}.wav"
    voice = "Gemini"
    try:
        synthesize_gemini(text, audio, GEMINI_STYLE if arabic else GEMINI_STYLE_ENGLISH)
    except Exception as error:
        audio.unlink(missing_ok=True)
        voice = "Salma" if arabic else "Andrew"
        log(f"WARN Gemini failed ({type(error).__name__}: {error}); {voice} reads it instead")
        audio = audio.with_suffix(".mp3")
        try:
            asyncio.run(synthesize_salma(text, audio, VOICE if arabic else VOICE_ENGLISH))
        except Exception:
            audio.unlink(missing_ok=True)  # a refused or broken download leaves no empty file behind
            raise
    stop_previous()
    play(audio)
    log(f"OK {voice} spoke {len(text)} characters from {transcript.name}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # never let a voice problem reach a session
        log(f"FAIL {type(error).__name__}: {error}")
