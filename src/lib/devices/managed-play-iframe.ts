/**
 * The managed Google Play iframe — the door through which Phoenix publishes apps to the fleet.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE PLAY CONSOLE. Putting a native app on the rep tablets was
 * priced at a US$25 Play Console registration fee plus a D-U-N-S number for the organisation — and
 * the D-U-N-S half is the expensive one in Egypt, where neither of Dun & Bradstreet's self-service
 * lookups covers the country at all. Both costs belong to creating a PLAY CONSOLE account. Neither
 * applies to publishing a private app through the managed Google Play iframe, which is what an EMM
 * console does. Google states it in two places:
 *
 *   "When you publish a private app for the first time, Managed Google Play automatically creates a
 *    Play Developer account on behalf of your organization. You don't need to pay a registration fee
 *    for this account."
 *      — Managed Google Play Help, "Publish private apps from managed Play in your EMM console"
 *
 *   "The iframe's Private apps page silently creates a Play Console account on behalf of an
 *    enterprise and waives the $25 USD registration fee."
 *      — Play EMM API reference, private apps
 *
 * That free path is reachable from the API Phoenix already chose, not only from the legacy Play EMM
 * API the second quote sits under: `enterprises.webTokens` accepts `PRIVATE_APPS` as an enabled
 * feature. This module is that call and the URL it produces.
 *
 * 🔴 A WEB TOKEN IS SHORT-LIVED AND MUST NEVER BE CACHED. It is minted for one parent frame and one
 * feature set, and it expires. Storing one — in a table, in a cookie, in a module-level variable —
 * produces an iframe that renders for a while and then silently stops, which reads as "Google is
 * down" rather than "the token aged out". Mint per page load. Nothing here caches.
 *
 * 🔴 THE TOKEN IS A BEARER CREDENTIAL FOR THE ENTERPRISE. Anyone holding it can open the iframe and
 * publish to the fleet, so the route that mints one asserts a permission first and the value never
 * goes anywhere but the browser that asked for it. It is deliberately not logged.
 *
 * ON THE ONE-WAY DOOR. An app published this way is permanently private — Google's own words are
 * that such apps "can't be made public" — and the developer account the iframe creates is
 * non-transferable. That is the right trade for Phoenix, which will never have a public listing,
 * but it is not reversible and it is worth knowing before the first upload rather than after.
 *
 * AUTH IS PLUGGABLE, for the same reason it is in `android-web-app.ts` and
 * `src/lib/sales/master-map/sheets-client.ts`: the org policy on the owner's Google Cloud org
 * (`constraints/iam.disableServiceAccountKeyCreation`) blocks long-lived service-account keys, so
 * how this authenticates in production is still open. Everything here takes a bearer token it is
 * handed, so whichever route is chosen, nothing in this file changes.
 */

import {
  ANDROID_MANAGEMENT_API,
  AndroidManagementRequestError,
} from "@/lib/devices/android-web-app";

/** Google's loader for the `gapi.iframes` context. The iframe cannot be opened with a plain tag. */
export const GAPI_LOADER_URL = "https://apis.google.com/js/api.js";

/** The origin the iframe is served from — needed by the page's own CSP, so it is named once here. */
export const MANAGED_PLAY_IFRAME_ORIGIN = "https://play.google.com";

/** The iframe endpoint. `search` is the path for every page, not only the search one. */
export const MANAGED_PLAY_IFRAME_URL = `${MANAGED_PLAY_IFRAME_ORIGIN}/work/embedded/search`;

/**
 * The pages a web token can unlock, exactly as `enterprises.webTokens.enabledFeatures` names them.
 *
 * `PRIVATE_APPS` is the one this whole module exists for. The rest are listed because a token is
 * minted for a feature SET, and asking for a page the token did not enable is the failure described
 * on `buildManagedPlayIframeUrl`.
 */
export type ManagedPlayIframeFeature =
  | "PLAY_SEARCH"
  | "PRIVATE_APPS"
  | "WEB_APPS"
  | "STORE_BUILDER"
  | "MANAGED_CONFIGURATIONS"
  | "ZERO_TOUCH_CUSTOMER_MANAGEMENT";

const IFRAME_FEATURES: readonly ManagedPlayIframeFeature[] = [
  "PLAY_SEARCH",
  "PRIVATE_APPS",
  "WEB_APPS",
  "STORE_BUILDER",
  "MANAGED_CONFIGURATIONS",
  "ZERO_TOUCH_CUSTOMER_MANAGEMENT",
];

/**
 * The subset of features that are also valid landing pages (`iframehomepage`).
 *
 * `MANAGED_CONFIGURATIONS` and `ZERO_TOUCH_CUSTOMER_MANAGEMENT` are features you can enable but not
 * open the iframe ON — they are reached from inside it. Passing one as the homepage is accepted by
 * the URL and produces a blank frame.
 */
export type ManagedPlayIframeHomepage = Extract<
  ManagedPlayIframeFeature,
  "PLAY_SEARCH" | "PRIVATE_APPS" | "WEB_APPS" | "STORE_BUILDER"
>;

const IFRAME_HOMEPAGES: readonly ManagedPlayIframeHomepage[] = [
  "PLAY_SEARCH",
  "PRIVATE_APPS",
  "WEB_APPS",
  "STORE_BUILDER",
];

export function isManagedPlayIframeFeature(value: string): value is ManagedPlayIframeFeature {
  return (IFRAME_FEATURES as readonly string[]).includes(value);
}

export function isManagedPlayIframeHomepage(value: string): value is ManagedPlayIframeHomepage {
  return (IFRAME_HOMEPAGES as readonly string[]).includes(value);
}

/**
 * What Phoenix asks for by default.
 *
 * `PRIVATE_APPS` publishes the Phoenix app. `WEB_APPS` is the same iframe's page for the
 * Google-generated web app that `android-web-app.ts` builds, so both routes to a tablet icon live
 * behind one door. `PLAY_SEARCH` and `STORE_BUILDER` are what make the fleet's store useful at all —
 * approving Chrome (which a web app cannot render without) and arranging what a rep actually sees.
 */
export const PHOENIX_IFRAME_FEATURES: readonly ManagedPlayIframeFeature[] = [
  "PRIVATE_APPS",
  "WEB_APPS",
  "PLAY_SEARCH",
  "STORE_BUILDER",
];

export type ManagedPlayWebToken = {
  /** Server-assigned resource name. Kept for the record; nothing here sends it back. */
  name?: string;
  /** The credential the iframe URL carries. Short-lived. Never cache, never log. */
  value: string;
};

/**
 * Google matches the parent frame against this, so it is a security control rather than a hint —
 * "to prevent XSS, the iframe may not be hosted at other URLs".
 *
 * Requiring an origin with no query or fragment is not pedantry: a value copied out of a browser
 * address bar carries `?view=…`, the iframe then refuses to render, and the browser console says
 * nothing that points back here. Localhost is allowed over http because that is the only way to
 * develop against this at all; everything else must be https.
 */
export function assertParentFrameUrl(parentFrameUrl: string): string {
  const trimmed = parentFrameUrl.trim();
  if (!trimmed) {
    throw new Error("parentFrameUrl is required — Google refuses to frame an unnamed parent.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`parentFrameUrl must be an absolute URL — got '${trimmed}'.`);
  }

  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error(
      `parentFrameUrl must be https (http is permitted only for localhost) — got '${parsed.protocol}//${parsed.host}'.`,
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      `parentFrameUrl must carry no query string or fragment — got '${trimmed}'. Google matches the ` +
        "hosting URL exactly, and an address copied from a browser bar usually brings one along.",
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------------------------
// Minting the token
// ---------------------------------------------------------------------------------------------

/** Long enough for Google to answer, short enough that a wedged call frees the request. */
const WEB_TOKEN_TIMEOUT_MS = 20_000;

export type CreateManagedPlayWebTokenOptions = {
  /** A bearer token for `ANDROID_MANAGEMENT_SCOPE`. */
  token: string;
  /** `enterprises/LC…` — the binding, from `androidManagementConfig()`. */
  enterpriseName: string;
  /** Where the iframe will be embedded. Validated by `assertParentFrameUrl`. */
  parentFrameUrl: string;
  enabledFeatures?: readonly ManagedPlayIframeFeature[];
};

/**
 * Mint a web token for the managed Google Play iframe.
 *
 * Deliberately a thin call with no retry: a failure here is nearly always the enterprise binding or
 * the credential being wrong, and retrying a 401 three times only delays the message that says so.
 */
export async function createManagedPlayWebToken(
  options: CreateManagedPlayWebTokenOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedPlayWebToken> {
  const parentFrameUrl = assertParentFrameUrl(options.parentFrameUrl);
  const enabledFeatures = [...(options.enabledFeatures ?? PHOENIX_IFRAME_FEATURES)];

  if (enabledFeatures.length === 0) {
    throw new Error(
      "A web token with no enabled features opens an iframe with every page missing — name at least one.",
    );
  }
  for (const feature of enabledFeatures) {
    if (!isManagedPlayIframeFeature(feature)) {
      throw new Error(
        `'${feature}' is not a managed Play iframe feature. Google answers 400 for an unknown one.`,
      );
    }
  }

  const enterpriseName = options.enterpriseName.trim();
  if (!enterpriseName.startsWith("enterprises/")) {
    throw new Error(
      `The enterprise binding must start 'enterprises/' — got '${enterpriseName}'.`,
    );
  }

  const response = await fetchImpl(`${ANDROID_MANAGEMENT_API}/${enterpriseName}/webTokens`, {
    body: JSON.stringify({ enabledFeatures, parentFrameUrl }),
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(WEB_TOKEN_TIMEOUT_MS),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new AndroidManagementRequestError(
      `Android Management API POST /${enterpriseName}/webTokens failed (${response.status}): ${body}`,
      response.status,
    );
  }

  const payload = (body ? JSON.parse(body) : {}) as { name?: string; value?: string };
  const value = payload.value?.trim();
  if (!value) {
    // A 200 with no value is the one shape that would otherwise reach the browser as a URL with
    // `token=undefined`, which renders an empty frame and blames the page.
    throw new AndroidManagementRequestError(
      "Google accepted the web token request but returned no token value — the iframe cannot open without one.",
      response.status,
    );
  }
  return { name: payload.name?.trim(), value };
}

// ---------------------------------------------------------------------------------------------
// Building the iframe URL
// ---------------------------------------------------------------------------------------------

export type BuildManagedPlayIframeUrlOptions = {
  /** The `value` from `createManagedPlayWebToken`. */
  webToken: string;
  /** Which page the iframe opens on. Defaults to the private apps page — the reason for all this. */
  homepage?: ManagedPlayIframeHomepage;
  /**
   * Cross-check: the features the token was actually minted with. When given, asking for a homepage
   * the token does not enable raises here instead of rendering a blank frame.
   */
  enabledFeatures?: readonly ManagedPlayIframeFeature[];
  /** BCP 47. Google defaults to `en_US`; Phoenix is an English-language admin surface. */
  locale?: string;
  /** Google defaults this to TRUE. The private apps page has nothing to search. */
  showSearchBox?: boolean;
};

/**
 * Assemble the URL `gapi.iframes` opens.
 *
 * `mode=SELECT` is stated rather than left to the default: the alternative, `APPROVE`, is deprecated,
 * and a URL that does not say which it wants is the sort of thing that changes underneath a fleet.
 */
export function buildManagedPlayIframeUrl(options: BuildManagedPlayIframeUrlOptions): string {
  const webToken = options.webToken.trim();
  if (!webToken) {
    throw new Error("A managed Play iframe URL needs a web token — mint one first.");
  }

  const homepage = options.homepage ?? "PRIVATE_APPS";
  if (!isManagedPlayIframeHomepage(homepage)) {
    throw new Error(
      `'${homepage}' is not a valid iframe homepage. Only ${IFRAME_HOMEPAGES.join(", ")} can be ` +
        "opened directly; the others are reached from inside the iframe.",
    );
  }
  if (options.enabledFeatures && !options.enabledFeatures.includes(homepage)) {
    throw new Error(
      `The iframe is set to open on ${homepage}, but the web token does not enable it ` +
        `(it enables ${options.enabledFeatures.join(", ") || "nothing"}). The frame would render empty.`,
    );
  }

  const url = new URL(MANAGED_PLAY_IFRAME_URL);
  url.searchParams.set("token", webToken);
  url.searchParams.set("mode", "SELECT");
  url.searchParams.set("iframehomepage", homepage);
  if (options.locale?.trim()) url.searchParams.set("locale", options.locale.trim());
  if (options.showSearchBox === false) url.searchParams.set("showsearchbox", "FALSE");
  return url.toString();
}

/**
 * The same URL with the token replaced, for anything that writes it down.
 *
 * The token is a bearer credential for the whole enterprise. An error message, a breadcrumb or a
 * log line that carries the raw URL hands it to whoever reads that log, so every path that reports
 * on this URL goes through here first.
 */
export function redactWebToken(iframeUrl: string): string {
  try {
    const url = new URL(iframeUrl);
    if (url.searchParams.has("token")) url.searchParams.set("token", "REDACTED");
    return url.toString();
  } catch {
    return "[unparseable managed Play iframe URL]";
  }
}
