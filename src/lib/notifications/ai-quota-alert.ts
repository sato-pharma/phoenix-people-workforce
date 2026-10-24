import { writeAuditLog } from "@/lib/admin/audit";
import { isProductionRuntime } from "@/config/system-settings";
import { shouldPersistErrorEvents } from "@/lib/error-monitor/derived-status";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import { aiProviderLabel, isKeyRejectedRecord, type AiCallProvider, type AiCallRecord } from "@/lib/observability/ai-metrics";
import { logError } from "@/lib/observability/log";

/**
 * Tells a human, in-app + Telegram, the moment the AI provider says the account is OUT OF CREDIT — or, since
 * 24 Oct 2026, that it REFUSES THE KEY (its own alarm, its own slot for the day, `buildAiKeyRejectedMessage`).
 *
 * Why: on 2026-09-18 at 09:55 OpenAI refused the Sales normalizer with `insufficient_quota`. The
 * failure reached app_error_events and nothing else — found by the next morning's error check. The
 * account has no auto-recharge (owner, 2026-09-18), so every AI feature stops when the balance
 * runs out, and no retry or wait fixes it: only a top-up does.
 *
 * Same shape as drain-health-alert.ts: the `weekly_system_health_digest` audience (retargetable
 * from /admin/notification-recipients), module "system", no email.
 *
 * Once per Cairo day FOR EACH ACCOUNT: an in-process guard stops a burst of failing calls from each
 * resolving recipients, and the per-day idempotency key stops a second process sending it again. Per
 * account because a Claude account that runs dry in the afternoon is a second outage, not a repeat of the
 * morning's OpenAI one (code review, 19 Oct 2026: one slot a day for every account swallowed it).
 */

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const EVENT_TYPE = "ai_quota_exhausted";
const KEY_EVENT_TYPE = "ai_key_rejected";
const ACTOR = "ai-quota-alert";

const lastAlertedDay = new Map<AiCallProvider, string>();
// A refused key is its own alarm for the day: an account can lose its key and run out of credit on one day.
const lastKeyAlertedDay = new Map<AiCallProvider, string>();

function cairoDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/**
 * The name the alarm gives the account that ran out — the provider the failing call was billed to.
 * One copy of those names, in ai-metrics.ts, because the failed-over row on the board names an account too
 * and two maps would drift.
 */
export function aiQuotaProviderLabel(provider: AiCallProvider): string {
  return aiProviderLabel(provider);
}

/**
 * The in-process half of "once a day for each account", kept pure (the caller owns the map) so the suite
 * can pin it. True, and the slot taken, when this account has not been alarmed today in this process.
 */
export function takeAiQuotaAlertSlot(seen: Map<AiCallProvider, string>, provider: AiCallProvider, day: string): boolean {
  if (seen.get(provider) === day) return false;
  seen.set(provider, day);
  return true;
}

/** The alarm's title, naming the account that ran out. */
export function aiQuotaAlertTitle(provider: AiCallProvider): string {
  return `${aiQuotaProviderLabel(provider)} account is out of credit`;
}

/**
 * The per-recipient key that sends one alarm a day for each account. OpenAI keeps the key it has always
 * been sent under, so the day this ships does not page him a second time for an OpenAI outage already told.
 */
export function aiQuotaIdempotencyKey(provider: AiCallProvider, day: string, hrId: string): string {
  return provider === "openai" ? `ai-quota-exhausted:${day}:${hrId}` : `ai-quota-exhausted:${provider}:${day}:${hrId}`;
}

/**
 * Pure message builder — no IO, so it is unit-testable without a database.
 *
 * 🔴 IT TAKES THE RECORD BECAUSE NOT EVERY CALLER IS OPENAI. `groq_transcription` shares this alarm
 * deliberately — the CRM's spoken visit comment falls back to Groq's Whisper where the browser has
 * no speech engine, on the owner's cost ruling of 2026-09-25, and a dead key there fails the same
 * silent way. But this message hardcoded "OpenAI" and listed OpenAI's features, so a GROQ outage
 * sent him to the wrong billing page and named six features that were working fine. During an
 * outage, being pointed at the wrong account costs more than the outage.
 *
 * 🔴 AND IT NAMES THE ACCOUNT THE CALL WAS BILLED TO (`record.provider`), NEVER ONE GUESSED FROM THE
 * FEATURE (code review, 19 Oct 2026). Since the Anthropic failover every feature reaches two accounts,
 * and a Claude account out of credit sent him to top up OpenAI.
 */
export function buildAiQuotaExhaustedMessage(record: AiCallRecord): string {
  const provider = aiQuotaProviderLabel(record.provider);
  const affected =
    record.component === "groq_transcription"
      ? "Speech to text for CRM spoken visit comments is failing until it is topped up — on a browser with no speech engine of its own, that is the only way a rep can dictate one."
      : record.provider === "anthropic" || record.provider === "anthropic_backup"
        ? `${record.provider === "anthropic" ? "The first Anthropic account" : "The backup Anthropic account"} refuses every call until it is topped up. Claude's calls move to the ${record.provider === "anthropic" ? "backup" : "first"} Anthropic account while that one has credit and a key, and the Phoenix CRM signboard reads, which ask Claude first, fall back to OpenAI; if both Anthropic accounts and OpenAI are out, no AI feature has a stand-in.`
        : record.provider === "openai"
          ? "OpenAI refuses every call until it is topped up. Every AI feature (CV extraction, invoice reading, the Sales normalizer's AI suggest, CRM notes, the coach, expense notes, email assist and the What Needs You summary) moves to the first Anthropic account, then the backup one, while they have credit and a key; if all three are out, no AI feature has a stand-in."
          : "Every Sales AI feature it answers is failing until it is topped up.";
  const billingPage = record.provider === "generic" ? "that provider's billing page" : `the ${provider} billing page`;
  // "No auto-recharge" is the owner's standing rule, never to be turned on — so "waiting will not fix it" is
  // permanently true rather than a description of a setting someone might change. Anthropic's refusal is
  // either an empty balance or the workspace's own spend limit, and that ruling was made for the OpenAI
  // account, not this one — so its line says what ends either.
  const fix =
    record.provider === "anthropic" || record.provider === "anthropic_backup"
      ? `Add credit, or raise the workspace spend limit, on ${billingPage} and the features resume on their own.`
      : `Waiting will not fix it — the account has no auto-recharge. Add credit on ${billingPage} and the features resume on their own.`;
  return [
    `💳 ${provider} says the AI account is out of credit.`,
    "",
    affected,
    "",
    fix,
  ].join("\n");
}

/** The variable on Railway that holds each account's key, so a refused-key alarm says which one to replace. */
export function aiProviderKeyVariable(provider: AiCallProvider): string {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "anthropic_backup":
      return "ANTHROPIC_API_KEY_2";
    case "groq":
      return "GROQ_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "generic":
      return "AI_API_KEY";
    default:
      return "OPENAI_API_KEY";
  }
}

/** The refused-key alarm's title, naming the account. */
export function aiKeyAlertTitle(provider: AiCallProvider): string {
  return `${aiQuotaProviderLabel(provider)} refuses its API key`;
}

/** The per-recipient key that sends one refused-key alarm a day for each account, apart from out of credit. */
export function aiKeyAlertIdempotencyKey(provider: AiCallProvider, day: string, hrId: string): string {
  return `ai-key-rejected:${provider}:${day}:${hrId}`;
}

/**
 * Pure message builder for a refused key (401/403 or `auth_failed`). 🔴 Until 24 Oct 2026 only out of credit
 * paged anyone, and the production OpenAI key was refused for days with every call quietly moving to Claude:
 * the stand-in hid the outage, and the stand-in is the next thing to run dry. Names the account, where its calls
 * went, and the exact variable to replace.
 */
export function buildAiKeyRejectedMessage(record: AiCallRecord): string {
  const provider = aiQuotaProviderLabel(record.provider);
  const affected =
    record.component === "groq_transcription"
      ? "Speech to text for CRM spoken visit comments is failing until the key is replaced — on a browser with no speech engine of its own, that is the only way a rep can dictate one."
      : record.provider === "openai"
        ? "Every AI feature (CV extraction, invoice reading, the Sales normalizer's AI suggest, CRM notes, the coach, expense notes, email assist and the What Needs You summary) moves to the first Anthropic account, then the backup one, while they have credit and a working key; if all three are out, no AI feature has a stand-in."
        : record.provider === "anthropic"
          ? "Claude's calls move to the backup Anthropic account while it has credit and a working key, and the Phoenix CRM signboard reads fall back to OpenAI."
          : record.provider === "anthropic_backup"
            ? "The backup Anthropic account can no longer stand in when the first one is out of credit or refused."
            : "Every Sales AI feature it answers is failing over or failing until the key is replaced.";
  return [
    `🔑 ${provider} refuses the API key Phoenix holds for it.`,
    "",
    affected,
    "",
    `Waiting will not fix it. Make a new key in the ${provider} console and put it in ${aiProviderKeyVariable(record.provider)} on Railway, on every service that holds it; the features resume on their own.`,
  ].join("\n");
}

/** Whether this process may page anyone: the real production app only — never staging, a laptop or the suite. */
export function aiQuotaAlertEnabled(): boolean {
  if (process.env.PHOENIX_TEST_SUITE === "1") return false;
  return shouldPersistErrorEvents() && isProductionRuntime();
}

/** Best-effort — never throws. */
export async function notifyAiQuotaExhausted(record: AiCallRecord): Promise<void> {
  try {
    if (!aiQuotaAlertEnabled()) return;
    const day = cairoDayKey();
    const keyRejected = isKeyRejectedRecord(record);
    const what = keyRejected ? "refused-key" : "out-of-credit";
    const entityId = keyRejected ? "ai.key_rejected" : "ai.quota_exhausted";
    if (!takeAiQuotaAlertSlot(keyRejected ? lastKeyAlertedDay : lastAlertedDay, record.provider, day)) return;

    const { recipients, warnings } = await resolveNotificationPersonRecipients(AUDIENCE_KEY, `AI ${what} alert recipients`);
    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: ACTOR,
        entityId,
        entityType: "notification",
        newValues: { failClosed: true, provider: record.provider, warnings },
        summary: `AI ${what} alert skipped — no active recipient resolved for the configured audience.`,
      });
      return;
    }

    const message = keyRejected ? buildAiKeyRejectedMessage(record) : buildAiQuotaExhaustedMessage(record);
    await Promise.all(
      recipients.map((recipient) =>
        createSystemNotification({
          actionUrl: "/admin/system-audit",
          actorId: ACTOR,
          channels: ["in_app", "telegram", "push"],
          eventType: keyRejected ? KEY_EVENT_TYPE : EVENT_TYPE,
          message,
          metadata: {
            idempotencyKey: keyRejected
              ? aiKeyAlertIdempotencyKey(record.provider, day, recipient.hrId)
              : aiQuotaIdempotencyKey(record.provider, day, recipient.hrId),
            model: record.model,
            provider: record.provider,
            purpose: record.purpose,
          },
          // "system" is the module enabled for Telegram; an unknown module fails closed (see drain-health-alert.ts).
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open the System Audit", ctaUrl: "/admin/system-audit" },
          title: keyRejected ? aiKeyAlertTitle(record.provider) : aiQuotaAlertTitle(record.provider),
        }),
      ),
    );

    await writeAuditLog({
      actorLoginId: ACTOR,
      entityId,
      entityType: "notification",
      newValues: { delivered: recipients.length, provider: record.provider, purpose: record.purpose, warnings },
      summary: `AI ${what} alert delivered to ${recipients.length} recipient(s).`,
    });
  } catch (error) {
    logError("AI account alert failed to dispatch", { error, labels: { event: "ai_quota_alert_failed" } });
  }
}
