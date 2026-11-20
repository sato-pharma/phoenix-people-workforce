/**
 * The capture browser: opens a LIVE Phoenix page as the person who asked ChatGPT and hands back a
 * screenshot, or records a short video of one to three pages being scrolled.
 *
 * It is the same system Chromium the PDF printer uses (src/lib/pdf/chromium.ts — one of its two slots,
 * so a capture can never be the third browser in the container), pointed at the app's OWN loopback
 * address, signed in with a five-minute session minted for this one capture (session.ts) and revoked
 * afterwards. Every request goes through the read-only fence (fence.ts) first; a page-side stub also
 * swallows beacons and non-GET fetches, the route the staging inspector once saw slip past. Service
 * workers are bypassed, downloads are denied, dialogs are dismissed and any popup is closed.
 *
 * The video is built from frames, not a screen recorder: a JPEG of the viewport is taken as fast as
 * the browser gives one while the page is held and scrolled step by step, and ffmpeg (installed in the
 * runtime image) joins them at the rate they were actually taken, so it plays at real speed. MP4
 * (H.264) when this ffmpeg has libx264, otherwise WebM (VP8).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemDeployment } from "@/config/system-settings";
import type { AccessContext } from "@/lib/auth/permissions";
import { loadPuppeteer, resolveChromiumPath, withChromiumSlot } from "@/lib/pdf/chromium";

import { connectorOrigin } from "../oauth";
import { ToolRefusal } from "../types";
import { classifyCaptureRequest, type FencePolicy, type SideEffectRoutes } from "./fence";
import { mintCaptureSession, revokeCaptureSession, type CaptureSession } from "./session";

export const CAPTURE_VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;
export type CaptureViewport = keyof typeof CAPTURE_VIEWPORTS;

const MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

/** The whole capture must end well inside the connector's 40 s limit. */
export const CAPTURE_DEADLINE_MS = 34_000;
const PAGE_LOAD_MS = 12_000;
const SETTLE_MS = 5_000;
/** Recorded time across all pages, and the most for one page. */
export const VIDEO_RECORD_MS = 16_000;
const VIDEO_PAGE_MS = 9_000;
export const VIDEO_MAX_PAGES = 3;
const VIDEO_MAX_FRAMES = 320;
const FULL_PAGE_MAX_HEIGHT = 12_000;

/** The loopback address of THIS server; PORT is 8080 in the image (Dockerfile), 3000 on a laptop. */
export function captureOrigin(env: Record<string, string | undefined> = process.env): string {
  const configured = (env.PHOENIX_CAPTURE_ORIGIN ?? "").trim();
  if (configured) return new URL(configured).origin;
  return `http://127.0.0.1:${(env.PORT ?? "").trim() || "3000"}`;
}

function sameAppOrigins(): string[] {
  const out = new Set<string>();
  for (const value of [connectorOrigin(), systemDeployment.productionUrl]) {
    try {
      out.add(new URL(value).origin);
    } catch {
      // an unparseable configured origin is simply not added
    }
  }
  return [...out];
}

// ── The slice of puppeteer this file drives (puppeteer-core is loaded dynamically, untyped) ───────
type CaptureRequest = {
  method: () => string;
  url: () => string;
  headers: () => Record<string, string>;
  isNavigationRequest: () => boolean;
  continue: () => Promise<void>;
  respond: (response: { status: number; body?: string; contentType?: string }) => Promise<void>;
  abort: (reason?: string) => Promise<void>;
};
type CaptureDialog = { dismiss: () => Promise<void> };
type CdpSession = { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
type CapturePage = {
  close: () => Promise<void>;
  on: (event: string, handler: (arg: never) => void) => void;
  setRequestInterception: (enabled: boolean) => Promise<void>;
  setBypassServiceWorker: (bypass: boolean) => Promise<void>;
  setViewport: (viewport: { width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean }) => Promise<void>;
  setUserAgent: (userAgent: string) => Promise<void>;
  setCookie: (...cookies: Array<Record<string, unknown>>) => Promise<void>;
  evaluateOnNewDocument: (script: string) => Promise<unknown>;
  evaluate: (script: string) => Promise<unknown>;
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  waitForNetworkIdle: (options?: Record<string, unknown>) => Promise<void>;
  screenshot: (options: Record<string, unknown>) => Promise<Uint8Array>;
  title: () => Promise<string>;
  url: () => string;
  createCDPSession: () => Promise<CdpSession>;
};
type CaptureTarget = { type: () => string; page: () => Promise<CapturePage | null> };
type CaptureBrowser = {
  close: () => Promise<void>;
  newPage: () => Promise<CapturePage>;
  on: (event: string, handler: (target: CaptureTarget) => void) => void;
};

/** Page-side belt: a beacon or a non-GET fetch never leaves the page, even from a closing one. */
const PAGE_STUBS = `(() => {
  try { Object.defineProperty(navigator, "sendBeacon", { value: () => true, configurable: false }); } catch (e) {}
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const method = String((init && init.method) || (input && typeof input === "object" && input.method) || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return Promise.resolve(new Response(null, { status: 204 }));
    return realFetch(input, init);
  };
})();`;

/** Scrolls whatever actually scrolls (the window, or the admin shell's own pane) by one step. */
const SCROLL_STEP = (fraction: number) => `(() => {
  const candidates = [document.scrollingElement, ...document.querySelectorAll("main, [data-scroll-root], div")];
  let target = null;
  for (const el of candidates) {
    if (!el) continue;
    const style = el === document.scrollingElement ? null : getComputedStyle(el);
    const scrolls = el === document.scrollingElement || /(auto|scroll)/.test(style.overflowY);
    if (scrolls && el.scrollHeight - el.clientHeight > 40 && el.clientHeight > window.innerHeight * 0.5) { target = el; break; }
  }
  if (!target) return { atEnd: true };
  const step = Math.round(target.clientHeight * ${fraction});
  target.scrollBy({ top: step, behavior: "smooth" });
  return { atEnd: target.scrollTop + target.clientHeight >= target.scrollHeight - 4 };
})()`;

type OpenedBrowser = { page: CapturePage; stopped: () => number; finish: () => Promise<void> };

async function openSignedInPage(ctx: AccessContext, viewport: CaptureViewport, routes: SideEffectRoutes): Promise<OpenedBrowser> {
  const puppeteer = await loadPuppeteer();
  const origin = captureOrigin();
  const policy: FencePolicy = { origin, sameAppOrigins: sameAppOrigins(), routes };
  let session: CaptureSession | null = null;
  let browser: CaptureBrowser | null = null;
  let stopped = 0;
  const finish = async () => {
    if (browser) await browser.close().catch(() => undefined);
    await revokeCaptureSession(session);
  };
  try {
    session = await mintCaptureSession(ctx);
    const executablePath = resolveChromiumPath();
    browser = (await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--mute-audio", "--hide-scrollbars"],
      headless: true,
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
    })) as unknown as CaptureBrowser;
    const page = await browser.newPage();
    // A popup or a new tab would not carry this page's fence: close it the moment it appears.
    browser.on("targetcreated", (target) => {
      if (target.type() !== "page") return;
      void target.page().then((other) => (other && other !== page ? other.close() : undefined)).catch(() => undefined);
    });
    try {
      const cdp = await page.createCDPSession();
      await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => cdp.send("Page.setDownloadBehavior", { behavior: "deny" }));
    } catch {
      // the fence already refuses every download route; this is a belt
    }
    await page.setBypassServiceWorker(true);
    const shape = CAPTURE_VIEWPORTS[viewport];
    await page.setViewport({ ...shape });
    if (shape.isMobile) await page.setUserAgent(MOBILE_USER_AGENT);
    await page.evaluateOnNewDocument(PAGE_STUBS);
    await page.setRequestInterception(true);
    page.on("request", ((request: CaptureRequest) => {
      const decision = classifyCaptureRequest({ method: request.method(), url: request.url(), headers: request.headers() }, policy);
      if (decision.allow) {
        request.continue().catch(() => undefined);
        return;
      }
      stopped += 1;
      request.respond({ status: 204, body: "" }).catch(() => request.abort("blockedbyclient").catch(() => undefined));
    }) as never);
    page.on("dialog", ((dialog: CaptureDialog) => {
      dialog.dismiss().catch(() => undefined);
    }) as never);
    await page.setCookie({
      name: session.cookieName,
      value: session.cookieValue,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https:"),
    });
    return { page, stopped: () => stopped, finish };
  } catch (error) {
    await finish();
    throw error;
  }
}

async function goTo(page: CapturePage, path: string, deadline: number): Promise<{ title: string; finalPath: string }> {
  const origin = captureOrigin();
  const budget = Math.max(2_000, Math.min(PAGE_LOAD_MS, deadline - Date.now() - 4_000));
  try {
    await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: budget });
  } catch {
    // A slow page is captured as far as it got; a page that never painted shows as blank, honestly.
  }
  await page.waitForNetworkIdle({ idleTime: 600, timeout: Math.max(500, Math.min(SETTLE_MS, deadline - Date.now() - 3_000)) }).catch(() => undefined);
  const finalUrl = new URL(page.url() || `${origin}/`);
  if (finalUrl.pathname === "/login") throw new ToolRefusal("Phoenix sent the capture browser to the sign-in page, so nothing was captured. Try again in a minute.");
  return { title: (await page.title().catch(() => "")) || path, finalPath: `${finalUrl.pathname}${finalUrl.search}` };
}

function checkDeadline(deadline: number) {
  if (Date.now() > deadline) throw new ToolRefusal("The capture ran out of time. Ask for one page, or a shorter video.");
}

export type ScreenshotResult = {
  png: Buffer;
  previewJpeg: Buffer;
  title: string;
  finalPath: string;
  width: number;
  height: number;
  writesStopped: number;
};

export async function captureScreenshot(
  ctx: AccessContext,
  input: { path: string; viewport: CaptureViewport; fullPage: boolean; routes: SideEffectRoutes },
): Promise<ScreenshotResult> {
  const deadline = Date.now() + CAPTURE_DEADLINE_MS;
  return withChromiumSlot(async () => {
    checkDeadline(deadline - 8_000);
    const opened = await openSignedInPage(ctx, input.viewport, input.routes);
    try {
      const { title, finalPath } = await goTo(opened.page, input.path, deadline);
      const shape = CAPTURE_VIEWPORTS[input.viewport];
      let height: number = shape.height;
      let clip: Record<string, number> | undefined;
      if (input.fullPage) {
        const measured = Number(
          await opened.page.evaluate("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)"),
        );
        height = Math.min(FULL_PAGE_MAX_HEIGHT, Number.isFinite(measured) && measured > 0 ? measured : shape.height);
        clip = { x: 0, y: 0, width: shape.width, height };
      }
      const shotOptions = clip ? { clip, captureBeyondViewport: true } : {};
      const png = Buffer.from(await opened.page.screenshot({ type: "png", ...shotOptions }));
      let previewJpeg = Buffer.from(await opened.page.screenshot({ type: "jpeg", quality: 60, ...shotOptions }));
      if (previewJpeg.byteLength > 2_500_000) previewJpeg = Buffer.from(await opened.page.screenshot({ type: "jpeg", quality: 55 }));
      return { png, previewJpeg, title, finalPath, width: shape.width, height, writesStopped: opened.stopped() };
    } finally {
      await opened.finish();
    }
  });
}

export type VideoResult = {
  frames: Buffer[];
  fps: number;
  recordedMs: number;
  pages: Array<{ path: string; title: string; finalPath: string }>;
  writesStopped: number;
};

export async function recordPages(
  ctx: AccessContext,
  input: { paths: string[]; viewport: CaptureViewport; routes: SideEffectRoutes },
): Promise<VideoResult> {
  const deadline = Date.now() + CAPTURE_DEADLINE_MS - 6_000; // leave room to encode and store
  return withChromiumSlot(async () => {
    checkDeadline(deadline - 8_000);
    const opened = await openSignedInPage(ctx, input.viewport, input.routes);
    const frames: Buffer[] = [];
    let recordedMs = 0;
    const pages: VideoResult["pages"] = [];
    const grab = async () => {
      if (frames.length >= VIDEO_MAX_FRAMES) return;
      frames.push(Buffer.from(await opened.page.screenshot({ type: "jpeg", quality: 62, optimizeForSpeed: true })));
    };
    const hold = async (ms: number, pageEnd: number) => {
      const started = Date.now();
      const end = Math.min(started + ms, pageEnd, deadline);
      while (Date.now() < end && frames.length < VIDEO_MAX_FRAMES) await grab();
      recordedMs += Date.now() - started;
    };
    try {
      for (const path of input.paths) {
        if (Date.now() > deadline - 3_000 || recordedMs >= VIDEO_RECORD_MS) break;
        const { title, finalPath } = await goTo(opened.page, path, deadline);
        pages.push({ path, title, finalPath });
        const pageBudget = Math.min(VIDEO_PAGE_MS, VIDEO_RECORD_MS - recordedMs);
        const pageEnd = Date.now() + pageBudget;
        await hold(1_400, pageEnd);
        while (Date.now() < pageEnd - 800 && Date.now() < deadline) {
          const step = (await opened.page.evaluate(SCROLL_STEP(0.55)).catch(() => ({ atEnd: true }))) as { atEnd?: boolean };
          await hold(500, pageEnd);
          if (step?.atEnd) break;
        }
        await hold(900, pageEnd);
      }
      if (frames.length < 2) throw new ToolRefusal("The video came out empty. Try one page at a time.");
      const fps = Math.min(30, Math.max(2, frames.length / Math.max(0.5, recordedMs / 1000)));
      return { frames, fps, recordedMs, pages, writesStopped: opened.stopped() };
    } finally {
      await opened.finish();
    }
  });
}

// ── ffmpeg ──────────────────────────────────────────────────────────────────────────────────────

export function ffmpegPath(env: Record<string, string | undefined> = process.env): string {
  return (env.PHOENIX_FFMPEG_PATH ?? "").trim() || "ffmpeg";
}

function run(command: string, args: string[], stdin?: Buffer[], timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 400_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 20_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => undefined); // ffmpeg closing early is reported by its exit code
    (async () => {
      for (const chunk of stdin ?? []) {
        if (!child.stdin.write(chunk)) await new Promise((done) => child.stdin.once("drain", done));
      }
      child.stdin.end();
    })().catch(() => undefined);
  });
}

let encoders: Promise<{ h264: boolean; vp8: boolean }> | null = null;
export function videoEncoders(command = ffmpegPath()): Promise<{ h264: boolean; vp8: boolean }> {
  if (!encoders) {
    encoders = run(command, ["-hide_banner", "-encoders"], undefined, 10_000)
      .then(({ stdout }) => ({ h264: /\blibx264\b/.test(stdout), vp8: /\b(?:libvpx|vp8)\b/.test(stdout) }))
      .catch(() => ({ h264: false, vp8: false }));
    // A missing ffmpeg is not remembered forever: the next call asks again.
    void encoders.then((found) => {
      if (!found.h264 && !found.vp8) encoders = null;
    });
  }
  return encoders;
}

/** The ffmpeg arguments for one encode. Exported for the tests. */
export function ffmpegArgs(fps: number, codec: "h264" | "vp8", outFile: string): string[] {
  const input = ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", fps.toFixed(3), "-i", "pipe:0", "-an"];
  const output =
    codec === "h264"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4"]
      : ["-c:v", "vp8", "-qmin", "0", "-qmax", "50", "-crf", "10", "-b:v", "1M", "-deadline", "realtime", "-speed", "8", "-f", "webm"];
  return [...input, ...output, outFile];
}

export async function encodeVideo(frames: Buffer[], fps: number): Promise<{ body: Buffer; kind: "mp4" | "webm" }> {
  const command = ffmpegPath();
  const found = await videoEncoders(command);
  if (!found.h264 && !found.vp8) {
    throw new ToolRefusal("Phoenix's video recorder (ffmpeg) is not installed on this server yet, so no video was made. A screenshot works.");
  }
  const codec = found.h264 ? "h264" : "vp8";
  const kind = codec === "h264" ? "mp4" : "webm";
  const outFile = join(tmpdir(), `phoenix-capture-${randomUUID()}.${kind}`);
  try {
    const { code, stderr } = await run(command, ffmpegArgs(fps, codec, outFile), frames);
    if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.split("\n")[0] ?? ""}`);
    return { body: await readFile(outFile), kind };
  } finally {
    await unlink(outFile).catch(() => undefined);
  }
}
