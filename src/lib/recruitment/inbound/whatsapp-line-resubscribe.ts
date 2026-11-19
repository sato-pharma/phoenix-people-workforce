// Recruitment / ATS — puts a WhatsApp line back on the Phoenix webhook when its business account
// dropped the app (owner, 19 Nov 2026: "automate this").
//
// Why: the Recruitment line (+20 10 98500699) received no applicant from 11 Nov 22:40 Cairo, while the
// HR handset on the same webhook kept receiving and every routing check read healthy. Meta keeps a
// line's delivery on its BUSINESS ACCOUNT's list of subscribed apps, and the two lines sit in two
// accounts, so one account dropping the app silences one line and nothing else. The health check now
// asks each account (`fetchWebhookRouting`, whatsapp-health.ts) and this file answers what it finds —
// the same idempotent call the connect screen makes when a number is linked
// (app/api/whatsapp/embedded-signup/exchange/route.ts, step 2).
//
// What it never does:
//   - run anywhere but production (`APP_ENV=production`). Staging may hold another app's token and the
//     registry's production ids, and subscribing a production account to that app would hand it
//     every applicant's message too;
//   - touch an account the line registry does not name (`unsubscribedLines` is built from it alone);
//   - act on an unreadable answer — only a readable list that LACKS the app reaches here;
//   - press more than once an hour per account, or log the token.
// Switched off with PHOENIX_WHATSAPP_AUTO_RESUBSCRIBE=off.

import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { logError, logWarning } from "@/lib/observability/log";
import { graphApiVersion, type WhatsAppLineAccount } from "@/lib/recruitment/inbound/whatsapp-health";

const RESUBSCRIBE_TIMEOUT_MS = 8_000;
const MIN_MS_BETWEEN_ATTEMPTS = 60 * 60 * 1000;

/** The last attempt per business account, in this process. The intake job runs every 10 minutes. */
const lastAttemptAt = new Map<string, number>();

export type WhatsAppResubscribeOutcome = "resubscribed" | "failed" | "skipped";

export type WhatsAppResubscribeResult = {
  line: WhatsAppLineAccount;
  outcome: WhatsAppResubscribeOutcome;
  /** Why it was skipped or failed; null on success. Meta's own words for a refusal, never the token. */
  reason: string | null;
  at: string;
};

type ResubscribeEnv = Record<string, string | undefined>;

/** Why a re-subscribe may not run here, or null when it may. Pure. */
export function whatsAppResubscribeRefusal(env: ResubscribeEnv = process.env): string | null {
  const flag = String(env.PHOENIX_WHATSAPP_AUTO_RESUBSCRIBE ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return "PHOENIX_WHATSAPP_AUTO_RESUBSCRIBE is off";
  if (String(env.APP_ENV ?? "").trim().toLowerCase() !== "production") return "APP_ENV is not production";
  if (!String(env.WHATSAPP_ACCESS_TOKEN ?? "").trim()) return "no WhatsApp access token";
  return null;
}

async function postSubscribedApps(businessAccountId: string, token: string): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/${graphApiVersion()}/${encodeURIComponent(businessAccountId)}/subscribed_apps`,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
        method: "POST",
        signal: AbortSignal.timeout(RESUBSCRIBE_TIMEOUT_MS),
      },
    );
    const body = (await response.json().catch(() => null)) as { success?: boolean; error?: { message?: string } } | null;
    if (response.ok && body?.success !== false) return { ok: true, reason: null };
    return { ok: false, reason: body?.error?.message?.trim() || `Meta answered HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "the request to Meta failed" };
  }
}

/**
 * Re-subscribes the Phoenix app to each business account the health check found without it. One
 * attempt per account per hour; every line of an account shares its result. Never throws.
 */
export async function resubscribeUnsubscribedWhatsAppLines(
  lines: readonly WhatsAppLineAccount[],
  now: Date = new Date(),
  env: ResubscribeEnv = process.env,
): Promise<WhatsAppResubscribeResult[]> {
  if (lines.length === 0) return [];
  const at = now.toISOString();
  const refusal = whatsAppResubscribeRefusal(env);
  if (refusal) return lines.map((line) => ({ at, line, outcome: "skipped", reason: refusal }));

  const token = String(env.WHATSAPP_ACCESS_TOKEN ?? "").trim();
  const byAccount = new Map<string, WhatsAppLineAccount[]>();
  for (const line of lines) byAccount.set(line.businessAccountId, [...(byAccount.get(line.businessAccountId) ?? []), line]);

  const results: WhatsAppResubscribeResult[] = [];
  for (const [businessAccountId, accountLines] of byAccount) {
    const last = lastAttemptAt.get(businessAccountId);
    if (last !== undefined && now.getTime() - last < MIN_MS_BETWEEN_ATTEMPTS) {
      for (const line of accountLines) {
        results.push({ at, line, outcome: "skipped", reason: `already tried at ${cairoDateTime(new Date(last).toISOString())} Cairo; tried again at most once an hour` });
      }
      continue;
    }
    lastAttemptAt.set(businessAccountId, now.getTime());

    const { ok, reason } = await postSubscribedApps(businessAccountId, token);
    const names = accountLines.map((line) => `${line.label} (${line.displayNumber})`).join(", ");
    if (ok) {
      logWarning("WhatsApp business account re-subscribed to the Phoenix app", {
        labels: { businessAccountId, event: "whatsapp_line_resubscribed", job: "recruitment-email-intake", lines: names },
      });
    } else {
      logError("WhatsApp business account could not be re-subscribed to the Phoenix app", {
        error: new Error(reason ?? "unknown"),
        labels: { businessAccountId, event: "whatsapp_line_resubscribe_failed", job: "recruitment-email-intake", lines: names },
      });
    }
    for (const line of accountLines) results.push({ at, line, outcome: ok ? "resubscribed" : "failed", reason });
  }
  return results;
}

/**
 * One sentence for the alert, appended to the health detail, saying what Phoenix did about it — so
 * the person reading it knows whether anything is left for them. Null when nothing was attempted.
 */
export function describeResubscribeResults(results: readonly WhatsAppResubscribeResult[]): string | null {
  if (results.length === 0) return null;
  const sentences = results.map((result) => {
    const name = `${result.line.label} (${result.line.displayNumber})`;
    if (result.outcome === "resubscribed") {
      return `Phoenix re-subscribed the ${name} to its app automatically at ${cairoDateTime(result.at)} Cairo, so its messages should arrive again.`;
    }
    if (result.outcome === "failed") {
      return `Phoenix tried to re-subscribe the ${name} automatically at ${cairoDateTime(result.at)} Cairo and Meta refused (${result.reason ?? "no reason given"}), so it needs a person in WhatsApp Manager.`;
    }
    return `Phoenix did not re-subscribe the ${name} automatically: ${result.reason ?? "skipped"}.`;
  });
  return ` ${sentences.join(" ")}`;
}

/** Test seam: forget the once-an-hour attempts. */
export function __resetWhatsAppResubscribeAttemptsForTests(): void {
  lastAttemptAt.clear();
}
