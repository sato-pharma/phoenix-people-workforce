// Recruitment — the few switches and texts HR changes from a screen rather than a deploy, kept in
// `ats_recruitment_settings` (key, value jsonb). Read with a fallback, so a missing row or a failed
// read answers the code's own default and never throws into a webhook or a cron.
//
// The WhatsApp re-ask starts OFF (owner, 2026-10-20: it "stays off until you switch it on"); the
// foundation migration seeds `whatsapp_reask_enabled = false`, and the fallback here is false too, so
// a read that fails can never switch it on.

import { recruitmentDb } from "@/lib/recruitment/db";
import {
  DEFAULT_REJECTION_MESSAGE_TEXT,
  REJECTION_MESSAGE_TEXT_KEY,
  WHATSAPP_REASK_ENABLED_KEY,
  type RecruitmentSettingsView,
} from "@/lib/recruitment/recruitment-settings-shared";

export { DEFAULT_REJECTION_MESSAGE_TEXT, REJECTION_MESSAGE_TEXT_KEY, WHATSAPP_REASK_ENABLED_KEY };
export type { RecruitmentSettingsView };

const SETTINGS_TABLE = "ats_recruitment_settings";
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { at: number; value: unknown }>();

/** Test seam, and what a write calls so the next read sees it at once. */
export function resetRecruitmentSettingsCache(): void {
  cache.clear();
}

/** The stored value for this key, or the fallback when there is no row or the read failed. */
export async function getRecruitmentSetting<T>(key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return (hit.value === undefined ? fallback : (hit.value as T));
  try {
    const { data, error } = await recruitmentDb().from(SETTINGS_TABLE).select("value").eq("key", key).maybeSingle();
    if (error) throw error;
    const value = (data as { value?: unknown } | null)?.value;
    cache.set(key, { at: Date.now(), value: value === null ? undefined : value });
    return value === undefined || value === null ? fallback : (value as T);
  } catch (error) {
    console.error(`[recruitment-settings] read of ${key} failed; using the default`, error);
    return fallback;
  }
}

/** Writes one setting and stamps who changed it. Throws on a failed write — a screen shows it. */
export async function setRecruitmentSetting(key: string, value: unknown, hrId: string | null): Promise<void> {
  const { error } = await recruitmentDb()
    .from(SETTINGS_TABLE)
    .upsert(
      { key, value, updated_at: new Date().toISOString(), updated_by_hr_id: hrId },
      { onConflict: "key" },
    );
  if (error) throw error;
  cache.delete(key);
}

/** Whether the half-hourly WhatsApp re-ask may send. False on any doubt. */
export async function isWhatsAppReaskEnabled(): Promise<boolean> {
  return (await getRecruitmentSetting<unknown>(WHATSAPP_REASK_ENABLED_KEY, false)) === true;
}

/** The rejection message's text: HR's edited copy, or the default above. */
export async function rejectionMessageText(): Promise<string> {
  const stored = await getRecruitmentSetting<unknown>(REJECTION_MESSAGE_TEXT_KEY, null);
  const text = typeof stored === "string" ? stored.trim() : "";
  return text.length > 0 ? text : DEFAULT_REJECTION_MESSAGE_TEXT;
}

/** Everything the Screening Questions screen's settings panel shows. */
export async function loadRecruitmentSettingsView(): Promise<RecruitmentSettingsView> {
  const [enabled, stored] = await Promise.all([
    isWhatsAppReaskEnabled(),
    getRecruitmentSetting<unknown>(REJECTION_MESSAGE_TEXT_KEY, null),
  ]);
  const custom = typeof stored === "string" ? stored.trim() : "";
  return {
    rejectionMessageIsDefault: custom.length === 0,
    rejectionMessageText: custom.length > 0 ? custom : DEFAULT_REJECTION_MESSAGE_TEXT,
    whatsAppReaskEnabled: enabled,
  };
}
