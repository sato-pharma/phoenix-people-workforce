/**
 * The ChatGPT connector's films (src/lib/chatgpt-connector/films/, tools/films.ts).
 *
 * Owner, 20 Nov 2026: ChatGPT makes narrated branding films of Phoenix up to twenty minutes, on masked
 * data, with a voice-over and captions; Phoenix renders them on the worker service and hands back a
 * private link. Nothing here opens a browser, runs ffmpeg or reads a database: the pieces that decide
 * what a film may be, what it shows and where it is rendered are pure and are tested directly.
 *
 *   1. The script check: twenty minutes at most, a page scene must name its page, and the capture
 *      fence's own refusal is passed through word for word.
 *   2. The captions: no cue longer than two lines, and the last one ends exactly with the voice.
 *   3. The masker, evaluated from the SAME string the page runs: names swapped the same way every time,
 *      emails swapped, runs of three digits or more changed, dates, times and years kept.
 *   4. The ffmpeg helpers: each frame held until the next, and the duration read from ffmpeg's report.
 *   5. Where films render: only a production build, on Railway, on a process that runs background jobs.
 *   6. The download route hands a big file over by a signed address (a 303) only above the threshold.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CONNECTOR_STREAM_DIRECT_BYTES, connectorFileGoesBySignedAddress } from "@/lib/chatgpt-connector/files";
import { MASK_CORE } from "@/lib/chatgpt-connector/films/page-script";
import { frameConcatList, parseFfmpegDurationMs } from "@/lib/chatgpt-connector/films/render";
import {
  CAPTION_MAX_CHARS,
  checkFilmScript,
  FILM_MAX_SECONDS,
  SCENE_MAX_SECONDS,
  splitCaptionCues,
  type FilmScene,
} from "@/lib/chatgpt-connector/films/script";
import { filmWorkerRefusal } from "@/lib/chatgpt-connector/films/worker";

import { stripComments } from "./support/comment-strip";

const anyPath = (p: string) => ({ ok: true as const, path: p });

function titleScene(seconds: number): FilmScene {
  return { kind: "title", heading: "Phoenix", narration: "", seconds };
}

function scriptCheck() {
  // The cap: whole scenes at the longest a scene may run, one scene past twenty minutes is refused.
  const fit = Math.floor(FILM_MAX_SECONDS / SCENE_MAX_SECONDS);
  const ok = checkFilmScript({ title: "Phoenix at a glance", scenes: Array.from({ length: fit }, () => titleScene(SCENE_MAX_SECONDS)) }, anyPath);
  assert.equal(ok.ok, true, "a film inside twenty minutes is accepted");
  if (ok.ok) {
    assert.equal(ok.estimatedSeconds, fit * SCENE_MAX_SECONDS);
    assert.equal(ok.script.language, "en");
    assert.equal(ok.script.voice, "marin");
    assert.equal(ok.script.viewport, "desktop");
  }
  const long = checkFilmScript({ title: "Too long", scenes: Array.from({ length: fit + 1 }, () => titleScene(SCENE_MAX_SECONDS)) }, anyPath);
  assert.equal(long.ok, false, "a film over twenty minutes is refused");
  if (!long.ok) assert.match(long.reason, /twenty minutes at most/);

  // A page scene with no page address is refused, and says which scene.
  const noPath = checkFilmScript({ title: "T", scenes: [titleScene(5), { kind: "page", heading: "Employees", narration: "The people." }] }, anyPath);
  assert.equal(noPath.ok, false, "a page scene with no path is refused");
  if (!noPath.ok) assert.match(noPath.reason, /^Scene 2 \("Employees"\) is a page scene with no page address/);

  // The capture fence's refusal reaches ChatGPT word for word, with the scene and the path.
  const fenced = checkFilmScript(
    { title: "T", scenes: [{ kind: "page", heading: "API", narration: "", path: "/api/secret" }] },
    () => ({ ok: false, reason: "That address is not a Phoenix page." }),
  );
  assert.equal(fenced.ok, false, "a path the fence refuses is refused");
  if (!fenced.ok) assert.equal(fenced.reason, 'Scene 1 ("API"), /api/secret: That address is not a Phoenix page.');

  // The fence's own normalised path is the one the film opens.
  const normalised = checkFilmScript(
    { title: "T", scenes: [{ kind: "page", heading: "People", narration: " Hello. ", path: "employees" }] },
    () => ({ ok: true, path: "/employees" }),
  );
  assert.equal(normalised.ok, true);
  if (normalised.ok) {
    assert.equal(normalised.script.scenes[0].path, "/employees");
    assert.equal(normalised.script.scenes[0].narration, "Hello.");
  }
}

function captions() {
  const narration =
    "Phoenix runs payroll, attendance and sales for the whole company. " +
    "Every month the closing engine reads every invoice line from every distributor and every pharmacy in every brick of every area of every region without a single comma to break on " +
    "and then, once the figures are agreed, publishes them, so every manager reads the same number, the same day, everywhere. Short.";
  const spokenMs = 41_237;
  const cues = splitCaptionCues(narration, spokenMs);
  assert.ok(cues.length >= 4, `the narration is cut into several captions (got ${cues.length})`);
  for (const cue of cues) {
    assert.ok(cue.text.length <= CAPTION_MAX_CHARS, `no caption is over ${CAPTION_MAX_CHARS} characters: "${cue.text}" is ${cue.text.length}`);
    assert.ok(cue.endMs >= cue.startMs, "a caption never ends before it starts");
  }
  assert.equal(cues[0].startMs, 0, "the first caption starts with the voice");
  assert.equal(cues[cues.length - 1].endMs, spokenMs, "the last caption ends exactly when the voice does");
  for (let i = 1; i < cues.length; i += 1) assert.equal(cues[i].startMs, cues[i - 1].endMs, "captions follow one another with no gap");
  assert.equal(cues.map((c) => c.text).join(" ").replace(/\s+/g, " "), narration.replace(/\s+/g, " ").trim(), "no word is lost or added");
  assert.deepEqual(splitCaptionCues("", 5_000), [], "a silent scene has no captions");
  assert.deepEqual(splitCaptionCues("Hello.", 0), [], "no voice, no captions");
}

type MaskCore = { buildNameIndex: (names: string[]) => unknown; makeMasker: (index: unknown) => (text: string) => string };

function loadMaskCore(): MaskCore {
  // The very string the film's page script runs, evaluated as the browser would.
  return new Function(`${MASK_CORE}\nreturn { buildNameIndex: buildNameIndex, makeMasker: makeMasker };`)() as MaskCore;
}

function masker() {
  const core = loadMaskCore();
  const mask = core.makeMasker(core.buildNameIndex(["Sara Hassan", "Ahmed Mohamed Ali", "محمد جمال عبد الرحمن", "Madonna"]));

  // A two-word name is replaced, by the same made-up name every time.
  const once = mask("Patient Sara Hassan was visited.");
  assert.doesNotMatch(once, /Sara|Hassan/, "a known two-word name is swapped");
  assert.match(once, /^Patient [A-Z][a-z]+ [A-Z][a-z]+ was visited\.$/, "for a made-up two-word name");
  assert.equal(mask("Patient Sara Hassan was visited."), once, "the same real name always gets the same made-up one");
  assert.equal(mask("SARA   HASSAN").split(/\s+/).length, 2, "case and spacing do not hide a name");
  assert.doesNotMatch(mask("SARA HASSAN"), /SARA|HASSAN/);
  assert.equal(mask("Doctor: Ahmed Mohamed Ali").split(" ").length, 4, "a three-word name gets a three-word made-up name");
  assert.doesNotMatch(mask("Doctor: Ahmed Mohamed Ali"), /Ahmed|Mohamed|Ali/);
  const arabic = mask("الطبيب محمد جمال عبد الرحمن");
  assert.doesNotMatch(arabic, /جمال/, "an Arabic name is swapped");
  assert.match(arabic, /^الطبيب [\u0600-\u06ff ]+$/u, "for an Arabic made-up name");
  assert.equal(mask("Madonna sings"), "Madonna sings", "a one-word name is never on the list");
  assert.equal(mask("Sara went home"), "Sara went home", "one word of a name alone is not the name");

  // Emails.
  const mailed = mask("Write to sara.hassan@satopharma.com today");
  assert.match(mailed, /^Write to person\d{4}@example\.com today$/, "an email is swapped for an example.com address");
  assert.equal(mask("Write to sara.hassan@satopharma.com today"), mailed);

  // Numbers of three digits or more change, keeping their shape.
  for (const value of ["12,500", "01012345678", "450", "29801011234567"]) {
    const out = mask(`Value ${value} EGP`);
    const masked = out.slice("Value ".length, out.length - " EGP".length);
    assert.notEqual(masked, value, `${value} is changed`);
    assert.equal(masked.length, value.length, `${value} keeps its length`);
    assert.equal(masked.replace(/\d/g, "9"), value.replace(/\d/g, "9"), `${value} keeps its separators`);
    assert.equal(mask(`Value ${value} EGP`), out, `${value} is changed the same way every time`);
  }
  assert.equal(mask("Room 12 and 7"), "Room 12 and 7", "a one- or two-digit number is kept");

  // Dates, times and years are kept.
  for (const kept of ["On 2026-11-20 at 10:30", "Paid 20/11/2026", "Since 2019", "Shift 08:00:15", "Year 1999 to 2099", "Hijri 1447-05-29", "At 10:30:45.250"]) {
    assert.equal(mask(kept), kept, `"${kept}" is kept`);
  }
}

function ffmpegHelpers() {
  assert.equal(
    frameConcatList([{ file: "a.png", atMs: 0 }, { file: "b.png", atMs: 500 }], 2_000),
    "ffconcat version 1.0\nfile 'a.png'\nduration 0.500\nfile 'b.png'\nduration 1.500\nfile 'b.png'\n",
    "each frame is held until the next, the last until the scene ends, and the last file is listed twice",
  );
  assert.equal(
    frameConcatList([{ file: "it's.png", atMs: 0 }], 100),
    "ffconcat version 1.0\nfile 'it'\\''s.png'\nduration 0.100\nfile 'it'\\''s.png'\n",
    "a quote in a file name is escaped",
  );
  assert.equal(frameConcatList([{ file: "late.png", atMs: 990 }], 1_000).split("\n")[2], "duration 0.040", "a frame at the scene's end still shows for one frame");
  assert.equal(frameConcatList([], 1_000), "ffconcat version 1.0\n");

  assert.equal(parseFfmpegDurationMs("  Duration: 00:01:02.50, start: 0.000000, bitrate: 128 kb/s"), 62_500);
  assert.equal(parseFfmpegDurationMs("Duration: 01:00:00.00"), 3_600_000);
  assert.equal(parseFfmpegDurationMs("Duration: 00:00:07"), 7_000);
  assert.equal(parseFfmpegDurationMs("Input #0, mp3, from 'voice.mp3':"), null, "no duration line reads as unknown, never zero");
}

function workerPlace() {
  const railway = { NODE_ENV: "production", RAILWAY_ENVIRONMENT_NAME: "production" };
  assert.equal(filmWorkerRefusal({ ...railway, PHOENIX_PROCESS_ROLE: "worker" }), null, "the worker service renders films");
  assert.equal(filmWorkerRefusal({ ...railway }), null, "the single all-in-one process renders films");
  assert.match(String(filmWorkerRefusal({ ...railway, PHOENIX_PROCESS_ROLE: "web" })), /'web'/, "the page server never renders a film");
  assert.match(String(filmWorkerRefusal({ ...railway, PHOENIX_PROCESS_ROLE: "robot" })), /'robot'/, "the mailbox robots' service never renders a film");
  assert.equal(
    filmWorkerRefusal({ PHOENIX_PROCESS_ROLE: "worker", NODE_ENV: "development", RAILWAY_ENVIRONMENT_NAME: "production" }),
    "not a production build",
    "a laptop's next dev, whose .env.local points at production, never picks up a film",
  );
  assert.equal(filmWorkerRefusal({ PHOENIX_PROCESS_ROLE: "worker", NODE_ENV: "production" }), "not running on Railway");
  assert.equal(filmWorkerRefusal({ PHOENIX_PROCESS_ROLE: "worker", NODE_ENV: "production", RAILWAY_ENVIRONMENT_NAME: "  " }), "not running on Railway");
}

function signedAddressThreshold() {
  assert.equal(CONNECTOR_STREAM_DIRECT_BYTES, 24 * 1024 * 1024);
  assert.equal(connectorFileGoesBySignedAddress(CONNECTOR_STREAM_DIRECT_BYTES), false, "a file of exactly the threshold streams");
  assert.equal(connectorFileGoesBySignedAddress(CONNECTOR_STREAM_DIRECT_BYTES + 1), true, "one byte over goes by a signed address");
  assert.equal(connectorFileGoesBySignedAddress(String(CONNECTOR_STREAM_DIRECT_BYTES + 1)), true, "a size read back as text counts");
  assert.equal(connectorFileGoesBySignedAddress(null), false, "an unknown size streams");
  assert.equal(connectorFileGoesBySignedAddress("not a number"), false);
  assert.equal(connectorFileGoesBySignedAddress(4096), false, "a sheet or a screenshot streams");

  // The route asks that one function, after the owner and expiry checks, and answers it with a 303.
  const route = stripComments(readFileSync(path.join(process.cwd(), "app/api/connector/files/[id]/route.ts"), "utf8"));
  const ask = route.indexOf("connectorFileGoesBySignedAddress(row.size_bytes)");
  assert.ok(ask > 0, "the download route decides by connectorFileGoesBySignedAddress");
  assert.ok(ask > route.indexOf("row.login_id") && ask > route.indexOf("row.expires_at"), "only after the owner and expiry checks");
  assert.match(route.slice(ask, route.indexOf("db.storage.from(JOB_EXPORTS_BUCKET).download")), /status: 303, headers: \{ Location: signed\.signedUrl/);
  assert.doesNotMatch(route, /CONNECTOR_STREAM_DIRECT_BYTES/, "the threshold is one constant, never a second literal in the route");
}

export async function runChatgptConnectorFilmsTests() {
  scriptCheck();
  captions();
  masker();
  ffmpegHelpers();
  workerPlace();
  signedAddressThreshold();
}
