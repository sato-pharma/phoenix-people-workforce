/**
 * The three vendor reads behind the Needs You board. The rules are in `./vendor-accounts-rules.ts`.
 *
 * Each is light: GitHub reads a row already on file and makes no call to GitHub, and the other two are the same
 * one-request reads their health checks have always made. No write, and none of the vendor's words leave this file.
 * A thrown read is caught by `service.ts` and reads as "could not be read".
 */

import { isProductionRuntime } from "@/config/system-settings";
import { getTelegramWebhookStatus, telegramEnvironmentStatus } from "@/lib/notifications/telegram";
import { readJobHeartbeats } from "@/lib/observability/job-heartbeat";
import { probeAllWhatsAppNumbers } from "@/lib/recruitment/inbound/whatsapp-health";
import { approvalsLinePhoneNumberId } from "@/lib/whatsapp-inbox/lines";

import type { NeedsYouSourceState } from "./types";
import { judgeGithubAccount, judgeTelegramAccount, judgeWhatsAppAccount } from "./vendor-accounts-rules";

/** The job whose every hourly run asks GitHub for something with this account's key. */
const GITHUB_HEARTBEAT_SLUG = "phoenix-run-synthetic-journeys";

export async function loadGithubAccountState(now: Date): Promise<NeedsYouSourceState> {
  const rows = await readJobHeartbeats();
  return judgeGithubAccount(rows.find((row) => row.slug === GITHUB_HEARTBEAT_SLUG) ?? null, now, isProductionRuntime());
}

export async function loadWhatsAppAccountState(): Promise<NeedsYouSourceState> {
  return judgeWhatsAppAccount(await probeAllWhatsAppNumbers([approvalsLinePhoneNumberId()]), isProductionRuntime());
}

export async function loadTelegramAccountState(): Promise<NeedsYouSourceState> {
  const hasToken = telegramEnvironmentStatus().telegramBotToken;
  // With no key there is nothing to ask, and the read below would only report the same fact.
  const status = hasToken ? await getTelegramWebhookStatus() : null;
  return judgeTelegramAccount(
    { hasToken, checked: status?.checked ?? false, error: status?.error ?? null, httpStatus: status?.httpStatus ?? null },
    isProductionRuntime(),
  );
}
