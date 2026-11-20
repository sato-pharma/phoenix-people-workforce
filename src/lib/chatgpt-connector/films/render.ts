/**
 * Renders one film: the voice for each scene, then the scenes one by one in the capture browser, then one
 * MP4. Runs on the worker service only (worker.ts), never while anyone waits on a page.
 *
 *  1. VOICE — each scene's narration is read aloud through the one AI door (createOpenAiSpeech) BEFORE the
 *     browser opens, so a slow voice never holds a browser slot. If the voice cannot be had (no key, out of
 *     credit, refused), the whole film is made with captions alone and the answer says so — never half
 *     voiced.
 *  2. PICTURES — the same read-only, fenced, signed-in browser the screenshot tool uses (browser/capture.ts),
 *     with the masking and the film's overlays added to every page (page-script.ts). A title scene shows the
 *     Phoenix title card; a page scene opens the page (its loading is never filmed), then scrolls it down and
 *     back while the narration plays. The captions are drawn in the page, so they are in every frame.
 *     Frames are JPEGs on disk, stamped with the moment they were taken, so the film plays at real speed.
 *  3. SOUND AND PICTURE — each scene becomes one MP4 segment (H.264 + AAC) cut to the scene's exact length,
 *     its frames deleted as soon as it is made; the segments are then joined without re-encoding.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpenAiSpeech } from "@/lib/ai/openai-client";
import type { AccessContext } from "@/lib/auth/permissions";
import { withChromiumSlot } from "@/lib/pdf/chromium";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { ffmpegPath, goTo, openSignedInPage, run, videoEncoders, type CapturePage } from "../browser/capture";
import { loadSideEffectRoutes } from "../browser/fence";
import { ToolRefusal } from "../types";
import { buildFilmPageScript } from "./page-script";
import { cueAt, estimateNarrationSeconds, sceneSeconds, splitCaptionCues, type FilmScene, type FilmScript } from "./script";

/** Frames a second the film is written at, and the most the browser is asked for. */
export const FILM_FPS = 24;
const GRAB_MIN_GAP_MS = 1000 / 14;
/** The whole render must end inside this, or it stops with what it has as a failure. */
export const FILM_RENDER_DEADLINE_MS = 75 * 60_000;
const PAGE_LOAD_BUDGET_MS = 25_000;

export type FilmProgress = { scene: number; scenes: number; stage: string };
export type RenderedFilm = { body: Buffer; durationSeconds: number; voiceUsed: boolean; writesStopped: number };

// ── Small pure helpers, exported for the tests ───────────────────────────────────────────────────

/** Reads "Duration: 00:01:02.50" from ffmpeg's report on a file, in milliseconds; null when absent. */
export function parseFfmpegDurationMs(report: string): number | null {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(report);
  if (!match) return null;
  return Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
}

/**
 * The ffconcat list that plays each frame for as long as it really was on screen: until the next frame
 * was taken, and the last one until the scene ends. ffmpeg reads the last file twice by design (its
 * duration is honoured only when another entry follows).
 */
export function frameConcatList(frames: Array<{ file: string; atMs: number }>, sceneMs: number): string {
  const lines = ["ffconcat version 1.0"];
  frames.forEach((frame, index) => {
    const next = index + 1 < frames.length ? frames[index + 1].atMs : Math.max(frame.atMs + 40, sceneMs);
    lines.push(`file '${frame.file.replace(/'/g, "'\\''")}'`, `duration ${(Math.max(1, next - frame.atMs) / 1000).toFixed(3)}`);
  });
  if (frames.length) lines.push(`file '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'`);
  return `${lines.join("\n")}\n`;
}

/** The ffmpeg arguments for one scene's segment: the frames, the voice (or silence), cut to the scene. */
export function segmentArgs(input: { listFile: string; audioFile: string | null; seconds: number; outFile: string }): string[] {
  const audio = input.audioFile ? ["-i", input.audioFile] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", input.listFile,
    ...audio,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", `fps=${FILM_FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p`,
    "-af", "aresample=48000,aformat=channel_layouts=stereo,apad",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-r", String(FILM_FPS),
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-t", input.seconds.toFixed(3),
    "-movflags", "+faststart", "-f", "mp4", input.outFile,
  ];
}

/** Scrolls whatever scrolls by a fraction of its height; says where it ended up. */
const FILM_SCROLL = (fraction: number) => `(() => {
  const candidates = [document.scrollingElement, ...document.querySelectorAll("main, [data-scroll-root], div")];
  let target = null;
  for (const el of candidates) {
    if (!el) continue;
    const style = el === document.scrollingElement ? null : getComputedStyle(el);
    const scrolls = el === document.scrollingElement || /(auto|scroll)/.test(style.overflowY);
    if (scrolls && el.scrollHeight - el.clientHeight > 40 && el.clientHeight > window.innerHeight * 0.5) { target = el; break; }
  }
  if (!target) return { scrolls: false, atTop: true, atEnd: true };
  target.scrollBy({ top: Math.round(target.clientHeight * ${fraction}), behavior: "smooth" });
  return { scrolls: true, atTop: target.scrollTop <= 4, atEnd: target.scrollTop + target.clientHeight >= target.scrollHeight - 4 };
})()`;

// ── The render ──────────────────────────────────────────────────────────────────────────────────

async function maskNames(): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin().rpc("connector_film_mask_names");
  if (error) throw new Error(`The names to mask could not be read: ${error.message}`);
  return Array.isArray(data) ? (data as unknown[]).filter((name): name is string => typeof name === "string") : [];
}

async function lockupDataUri(): Promise<string | null> {
  try {
    const png = await readFile(join(process.cwd(), "public", "brand", "phoenix-sidebar-lockup.png"));
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

async function audioLengthMs(file: string): Promise<number | null> {
  const { stderr } = await run(ffmpegPath(), ["-hide_banner", "-i", file], undefined, 15_000);
  return parseFfmpegDurationMs(stderr);
}

type Voiced = { audioFile: string | null; spokenMs: number };

async function voiceScenes(script: FilmScript, dir: string, report: (p: FilmProgress) => Promise<void>): Promise<{ voiced: Voiced[]; voiceUsed: boolean }> {
  const estimate = (scene: FilmScene): Voiced => ({ audioFile: null, spokenMs: Math.round(estimateNarrationSeconds(scene.narration, script.language) * 1000) });
  const instructions = [
    script.language === "ar"
      ? "Speak clear, natural Modern Standard Arabic with an Egyptian warmth."
      : "Speak natural, clear English.",
    script.tone ?? "Warm, confident and measured, like a polished product film for a company's own people.",
  ].join(" ");
  const voiced: Voiced[] = [];
  for (const [index, scene] of script.scenes.entries()) {
    if (!scene.narration) {
      voiced.push({ audioFile: null, spokenMs: 0 });
      continue;
    }
    await report({ scene: index + 1, scenes: script.scenes.length, stage: "Recording the voice-over" });
    let audio: Buffer | null = null;
    for (let attempt = 0; attempt < 2 && !audio; attempt++) {
      try {
        audio = (
          await createOpenAiSpeech({
            text: scene.narration,
            voice: script.voice,
            instructions,
            purpose: "chatgpt_connector_film_voice",
            component: "chatgpt_connector_film_voice",
          })
        ).audio;
      } catch {
        audio = null;
      }
    }
    if (!audio) {
      // No voice for one scene means no voice for the film: never half voiced.
      return { voiced: script.scenes.map(estimate), voiceUsed: false };
    }
    const file = join(dir, `voice-${index}.mp3`);
    await writeFile(file, audio);
    const spokenMs = (await audioLengthMs(file)) ?? estimate(scene).spokenMs;
    voiced.push({ audioFile: file, spokenMs });
  }
  return { voiced, voiceUsed: voiced.some((v) => v.audioFile !== null) };
}

async function filmCall(page: CapturePage, call: string) {
  await page.evaluate(`window.__phoenixFilm ? window.__phoenixFilm.${call} : false`).catch(() => false);
}

async function shootScene(input: {
  page: CapturePage;
  scene: FilmScene;
  sceneMs: number;
  spokenMs: number;
  filmTitle: string;
  dir: string;
  index: number;
}): Promise<Array<{ file: string; atMs: number }>> {
  const { page, scene, sceneMs } = input;
  const cues = splitCaptionCues(scene.narration, input.spokenMs);
  const label = scene.kind === "page" ? scene.heading : "";
  if (scene.kind === "title") {
    const subtitle = scene.heading.trim() === input.filmTitle.trim() ? "Phoenix Workforce" : input.filmTitle;
    await filmCall(page, `title(${JSON.stringify(scene.heading)}, ${JSON.stringify(subtitle)})`);
  } else {
    await filmCall(page, "untitle()");
  }
  const frames: Array<{ file: string; atMs: number }> = [];
  let shown = "\u0000";
  let direction = 1;
  let nextScrollAt = scene.kind === "page" ? 1_800 : Number.POSITIVE_INFINITY;
  const started = Date.now();
  let elapsed = 0;
  while (elapsed < sceneMs) {
    const caption = cueAt(cues, elapsed);
    if (caption !== shown) {
      await filmCall(page, `caption(${JSON.stringify(label)}, ${JSON.stringify(caption)})`);
      shown = caption;
    }
    if (elapsed >= nextScrollAt && sceneMs - elapsed > 1_500) {
      const step = (await page.evaluate(FILM_SCROLL(0.42 * direction)).catch(() => ({ scrolls: false }))) as { scrolls?: boolean; atTop?: boolean; atEnd?: boolean };
      if (!step?.scrolls) nextScrollAt = Number.POSITIVE_INFINITY;
      else {
        if (direction > 0 && step.atEnd) direction = -1;
        else if (direction < 0 && step.atTop) direction = 1;
        nextScrollAt = elapsed + 2_200;
      }
    }
    const shotAt = Date.now() - started;
    const jpeg = Buffer.from(await page.screenshot({ type: "jpeg", quality: 74, optimizeForSpeed: true }));
    const file = join(input.dir, `s${input.index}-${String(frames.length).padStart(6, "0")}.jpg`);
    await writeFile(file, jpeg);
    frames.push({ file, atMs: shotAt });
    const spent = Date.now() - started - shotAt;
    if (spent < GRAB_MIN_GAP_MS) await new Promise((done) => setTimeout(done, GRAB_MIN_GAP_MS - spent));
    elapsed = Date.now() - started;
  }
  return frames;
}

/**
 * Renders the film as the person who asked (ctx), with their own read-only view of Phoenix, and returns
 * the MP4. Throws a ToolRefusal with words a person reads when it cannot be made.
 */
export async function renderFilm(ctx: AccessContext, script: FilmScript, report: (p: FilmProgress) => Promise<void>): Promise<RenderedFilm> {
  const deadline = Date.now() + FILM_RENDER_DEADLINE_MS;
  const encoders = await videoEncoders();
  if (!encoders.h264) throw new ToolRefusal("Phoenix's video maker (ffmpeg with H.264) is not available on the worker, so no film was made.");
  const dir = await mkdtemp(join(tmpdir(), `phoenix-film-${randomUUID()}-`));
  try {
    const [names, lockup] = await Promise.all([maskNames(), lockupDataUri()]);
    const { voiced, voiceUsed } = await voiceScenes(script, dir, report);
    const lengths = script.scenes.map((scene, index) => Math.round(sceneSeconds(scene, voiced[index].spokenMs / 1000) * 1000));
    const totalMs = lengths.reduce((sum, ms) => sum + ms, 0);
    const pageScript = buildFilmPageScript({ names, lockupDataUri: lockup, rtl: script.language === "ar" });
    const routes = loadSideEffectRoutes();
    const sessionSeconds = Math.ceil(totalMs / 1000) + script.scenes.length * 40 + 300;
    const segments: string[] = [];
    let writesStopped = 0;

    await withChromiumSlot(async () => {
      const opened = await openSignedInPage(ctx, script.viewport, routes, { sessionSeconds, initScripts: [pageScript] });
      try {
        // A blank page carries the overlays for an opening title card.
        await opened.page.goto("about:blank").catch(() => undefined);
        await opened.page.evaluate(pageScript).catch(() => undefined);
        for (const [index, scene] of script.scenes.entries()) {
          if (Date.now() > deadline) throw new ToolRefusal("The film took longer than Phoenix allows to make. Try a shorter one, or split it into episodes.");
          await report({ scene: index + 1, scenes: script.scenes.length, stage: scene.kind === "page" ? `Filming ${scene.path}` : "Filming a title card" });
          if (scene.kind === "page" && scene.path) {
            await goTo(opened.page, scene.path, Date.now() + PAGE_LOAD_BUDGET_MS);
            await filmCall(opened.page, "remask()");
            await new Promise((done) => setTimeout(done, 400));
          }
          const frames = await shootScene({
            page: opened.page,
            scene,
            sceneMs: lengths[index],
            spokenMs: voiced[index].spokenMs,
            filmTitle: script.title,
            dir,
            index,
          });
          if (!frames.length) throw new ToolRefusal(`Scene ${index + 1} came out empty.`);
          const listFile = join(dir, `s${index}.ffconcat`);
          await writeFile(listFile, frameConcatList(frames.map((f) => ({ file: f.file.split(/[\\/]/).pop() ?? f.file, atMs: f.atMs })), lengths[index]));
          const outFile = join(dir, `segment-${String(index).padStart(3, "0")}.mp4`);
          const seconds = lengths[index] / 1000;
          const encoded = await run(ffmpegPath(), segmentArgs({ listFile, audioFile: voiced[index].audioFile, seconds, outFile }), undefined, Math.max(60_000, seconds * 5_000 + 30_000));
          if (encoded.code !== 0) throw new Error(`Scene ${index + 1} could not be encoded: ${encoded.stderr.split("\n")[0] ?? ""}`);
          segments.push(outFile);
          await Promise.all(frames.map((frame) => rm(frame.file, { force: true })));
        }
        writesStopped = opened.stopped();
      } finally {
        await opened.finish();
      }
    });

    await report({ scene: script.scenes.length, scenes: script.scenes.length, stage: "Putting the film together" });
    const joinList = join(dir, "segments.ffconcat");
    await writeFile(joinList, `ffconcat version 1.0\n${segments.map((file) => `file '${file.split(/[\\/]/).pop()}'`).join("\n")}\n`);
    const outFile = join(dir, "film.mp4");
    const joined = await run(
      ffmpegPath(),
      ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", joinList, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", outFile],
      undefined,
      180_000,
    );
    if (joined.code !== 0) throw new Error(`The scenes could not be joined: ${joined.stderr.split("\n")[0] ?? ""}`);
    const body = await readFile(outFile);
    return { body, durationSeconds: Math.round(totalMs / 100) / 10, voiceUsed, writesStopped };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
