/**
 * The two film tools: make a film of Phoenix, and ask how it is coming along.
 *
 * Owner, 20 Nov 2026 — films to brand the system, up to about twenty minutes: an at-a-glance overview,
 * then one episode per module (Recruitment, Sales, …). His choices: masked data (safe to post), a
 * voice-over with captions, episodes of a few minutes and up to twenty.
 *
 * ChatGPT writes the script (scenes: a title card or a live page, each with its narration); Phoenix checks
 * every page address against the capture fence, queues the film and returns at once. The worker service
 * renders it (films/render.ts) as the person who asked, on their own read-only view, with every name,
 * email and number masked, and stores the MP4 like every connector file: a link only that person can
 * open, for 7 days. Nothing in Phoenix changes; nothing is sent or published.
 */
import { z } from "zod";

import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";

import { checkCapturePath, loadSideEffectRoutes } from "../browser/fence";
import { filmFileLink, queueFilmJob, readFilmJob } from "../films/jobs";
import { checkFilmScript, FILM_MAX_SECONDS, filmScriptShape } from "../films/script";
import { readLiveAccount } from "../identity";
import { connectorOrigin } from "../oauth";
import { defineTool, ToolRefusal, type ConnectorTool } from "../types";

export const FILM_MASKED_NOTE =
  "Every name, email address and number of three digits or more on the pages is replaced with a made-up one, and staff photos are blurred. Text inside a picture and charts drawn as pictures are not masked, so watch the film before posting it.";

function lengthWords(seconds: number) {
  return seconds < 90 ? `${Math.max(1, Math.round(seconds))} seconds` : `${Math.round(seconds / 60)} minutes`;
}

export const makeFilmTool = defineTool({
  name: "phoenix_make_film",
  title: "Make a film of Phoenix",
  description: `Make a narrated film of Phoenix, up to ${FILM_MAX_SECONDS / 60} minutes, from a script you write: scenes that are either a title card or a live Phoenix page, each with the words the narrator says (also shown as captions). Use it when the person asks for a film, a video presentation, a promo, a walkthrough, an overview or an episode about Phoenix or one of its modules. Write the narration yourself in the film's language, a few sentences per scene; open with a title scene; use page scenes for the screens that show the module (addresses inside Phoenix starting with /, like /employees). The data on screen is masked (made-up names and numbers), so the film is safe to post. The film is made in the background and takes a few minutes; this tool returns at once with a job id. Call phoenix_film_status when the person asks whether it is ready. Read-only: nothing in Phoenix is changed, sent or published.`,
  input: filmScriptShape,
  async run(ctx, input) {
    const routes = loadSideEffectRoutes();
    const checked = checkFilmScript(input, (path) => checkCapturePath(path, routes));
    if (!checked.ok) throw new ToolRefusal(checked.reason);
    if (!ctx.loginId) throw new ToolRefusal("Sign in to Phoenix again.");
    const account = await readLiveAccount(ctx.loginId);
    if (!account) throw new ToolRefusal("Your Phoenix account changed. Reconnect Phoenix in ChatGPT.");
    const job = await queueFilmJob(ctx, checked.script, Number(account.session_version ?? 1));
    const pages = checked.script.scenes.filter((scene) => scene.kind === "page").length;
    return {
      summary: `The film "${checked.script.title}" is being made: ${checked.script.scenes.length} scenes (${pages} live pages), about ${lengthWords(checked.estimatedSeconds)} long, narrated in ${checked.script.language === "ar" ? "Arabic" : "English"} with captions. Making it takes a few minutes longer than the film itself; ask whether it is ready at any time. ${FILM_MASKED_NOTE}`,
      data: {
        job_id: job.id,
        title: checked.script.title,
        scenes: checked.script.scenes.length,
        page_scenes: pages,
        estimated_seconds: Math.round(checked.estimatedSeconds),
        language: checked.script.language,
        voice: checked.script.voice,
        viewport: checked.script.viewport,
        status: job.status,
      },
    };
  },
});

export const filmStatusTool = defineTool({
  name: "phoenix_film_status",
  title: "How a Phoenix film is coming along",
  description:
    "Say whether a film made with phoenix_make_film is ready, and when it is, show it with a link only this person can open. Use it when the person asks about their film, whether it is ready, or to see it. Give the job id phoenix_make_film returned; without one it answers about their newest film.",
  input: {
    job_id: z.string().uuid().optional().describe("The job id phoenix_make_film returned. Left out: the newest film."),
  },
  viewer: true,
  async run(ctx, input) {
    const job = await readFilmJob(ctx, input.job_id);
    if (!job) throw new ToolRefusal(input.job_id ? "There is no film with that id for you." : "You have not asked for a film yet.");
    const asked = cairoDateTimeSortable(job.created_at);
    const base = { job_id: job.id, title: job.title, status: job.status, asked_at_cairo: asked };
    if (job.status === "queued" || job.status === "rendering") {
      const progress = job.progress ?? {};
      const waitingMinutes = (Date.now() - Date.parse(job.created_at)) / 60_000;
      const where =
        job.status === "queued"
          ? waitingMinutes > 10
            ? "It is still waiting: Phoenix's film studio has not picked it up yet (the worker may be restarting). It starts on its own."
            : "It is waiting for its turn."
          : `It is being made: ${progress.stage ?? "working"}${progress.scene && progress.scenes ? ` (scene ${progress.scene} of ${progress.scenes})` : ""}.`;
      return { summary: `The film "${job.title}", asked for ${asked} Cairo, is not ready yet. ${where}`, data: { ...base, progress } };
    }
    if (job.status === "failed") {
      return { summary: `The film "${job.title}" could not be made. ${job.error ?? ""}`.trim(), data: { ...base, error: job.error } };
    }
    const file = job.file_id ? await filmFileLink(job.file_id) : null;
    if (!file) return { summary: `The film "${job.title}" was made, but its link has expired (films are kept 7 days). Ask for it again.`, data: base };
    const url = `${connectorOrigin()}/api/connector/files/${file.id}`;
    const seconds = Number(job.duration_seconds ?? 0);
    const voice = job.voice_used === false ? " The voice-over could not be recorded, so it has captions only." : "";
    return {
      summary: `The film "${job.title}" is ready: ${lengthWords(seconds)}, ${Math.max(1, Math.round(file.sizeBytes / 1_000_000))} MB (MP4).${voice} It opens for you only, while you are signed in to Phoenix, until ${cairoDateTimeSortable(file.expiresAt)} Cairo: ${url} ${FILM_MASKED_NOTE}`,
      data: { ...base, download_url: url, expires_at: file.expiresAt, duration_seconds: seconds, size_bytes: file.sizeBytes, voice_used: job.voice_used },
      attachments: [{ type: "video", mimeType: "video/mp4", data: null, url, label: job.title }],
    };
  },
});

export const FILM_TOOLS: ConnectorTool[] = [makeFilmTool, filmStatusTool] as unknown as ConnectorTool[];
