/**
 * A film's script: the scenes ChatGPT writes and the arithmetic of how long each one runs.
 *
 * Owner, 20 Nov 2026: films of Phoenix to brand the system, up to about twenty minutes — an at-a-glance
 * overview first, then one episode per module (Recruitment, Sales, …) — on masked data, with a voice-over
 * and captions. A scene is either a TITLE card (black ground, the heading, the narration read over it) or a
 * PAGE (a live Phoenix page opened read-only and scrolled while the narration is read).
 *
 * Pure: no database, no browser. The renderer (render.ts) and the tool (tools/films.ts) both read it, and
 * the tests pin the arithmetic.
 */
import { z } from "zod";

import { OPENAI_SPEECH_VOICES } from "@/lib/ai/openai-client";

import { CAPTURE_VIEWPORTS, type CaptureViewport } from "../browser/capture";

/** The longest film, in seconds (owner: "up to 20 min"). */
export const FILM_MAX_SECONDS = 20 * 60;
export const FILM_MAX_SCENES = 80;
export const SCENE_MIN_SECONDS = 3;
export const SCENE_MAX_SECONDS = 180;
export const NARRATION_MAX_CHARS = 1_500;
/** Silence after the narration, so a scene never cuts on its last word. */
export const SCENE_TAIL_SECONDS = 0.6;

/** Reading pace for the estimate before the voice exists: words a second. */
const WORDS_PER_SECOND: Record<FilmLanguage, number> = { en: 2.5, ar: 2.1 };

export type FilmLanguage = "en" | "ar";

export const filmSceneSchema = z.object({
  kind: z.enum(["title", "page"]).describe('"title" for a title card on the Phoenix black ground; "page" to show a live Phoenix page.'),
  heading: z.string().min(1).max(120).describe("The scene's heading: the big words on a title card, the small label over the captions on a page."),
  narration: z
    .string()
    .max(NARRATION_MAX_CHARS)
    .describe("What the voice says during this scene, in the film's language. It is also shown as captions. Empty for a silent scene."),
  path: z
    .string()
    .min(1)
    .max(400)
    .optional()
    .describe("For a page scene: the page's address inside Phoenix, starting with /, for example /employees."),
  seconds: z
    .number()
    .int()
    .min(SCENE_MIN_SECONDS)
    .max(SCENE_MAX_SECONDS)
    .optional()
    .describe(`How long the scene lasts at least, ${SCENE_MIN_SECONDS} to ${SCENE_MAX_SECONDS} seconds. Left out, it lasts as long as its narration.`),
});
export type FilmScene = z.infer<typeof filmSceneSchema>;

export const filmScriptShape = {
  title: z.string().min(1).max(150).describe('The film\'s title, for example "Phoenix at a glance" or "Phoenix — Episode 2: Recruitment".'),
  language: z.enum(["en", "ar"]).optional().describe("The narration's language: en (English, the default) or ar (Arabic)."),
  voice: z.enum(OPENAI_SPEECH_VOICES).optional().describe("The narrator's voice. marin (the default) and cedar sound the most natural."),
  tone: z
    .string()
    .max(300)
    .optional()
    .describe('How the narrator speaks, for example "warm and confident, like a product launch".'),
  viewport: z
    .enum(Object.keys(CAPTURE_VIEWPORTS) as [CaptureViewport, ...CaptureViewport[]])
    .optional()
    .describe("The screen the pages are shown on: desktop (the default), tablet or mobile."),
  scenes: z.array(filmSceneSchema).min(1).max(FILM_MAX_SCENES).describe("The scenes, in order."),
};
export type FilmScript = {
  title: string;
  language: FilmLanguage;
  voice: (typeof OPENAI_SPEECH_VOICES)[number];
  tone?: string;
  viewport: CaptureViewport;
  scenes: FilmScene[];
};

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

/** How long the narration takes to read, before the voice exists. */
export function estimateNarrationSeconds(narration: string, language: FilmLanguage): number {
  return words(narration) / WORDS_PER_SECOND[language];
}

/**
 * How long a scene runs once its narration's real length is known (or estimated): the narration plus a
 * short tail, never under the scene's own asked length, never under three seconds, never over the cap.
 */
export function sceneSeconds(scene: Pick<FilmScene, "seconds">, narrationSeconds: number): number {
  const spoken = narrationSeconds > 0 ? narrationSeconds + SCENE_TAIL_SECONDS : 0;
  return Math.min(SCENE_MAX_SECONDS, Math.max(SCENE_MIN_SECONDS, scene.seconds ?? 0, spoken));
}

export type ScriptCheck = { ok: true; script: FilmScript; estimatedSeconds: number } | { ok: false; reason: string };

/**
 * The checks the tool runs before a film is queued: every page scene names a page, the whole film fits in
 * twenty minutes by the reading estimate. `checkPath` is the capture fence's own page check.
 */
export function checkFilmScript(
  input: {
    title: string;
    language?: FilmLanguage;
    voice?: FilmScript["voice"];
    tone?: string;
    viewport?: CaptureViewport;
    scenes: FilmScene[];
  },
  checkPath: (path: string) => { ok: true; path: string } | { ok: false; reason: string },
): ScriptCheck {
  const language = input.language ?? "en";
  const scenes: FilmScene[] = [];
  let estimatedSeconds = 0;
  for (const [index, scene] of input.scenes.entries()) {
    const label = `Scene ${index + 1} ("${scene.heading}")`;
    let path: string | undefined;
    if (scene.kind === "page") {
      if (!scene.path) return { ok: false, reason: `${label} is a page scene with no page address. Give its path, for example /employees.` };
      const checked = checkPath(scene.path);
      if (!checked.ok) return { ok: false, reason: `${label}, ${scene.path}: ${checked.reason}` };
      path = checked.path;
    }
    estimatedSeconds += sceneSeconds(scene, estimateNarrationSeconds(scene.narration, language));
    scenes.push({ ...scene, narration: scene.narration.trim(), ...(path ? { path } : { path: undefined }) });
  }
  if (estimatedSeconds > FILM_MAX_SECONDS) {
    return {
      ok: false,
      reason: `This film would run about ${Math.round(estimatedSeconds / 60)} minutes; a film is twenty minutes at most. Split it into episodes, or shorten the narration.`,
    };
  }
  return {
    ok: true,
    estimatedSeconds,
    script: {
      title: input.title.trim(),
      language,
      voice: input.voice ?? "marin",
      ...(input.tone?.trim() ? { tone: input.tone.trim() } : {}),
      viewport: input.viewport ?? "desktop",
      scenes,
    },
  };
}

export type CaptionCue = { text: string; startMs: number; endMs: number };

/** The longest caption shown at once, in characters: two lines at the caption's size. */
export const CAPTION_MAX_CHARS = 90;

/**
 * Cuts narration into captions: by sentence first, then a long sentence at its commas and finally between
 * words, so no caption is longer than two lines. Each caption is on screen for its share of the spoken
 * length, by its number of characters, and the last one ends with the narration.
 */
export function splitCaptionCues(narration: string, spokenMs: number): CaptionCue[] {
  const text = narration.replace(/\s+/gu, " ").trim();
  if (!text || spokenMs <= 0) return [];
  const sentences = text.match(/[^.!?؟。]+[.!?؟。]*["'”»)]*\s*/gu) ?? [text];
  const pieces: string[] = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= CAPTION_MAX_CHARS) {
      pieces.push(sentence);
      continue;
    }
    let current = "";
    for (const word of sentence.split(" ")) {
      const next = current ? `${current} ${word}` : word;
      const breakAtComma = current.length >= CAPTION_MAX_CHARS * 0.55 && /[,،;:]$/u.test(current);
      if ((next.length > CAPTION_MAX_CHARS || breakAtComma) && current) {
        pieces.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) pieces.push(current);
  }
  const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
  const cues: CaptionCue[] = [];
  let startMs = 0;
  for (const [index, piece] of pieces.entries()) {
    const endMs = index === pieces.length - 1 ? spokenMs : Math.round(startMs + (spokenMs * piece.length) / totalChars);
    cues.push({ text: piece, startMs, endMs });
    startMs = endMs;
  }
  return cues;
}

/** The caption on screen at a moment of the scene, or "" between and after them. */
export function cueAt(cues: CaptionCue[], elapsedMs: number): string {
  for (const cue of cues) if (elapsedMs >= cue.startMs && elapsedMs < cue.endMs) return cue.text;
  return "";
}
