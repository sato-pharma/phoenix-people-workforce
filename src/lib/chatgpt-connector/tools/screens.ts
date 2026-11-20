/**
 * The two capture tools: a screenshot of a live Phoenix page, and a short video of one to three pages
 * being scrolled — both seen exactly as the person who asked (the owner or the CEO) sees them.
 *
 * Owner, 20 Nov 2026: "I WANT THE CINNECTER BE ABLE TO TAKE SCEEN SHOTS AND RE CORD VIDEOS", then the
 * choice "Data connector, production" over the masked staging inspector.
 *
 * Read-only by construction: the page path is checked before any browser opens (browser/fence.ts),
 * every request the page makes passes the GET-only fence, and the five-minute session the browser
 * signs in with is revoked when the capture ends (browser/session.ts). The picture or video is stored
 * like the connector's sheets and PDFs — a link only the same person can open, for 7 days — and shown
 * in the conversation by the capture viewer (browser/viewer.ts).
 */
import { z } from "zod";

import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";

import {
  captureScreenshot,
  CAPTURE_VIEWPORTS,
  encodeVideo,
  recordPages,
  VIDEO_MAX_PAGES,
  type CaptureViewport,
} from "../browser/capture";
import { checkCapturePath, loadSideEffectRoutes } from "../browser/fence";
import { CONNECTOR_FILE_DAYS, storeConnectorFile } from "../files";
import { defineTool, ToolRefusal, type ConnectorTool } from "../types";

/** A video bigger than this is linked, not sent inline to the viewer. */
export const INLINE_VIDEO_MAX_BYTES = 5_000_000;

const viewport = z
  .enum(Object.keys(CAPTURE_VIEWPORTS) as [CaptureViewport, ...CaptureViewport[]])
  .optional()
  .describe("The screen to see it on: desktop (1440 wide, the default), tablet (768) or mobile (390, a phone).");

const pagePath = z
  .string()
  .min(1)
  .max(400)
  .describe("The page's address inside Phoenix, starting with /, for example /employees or /employee-portals. Not a full web address.");

function browserBusy(error: unknown): never {
  if (error instanceof ToolRefusal) throw error;
  if (error instanceof ChromiumUnavailableError) {
    throw new ToolRefusal("Phoenix's browser is busy or unavailable right now. Try again in a minute.");
  }
  throw error;
}

function linkLine(url: string, expiresAt: string) {
  return `It opens for you only, while you are signed in to Phoenix, until ${cairoDateTimeSortable(expiresAt)} Cairo: ${url}`;
}

export const screenshotPageTool = defineTool({
  name: "phoenix_screenshot_page",
  title: "Screenshot a Phoenix page",
  description:
    "Take a screenshot of a live Phoenix page exactly as the signed-in person sees it, and show it in the conversation with a full-size link only they can open. Use it whenever the person asks to see, show, look at or screenshot a Phoenix screen. Give the page's address inside Phoenix (it starts with /). The page is opened read-only: nothing on it can be saved, sent or approved, and pages that change something just by being opened, downloads and sign-out are refused. fullPage captures the whole length of the page instead of the first screen.",
  input: {
    path: pagePath,
    viewport,
    fullPage: z.boolean().optional().describe("True to capture the whole page from top to bottom (up to 12,000 pixels tall)."),
  },
  viewer: true,
  async run(ctx, input) {
    const routes = loadSideEffectRoutes();
    const checked = checkCapturePath(input.path, routes);
    if (!checked.ok) throw new ToolRefusal(checked.reason);
    const screen: CaptureViewport = input.viewport ?? "desktop";
    const shot = await captureScreenshot(ctx, { path: checked.path, viewport: screen, fullPage: input.fullPage === true, routes }).catch(browserBusy);
    const takenAt = new Date().toISOString();
    const file = await storeConnectorFile(ctx, { kind: "png", title: `Phoenix ${shot.title} ${screen}`, body: shot.png });
    const stopped = shot.writesStopped > 0 ? ` ${shot.writesStopped} request(s) that would have changed something were stopped; nothing was saved.` : "";
    return {
      summary: `Screenshot of "${shot.title}" (${checked.path}) on ${screen}, seen as ${ctx.role}, taken ${cairoDateTimeSortable(takenAt)} Cairo. The picture is shown above. Full-size picture: ${linkLine(file.url, file.expiresAt)}.${stopped}`,
      data: {
        kind: "screenshot",
        page: checked.path,
        final_page: shot.finalPath,
        title: shot.title,
        viewport: screen,
        width: shot.width,
        height: shot.height,
        seen_as: ctx.role,
        taken_at_cairo: cairoDateTimeSortable(takenAt),
        download_url: file.url,
        expires_at: file.expiresAt,
        writes_stopped: shot.writesStopped,
      },
      attachments: [{ type: "image", mimeType: "image/jpeg", data: shot.previewJpeg.toString("base64"), label: shot.title }],
    };
  },
});

export const recordVideoTool = defineTool({
  name: "phoenix_record_video",
  title: "Record a video of Phoenix pages",
  description: `Record a short video (up to about 16 seconds) of one to ${VIDEO_MAX_PAGES} live Phoenix pages being opened and scrolled from top to bottom, exactly as the signed-in person sees them, and show it in the conversation with a link only they can open. Use it when the person asks for a video, a recording, a walkthrough or a screen recording of Phoenix screens. Give each page's address inside Phoenix (it starts with /). Read-only, like the screenshot tool: nothing on the pages can be saved, sent or approved.`,
  input: {
    paths: z.array(pagePath).min(1).max(VIDEO_MAX_PAGES).describe(`One to ${VIDEO_MAX_PAGES} page addresses, recorded in this order.`),
    viewport,
  },
  viewer: true,
  async run(ctx, input) {
    const routes = loadSideEffectRoutes();
    const paths: string[] = [];
    for (const raw of input.paths) {
      const checked = checkCapturePath(raw, routes);
      if (!checked.ok) throw new ToolRefusal(`${raw}: ${checked.reason}`);
      paths.push(checked.path);
    }
    const screen: CaptureViewport = input.viewport ?? "desktop";
    const recording = await recordPages(ctx, { paths, viewport: screen, routes }).catch(browserBusy);
    let encoded: Awaited<ReturnType<typeof encodeVideo>>;
    try {
      encoded = await encodeVideo(recording.frames, recording.fps);
    } catch (error) {
      if (error instanceof ToolRefusal) throw error;
      throw new ToolRefusal("Phoenix could not put the video together just now. Try again, or ask for a screenshot.");
    }
    const takenAt = new Date().toISOString();
    const title = recording.pages.map((page) => page.title).join(" · ") || "Phoenix";
    const file = await storeConnectorFile(ctx, { kind: encoded.kind, title: `Phoenix video ${title}`.slice(0, 150), body: encoded.body });
    const seconds = Math.round(recording.recordedMs / 100) / 10;
    const missed = paths.length - recording.pages.length;
    const missedLine = missed > 0 ? ` ${missed} page(s) at the end did not fit in the time and were left out.` : "";
    const stopped = recording.writesStopped > 0 ? ` ${recording.writesStopped} request(s) that would have changed something were stopped; nothing was saved.` : "";
    const mimeType = encoded.kind === "mp4" ? "video/mp4" : "video/webm";
    const inline = encoded.body.byteLength <= INLINE_VIDEO_MAX_BYTES;
    return {
      summary: `A ${seconds}-second video of ${recording.pages.map((page) => `"${page.title}"`).join(", ")} on ${screen}, seen as ${ctx.role}, recorded ${cairoDateTimeSortable(takenAt)} Cairo. ${inline ? "It plays above. " : ""}Video file (${encoded.kind.toUpperCase()}): ${linkLine(file.url, file.expiresAt)}.${missedLine}${stopped}`,
      data: {
        kind: "video",
        pages: recording.pages.map((page) => ({ path: page.path, title: page.title, final_page: page.finalPath })),
        title,
        viewport: screen,
        seconds,
        format: encoded.kind,
        size_bytes: encoded.body.byteLength,
        seen_as: ctx.role,
        taken_at_cairo: cairoDateTimeSortable(takenAt),
        download_url: file.url,
        expires_at: file.expiresAt,
        link_days: CONNECTOR_FILE_DAYS,
        writes_stopped: recording.writesStopped,
      },
      attachments: [{ type: "video", mimeType, data: inline ? encoded.body.toString("base64") : null, url: file.url, label: title }],
    };
  },
});

export const CAPTURE_TOOLS: ConnectorTool[] = [screenshotPageTool, recordVideoTool] as unknown as ConnectorTool[];
