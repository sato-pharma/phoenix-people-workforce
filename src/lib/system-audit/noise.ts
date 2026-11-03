import { isBenignClientDisconnect } from "@/lib/error-monitor/benign-disconnect";
import { isCrossOriginMaskedMessage } from "@/lib/error-monitor/cross-origin-masked";
import { extractTopComponent } from "@/lib/error-monitor/message-decode";
import { describeThirdPartyStack } from "@/lib/error-monitor/third-party-stack";
import { isStaleDeployChunkError, isTransientRouterMountError } from "@/lib/utils/stale-deploy-recovery";
import type { AppErrorEventRow } from "@/lib/system-audit/signature";

/**
 * Which `app_error_events` rows are NOT a failure a person met, and why — every exclusion named.
 *
 * The audit counts each excluded row under its class on the detector run (`excluded_counts`), so
 * a row leaving the ledger is a number someone can read, never a silent drop. The rules are
 * deliberately narrow, because a filter that hides a genuine fault is worse than the noise it
 * removes (benign-disconnect.ts says the same, about "Connection closed.", which is KEPT here too).
 *
 * Measured on production 2026-10-23 (7,980 rows since 25 Jul): 24% are the browser's masked
 * "Script error." placeholder. A masked row WITH a frame of our own in its stack is kept — the
 * browser masked it, but our code was on the path.
 *
 * A TEST ACCOUNT's row is not noise: the failure was real, a person (the owner, testing) met it.
 * It is kept and flagged `is_test`, so the page hides it by default without the count losing it.
 */

export const APP_ERROR_NOISE_CLASSES = [
  "development",
  "masked_script_error",
  "browser_network",
  "browser_injected_script",
  "benign_disconnect",
  "stale_deploy_chunk",
  "router_mount_recovered",
  "test_account",
] as const;
export type AppErrorNoiseClass = (typeof APP_ERROR_NOISE_CLASSES)[number];

/** The classes that leave the ledger. `test_account` stays, flagged. */
export const EXCLUDED_NOISE_CLASSES: ReadonlySet<AppErrorNoiseClass> = new Set([
  "development",
  "masked_script_error",
  "browser_network",
  "browser_injected_script",
  "benign_disconnect",
  "stale_deploy_chunk",
  "router_mount_recovered",
]);

/** Every test account's login starts with this (src/lib/auth/test-persona.ts TEST_ACCOUNT_LOGIN_PREFIX). */
const TEST_LOGIN_PREFIX = "test-";

/**
 * The owner's hourly health-check and synthetic-journey login: a Super Admin with `hr_id` NULL by
 * standing rule (memory: admin-hr-null-super-admin-is-the-health-check-service-account), listed
 * the same way activity/service.ts lists it as a machine login.
 */
const HEALTH_CHECK_LOGIN_IDS = new Set(["admin-hr"]);

/**
 * The browser's own words when a page's fetch is cut off. Exact, and client-only: a SERVER "fetch
 * failed" is our call to Supabase failing, which is a real fault.
 */
const BROWSER_NETWORK_MESSAGES = new Set([
  "load failed",
  "failed to fetch",
  "error in input stream",
  "network error",
  "networkerror when attempting to fetch resource.",
]);

/**
 * Scripts a BROWSER runs inside our page: Brave on iPhone injects a crypto-wallet shim
 * (`window.ethereum.selectedAddress = undefined`) and an ad-block selector poller
 * (`n.standardSelectors`) as page scripts. Their frame is the page's own URL, so hasAppFrame reads
 * them as ours — but nothing in src/, app/ or public/ names either word (the test pins that).
 * Production, 31 Oct 2026: 27 + 1 rows, every one Brave on iPhone, five audit issues opened for a
 * fault no change of ours can reach. Matched on the raw message, which may be the JSON the browser's
 * own error event was stored as. Firefox on iPhone's reader-mode script (`window.__firefox__.reader`)
 * is the same thing: 2 rows in 30 days to 3 Nov 2026.
 */
const BROWSER_INJECTED_SCRIPT = /\bwindow\.ethereum\.selectedAddress\b|'[\w$]+\.standardSelectors'|\bwindow\.__firefox__\b/;

/**
 * Node's own stack when the CALLER hung up while the request was still arriving: a phone lost signal
 * mid-upload, and the route's read of the body threw. Nothing of ours failed and nobody was waiting
 * for the answer, yet each one wrote a "hidden from the caller" row and often its route's own "failed"
 * row too (68 rows in 30 days to 3 Nov 2026). Server rows only, and matched on the stack, because the
 * message is whatever the route wrote. The person's own picture of the failed request stays.
 */
const CALLER_HUNG_UP = /\bError: aborted\s+at abortIncoming \(node:_http_server/;

const STACK_FRAME_URL = /(?:@|\(|\bat\s+)(https?:\/\/[^\s)]+?):\d+:\d+/g;

let cachedAppHosts: Set<string> | null = null;

/** The hosts our own chunks are served from — production and staging, plus anything configured. */
function appHosts(): Set<string> {
  if (cachedAppHosts) return cachedAppHosts;
  const hosts = new Set<string>(["phoenix-hr.satopharma.com", "phoenix-people-workforce-staging.up.railway.app"]);
  for (const value of [process.env.NEXT_PUBLIC_APP_URL, process.env.APP_URL]) {
    try {
      if (value) hosts.add(new URL(value).host);
    } catch {
      // A malformed variable adds nothing.
    }
  }
  cachedAppHosts = hosts;
  return hosts;
}

function stripErrorName(message: string): string {
  return message.replace(/^(?:Uncaught\s+)?(?:TypeError|Error):\s*/, "").trim();
}

/** Is any frame in the stack one of OUR chunks (or did a React boundary name our component)? */
export function hasAppFrame(stack: string | null | undefined): boolean {
  if (!stack) return false;
  if (extractTopComponent(stack)) return true;
  for (const match of stack.matchAll(STACK_FRAME_URL)) {
    try {
      const url = new URL(match[1]);
      if (url.pathname.startsWith("/_next/") || appHosts().has(url.host)) return true;
    } catch {
      // Not a URL; not a frame.
    }
  }
  return false;
}

export type NoiseOptions = {
  /** Extra login ids to treat as test accounts (the synthetic-journeys secret, when a caller knows it). */
  extraTestLoginIds?: readonly string[];
};

/** A test login, or the health-check service account. */
export function isTestAccountRow(row: Pick<AppErrorEventRow, "hr_id" | "login_id">, options: NoiseOptions = {}): boolean {
  const login = String(row.login_id ?? "").trim().toLowerCase();
  const hrId = String(row.hr_id ?? "").trim().toLowerCase();
  if (login.startsWith(TEST_LOGIN_PREFIX) || hrId.startsWith(TEST_LOGIN_PREFIX)) return true;
  if (login && HEALTH_CHECK_LOGIN_IDS.has(login) && !hrId) return true;
  if (hrId && HEALTH_CHECK_LOGIN_IDS.has(hrId)) return true;
  const extra = new Set((options.extraTestLoginIds ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
  return (login !== "" && extra.has(login)) || (hrId !== "" && extra.has(hrId));
}

/**
 * Null for a row the audit keeps as an ordinary failure; otherwise its class. Excluded classes
 * are checked before `test_account`, so a test account's masked placeholder is still excluded as
 * the placeholder it is.
 *
 * `environment` NULL is KEPT: the writer stamps it now, but older rows written by a caller that
 * passed none are real production errors (service.ts explains the sixteen that went missing).
 */
export function classifyAppErrorNoise(row: AppErrorEventRow, options: NoiseOptions = {}): AppErrorNoiseClass | null {
  if (row.environment === "development") return "development";

  const raw = String(row.message ?? "").trim();
  const message = stripErrorName(raw);
  const isClient = row.source !== "server";

  if (isClient && isCrossOriginMaskedMessage(message) && !hasAppFrame(row.stack)) return "masked_script_error";
  if (isClient && BROWSER_NETWORK_MESSAGES.has(message.toLowerCase())) return "browser_network";
  if (isClient && BROWSER_INJECTED_SCRIPT.test(raw)) return "browser_injected_script";
  // Exact messages only — "Connection closed." is not among them and stays a finding.
  if (isBenignClientDisconnect({ message: raw }) || isBenignClientDisconnect({ message })) return "benign_disconnect";
  if (!isClient && CALLER_HUNG_UP.test(String(row.stack ?? ""))) return "benign_disconnect";
  if (isStaleDeployChunkError(new Error(message))) return "stale_deploy_chunk";
  if (isTransientRouterMountError(new Error(message))) return "router_mount_recovered";
  if (isTestAccountRow(row, options)) return "test_account";
  return null;
}

/**
 * The host of the script that threw, when EVERY located frame is someone else's — a Google Maps
 * renderer, a browser extension. Such a row is KEPT (our own bad argument can make a library throw
 * inside itself), and its issue's root cause reads PROBABLE "third-party script (<host>)".
 */
export function thirdPartyScriptHost(row: Pick<AppErrorEventRow, "stack" | "source">): string | null {
  if (row.source === "server") return null;
  return describeThirdPartyStack(row.stack)?.label ?? null;
}

export function isThirdPartyOnly(row: Pick<AppErrorEventRow, "stack" | "source">): boolean {
  return thirdPartyScriptHost(row) !== null;
}
