// Where Chromium is, and how the PDF driver is loaded. One copy, for every document that needs one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS SHARED AND THE RENDER OPTIONS ARE NOT. Two very different documents now need headless
// Chromium — an offer letter, and a signed hiring paper being filed — and they agree on exactly one
// thing: which binary to run and how to load the driver. Everything else differs, and should. The
// offer sets explicit margins and running headers; a hiring paper must take its geometry from its
// own `@page` rule and nothing else, because its fields are placed at measured points on scanned
// government artwork. So the plumbing lives here and each caller keeps its own `page.pdf()` options
// beside the document they belong to.
//
// The alternative — a second copy of the path resolution below — is the failure this is placed to
// avoid: the Alpine binary name has already moved once, and finding out that only one of two copies
// was updated would mean discovering it in whichever feature nobody exercised that week.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE RUNTIME CONTRACT, provisioned in the Dockerfile long before any of this existed. Chromium is
// the SYSTEM package (`apk add chromium`), never Puppeteer's bundled download, which is a glibc
// binary that cannot run on Alpine/musl. `puppeteer-core` is installed into the runtime
// node_modules by hand because Next's standalone file-tracing cannot follow a dynamic import —
// which is exactly why the import below is dynamic and marked `webpackIgnore`/`turbopackIgnore`.
// It must never be traced into a bundle and never reach a client one.

import { existsSync } from "node:fs";

/** Thrown when the runtime cannot produce a PDF at all. Callers decide what to do without one. */
export class ChromiumUnavailableError extends Error {
  // NOT a TypeScript parameter property. The test runner executes TypeScript through Node's
  // strip-only mode, which cannot compile one — it throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at
  // import time, so every test that touched this module would fail before its first assertion.
  readonly reason: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = "ChromiumUnavailableError";
    this.reason = reason;
  }
}

/**
 * Thrown when every Chromium slot stayed taken for the whole wait. It IS a
 * `ChromiumUnavailableError`, so every caller that already degrades on "no PDF could be rendered"
 * degrades on "the renderer is busy" the same way, with no new branch to forget.
 */
export class ChromiumBusyError extends ChromiumUnavailableError {
  constructor(message: string, reason?: unknown) {
    super(message, reason);
    this.name = "ChromiumBusyError";
  }
}

export type SlotLimiter = {
  /** Resolves with a release function once a slot is free; rejects with ChromiumBusyError on timeout. */
  acquire: () => Promise<() => void>;
};

/**
 * At most `limit` holders at once; the rest wait in arrival order (FIFO), each for at most `waitMs`.
 *
 * WHY A LIMIT AT ALL (PERF-005). Every `withChromiumPage` call launches a whole Chromium — a few
 * hundred MB each — and nothing bounded how many ran at once, so a burst of exports (a manager
 * clicking down a list of milestone cards, two admins printing payslips) launched one browser per
 * click on the single production container until it ran out of memory and restarted. Two at a
 * time keeps the common case instant and turns a burst into a short queue instead of an OOM.
 *
 * A waiter that times out is REMOVED from the queue before it rejects, so a slot freed later is
 * never handed to a caller who has already given up (which would leak that slot forever). The
 * release function is idempotent for the same reason: a double release must not mint a slot.
 */
export function createSlotLimiter(limit: number, waitMs: number): SlotLimiter {
  let active = 0;
  const waiters: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  function makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) {
        // Hand the slot straight to the oldest waiter: `active` does not change.
        clearTimeout(next.timer);
        next.grant();
        return;
      }
      active -= 1;
    };
  }

  return {
    acquire() {
      if (active < limit) {
        active += 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise<() => void>((resolve, reject) => {
        const waiter = {
          grant: () => resolve(makeRelease()),
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            reject(
              new ChromiumBusyError(
                `Every PDF renderer stayed busy for ${Math.round(waitMs / 1000)}s, so this document was not rendered.`,
              ),
            );
          }, waitMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

/** The one process-wide limit on concurrent Chromium browsers for document rendering. */
export const chromiumSlots = createSlotLimiter(2, 60_000);

/**
 * Run `fn` while holding a Chromium slot, and always give the slot back — even when `fn` throws.
 *
 * 🔴 NEVER NEST: a callback holding a slot that renders another document waits for a slot it may
 * itself be blocking, and two such callers deadlock until the wait times out. The Turbify mailbox
 * robots launch their own browser through `loadPuppeteer` and are deliberately NOT limited here.
 */
export async function withChromiumSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await chromiumSlots.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Where Chromium actually is — checked on disk, not assumed.
 *
 * The Dockerfile sets `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser`, which was the binary
 * name Alpine used up to 3.18; since then `apk add chromium` installs `/usr/bin/chromium` and ships
 * `chromium-browser` only as a compatibility symlink that is not guaranteed to be there. A wrong
 * path does not fail loudly — `launch()` throws and the caller degrades — so the configured path is
 * honoured only when it exists, and the known Alpine/Debian locations are tried after it.
 *
 * Returning `undefined` is the local-dev case (Windows/macOS): puppeteer-core then falls back to
 * its own channel discovery and finds an installed Chrome.
 */
export function resolveChromiumPath(
  exists: (path: string) => boolean = fileExists,
  // A plain string rather than an env object. `NodeJS.ProcessEnv` cannot be handed an object
  // literal from a test, and a structural stand-in hits TypeScript's weak-type rule from the other
  // direction — and neither type is honest anyway: this reads exactly one variable, so that
  // variable is the parameter.
  configuredPath: string = process.env.PUPPETEER_EXECUTABLE_PATH ?? "",
): string | undefined {
  const configured = configuredPath.trim();
  const candidates = [
    configured,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter((path) => path !== "");
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export type ChromiumPage = {
  close: () => Promise<void>;
  emulateMediaType: (type: string) => Promise<void>;
  evaluate: (fn: string) => Promise<unknown>;
  // Navigate, for the one case where the document's ORIGIN matters rather than its content: the
  // Maps JavaScript API browser key is HTTP-referrer restricted, so a map drawn from `setContent`
  // alone is refused with `gm_authFailure` — `about:blank` matches no referrer (measured 2026-09-29
  // against both keys). Going to the app's own origin first and THEN calling `setContent` keeps
  // that URL, so the referrer matches and the key is accepted. Nothing else here needs it.
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  pdf: (options: Record<string, unknown>) => Promise<Uint8Array>;
  // Ignore the Content-Security-Policy of the document the page navigates to. Only the street map
  // needs it: it borrows the app's /login page for its ORIGIN (see `goto`), and that page's policy
  // admits only scripts carrying its own per-request nonce — so the map's inline script and the Maps
  // API script would be refused and the PDF would fall back to the plain diagram. Puppeteer applies
  // it to later navigations, so it is called BEFORE `goto`.
  setBypassCSP: (enabled: boolean) => Promise<void>;
  // A raster of the page, for the documents somebody needs as a PICTURE rather than as paper — a
  // keepsake to send in a message, a card to put in a slide. The resolution comes from the
  // viewport's `deviceScaleFactor`, never from the screenshot options, which is why `setViewport`
  // is exposed beside it: a screenshot taken without setting one is a 800×600 thumbnail of the
  // corner of a document, and it fails by looking merely disappointing rather than broken.
  screenshot: (options: Record<string, unknown>) => Promise<Uint8Array>;
  setContent: (html: string, options: Record<string, unknown>) => Promise<void>;
  // 🔴 THE ONE MEMBER THAT CANNOT BE A LOOSE RECORD. Every other option bag here is
  // `Record<string, unknown>`, and that is safe because puppeteer's own option types are entirely
  // OPTIONAL — a record satisfies them. `Viewport` is not: `width` and `height` are required, so a
  // record is missing them, the real `Page` stops being comparable to this type, and the failure
  // does not land here at all. It lands on the cast in `loadPuppeteer` as TS2352 "neither type
  // sufficiently overlaps", which reads like a problem with the import. Name the two fields.
  setViewport: (viewport: { width: number; height: number; deviceScaleFactor?: number }) => Promise<void>;
};

export type ChromiumBrowser = {
  close: () => Promise<void>;
  newPage: () => Promise<ChromiumPage>;
};

export type PuppeteerModule = {
  launch: (options: Record<string, unknown>) => Promise<ChromiumBrowser>;
};

let cached: PuppeteerModule | null = null;

export async function loadPuppeteer(): Promise<PuppeteerModule> {
  if (cached) return cached;
  try {
    // The ignore comments are load-bearing: without them the bundler traces puppeteer-core into the
    // build, which is both enormous and wrong — the Dockerfile installs it separately at runtime
    // precisely because it must not be bundled.
    const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "puppeteer-core")) as
      | PuppeteerModule
      | { default: PuppeteerModule };
    cached = "launch" in mod ? mod : mod.default;
    return cached;
  } catch (error) {
    throw new ChromiumUnavailableError(
      "puppeteer-core is not installed in this runtime, so no PDF can be rendered.",
      error,
    );
  }
}

/** Whether this runtime can render a PDF at all, without rendering one. */
export async function isChromiumAvailable(): Promise<boolean> {
  try {
    await loadPuppeteer();
    return true;
  } catch {
    return false;
  }
}

/**
 * Launch Chromium, hand a page to `use`, and always close the browser.
 *
 * THE `finally` IS THE POINT. One leaked Chromium per document would exhaust the container's memory
 * within a day of ordinary HR use, and the symptom — a container restarting under load — looks
 * nothing like the feature that caused it.
 *
 * `--disable-dev-shm-usage` is not optional: the container has a small `/dev/shm` and Chromium
 * crashes on larger documents without it. A hiring paper carrying three pages of scanned government
 * artwork is exactly a larger document.
 */
export async function withChromiumPage<T>(render: (page: ChromiumPage) => Promise<T>): Promise<T> {
  const puppeteer = await loadPuppeteer();
  // The slot wraps the launch AND the close, so it is given back only once this browser is gone —
  // releasing it before `browser.close()` would let a third Chromium start while the second is
  // still resident, which is the overlap the limit exists to prevent. A busy timeout rejects with
  // ChromiumBusyError, which is a ChromiumUnavailableError, so callers degrade exactly as before.
  return withChromiumSlot(async () => {
    let browser: ChromiumBrowser | null = null;
    try {
      // ── ONE OF THESE TWO, NEVER NEITHER ──────────────────────────────────────────────────────
      // `puppeteer-core` ships no browser and does NO discovery of its own: given neither an
      // `executablePath` nor a `channel` it refuses outright with "An `executablePath` or `channel`
      // must be specified for `puppeteer-core`". In the container the path always resolves, so the
      // channel below is never reached there. On a developer's Windows or macOS machine nothing
      // resolves, and asking for the installed Chrome is what makes the feature testable at all
      // before it ships — measured 2026-09-04, where launching with neither produced exactly that
      // error and `channel: "chrome"` launched immediately.
      const executablePath = resolveChromiumPath();
      browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        headless: true,
        ...(executablePath ? { executablePath } : { channel: "chrome" }),
      });
      const page = await browser.newPage();
      return await render(page);
    } catch (error) {
      if (error instanceof ChromiumUnavailableError) throw error;
      throw new ChromiumUnavailableError("Chromium failed to render the document.", error);
    } finally {
      if (browser) await browser.close().catch(() => undefined);
    }
  });
}
