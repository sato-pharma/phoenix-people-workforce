/**
 * Whose code is in the stack? — attribution, never blame.
 *
 * The Error Monitor lists a client error by its message, and a minified message says nothing
 * about where the throw came from. On 2026-09-09 ten rows on /employee-portals/submit-expense
 * read `undefined is not an object (evaluating 'this.rh.get(b).filter')` and
 * `null is not an object (evaluating 'C0[c].indexOf')` — shapes indistinguishable from an app
 * bug, on the page a medical rep files a trip claim from. Every frame of every one of them sat
 * inside `maps.googleapis.com/maps-api-v3/.../webgl.js`: Google's own vector-map renderer
 * failing on iOS Safari. Nobody was blocked — both people submitted, 40 seconds and 6 minutes
 * later, for 482.70 and 815 EGP. The rows were read as an Outstation defect and triaged as one,
 * which is the cost this exists to remove.
 *
 * `cross-origin-masked.ts` opens by stating this app loads NO third-party scripts. That was
 * true when it was written and is not any more: `src/lib/google-maps/browser.ts` injects the
 * Maps API on every page that draws a map. So the browser no longer has to mask a foreign throw
 * for one to arrive — Maps serves CORS headers, so its failures land in full, with a real stack,
 * and read exactly like ours.
 *
 * WHAT THIS CLAIMS, EXACTLY. That every frame it could locate belongs to a script this app does
 * not ship. It does NOT claim the throw is the other script's fault: our own bad argument can
 * make a library throw entirely inside itself. The label names WHERE the frames are, which is a
 * fact, and the raw message is kept verbatim beside it. Nothing here suppresses anything — the
 * sibling module's rule stands, and hiding a diagnosable error costs far more than keeping a
 * noisy one.
 */

import { systemDeployment } from "@/config/system-settings";

/**
 * A stack FRAME, not merely a URL. The `:line:col` suffix is the whole point of the pattern:
 * a React minified error carries `visit https://react.dev/errors/418?args[]=text` inside its own
 * message, and matching bare URLs would read that documentation link as the thrower and label
 * every hydration error in the table as third-party — the precise inversion of this module.
 *
 * The three leading forms are the three the browsers emit: `name@url:l:c` (Safari, Firefox),
 * `at name (url:l:c)` and `at url:l:c` (Chromium).
 */
const FRAME_PATTERN =
  /(?:@|\(|\bat\s+)((?:https?|chrome-extension|moz-extension|safari-web-extension):\/\/[^\s)]+?):\d+:\d+/g;

/** Every chunk this app serves is under this path, on any host it is ever deployed to. */
const APP_CHUNK_PREFIX = "/_next/";

export type ThirdPartyStack = {
  /** How many located frames there were. All of them are off-app, or this is not returned. */
  frameCount: number;
  /** Host for a web script; the generic phrase for an extension, whose id names nothing. */
  label: string;
};

let cachedAppHost: string | null = null;

function appHost(): string {
  if (cachedAppHost === null) {
    try {
      cachedAppHost = new URL(systemDeployment.productionUrl).host;
    } catch {
      cachedAppHost = "";
    }
  }
  return cachedAppHost;
}

function isWebFrame(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * The host is checked as well as the chunk path so that an inline script on one of our own
 * pages — which carries the page's URL and no `/_next/` — is still read as ours.
 */
function isAppFrame(url: URL): boolean {
  if (!isWebFrame(url)) return false;
  if (url.pathname.startsWith(APP_CHUNK_PREFIX)) return true;
  return url.host === appHost();
}

/**
 * Describes the stack when EVERY located frame is off-app, and null otherwise — including for a
 * stack with no locatable frames at all, which is what a server throw looks like (its frames are
 * filesystem paths under /app/node_modules, not URLs). One app frame anywhere is enough to
 * return null: a mixed stack means our code is on the path and the row must read as ours.
 */
export function describeThirdPartyStack(stack: string | null | undefined): ThirdPartyStack | null {
  if (!stack) return null;

  let frameCount = 0;
  let label: string | null = null;

  for (const match of stack.matchAll(FRAME_PATTERN)) {
    let url: URL;
    try {
      url = new URL(match[1]);
    } catch {
      continue;
    }
    if (isAppFrame(url)) return null;
    frameCount += 1;
    // The FIRST frame is the throw site, so it is the one worth naming.
    if (label === null) label = isWebFrame(url) ? url.host : "a browser extension";
  }

  if (frameCount === 0 || label === null) return null;
  return { frameCount, label };
}

/** Admin-facing text. Leads with the attribution, because that is what stops the wrong triage. */
export function thirdPartyStackDisplay(label: string, message: string): string {
  return `Third-party script (${label}) — ${message}`;
}
