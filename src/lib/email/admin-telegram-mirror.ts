import { logError } from "@/lib/observability/log";
import { sendTelegramNotification } from "@/lib/notifications/telegram";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The one standing admin who receives a copy of EVERY automated email the system sends, as a
 * Telegram message (mirrorEmailToAdminTelegram below). Until 2026-11-06 he was also blind-copied on
 * the mail itself; the owner stopped that ("Stop the BCC copies" — the copies taught Yahoo that
 * satopharma.com mail is junk), so the Telegram mirror is now his only copy. The address is still
 * the offers' Reply-To and the Sato composer's, so it is declared once here.
 */
export const ADMIN_STANDING_EMAIL = "omar.anwar@satopharma.com";

export type AdminMirrorEmail = {
  subject: string;
  to?: string[];
  cc?: string[];
  text?: string | null;
  html?: string | null;
};

const PREVIEW_MAX = 500;
const MAX_RECIPIENTS_SHOWN = 5;
const ADMIN_CHAT_TTL_MS = 5 * 60_000;

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pure builder for the Telegram twin of an email: a short "To: … / preview" body the admin can
 * read at a glance. No IO — unit-tested directly so the formatting is covered without ever
 * touching the network or the database.
 */
export function buildAdminMirrorMessage(email: AdminMirrorEmail): { title: string; message: string } {
  const recipients = [...(email.to ?? []), ...(email.cc ?? [])]
    .map((recipient) => (recipient ?? "").trim())
    .filter(Boolean);
  const shown = recipients.slice(0, MAX_RECIPIENTS_SHOWN).join(", ");
  const more =
    recipients.length > MAX_RECIPIENTS_SHOWN ? ` (+${recipients.length - MAX_RECIPIENTS_SHOWN} more)` : "";

  const rawPreview =
    email.text && email.text.trim().length > 0 ? email.text : email.html ? stripHtml(email.html) : "";
  const normalizedPreview = rawPreview.replace(/\s+/g, " ").trim();
  const preview =
    normalizedPreview.length > PREVIEW_MAX ? `${normalizedPreview.slice(0, PREVIEW_MAX)}…` : normalizedPreview;

  const message = [
    recipients.length > 0 ? `To: ${shown}${more}` : null,
    preview.length > 0 ? preview : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { message, title: email.subject?.trim() || "Phoenix email" };
}

let adminChatCache: { at: number; chatIds: string[] } | null = null;

/**
 * The standing admin's connected Telegram chats. Exported so every channel that mirrors to him
 * resolves the SAME person: this module's whole reason for declaring ADMIN_STANDING_EMAIL once is
 * that two channels must never drift to two different recipients, and the WhatsApp conversation
 * mirror is now a second such channel.
 */
export async function resolveAdminTelegramChatIds(): Promise<string[]> {
  const now = Date.now();
  if (adminChatCache && now - adminChatCache.at < ADMIN_CHAT_TTL_MS) return adminChatCache.chatIds;

  const supabase = getSupabaseAdmin();
  const { data: employees, error: employeesError } = await supabase
    .from("employees")
    .select("hr_id")
    .ilike("work_email", ADMIN_STANDING_EMAIL)
    .limit(1);
  if (employeesError) throw employeesError;

  const hrId = (employees?.[0] as { hr_id?: string | null } | undefined)?.hr_id ?? null;
  if (!hrId) {
    adminChatCache = { at: now, chatIds: [] };
    return [];
  }

  const { data: connections, error: connectionsError } = await supabase
    .from("telegram_connections")
    .select("telegram_chat_id")
    .eq("hr_id", hrId)
    .eq("status", "connected");
  if (connectionsError) throw connectionsError;

  const chatIds = ((connections ?? []) as Array<{ telegram_chat_id?: string | number | null }>)
    .map((row) => String(row.telegram_chat_id ?? "").trim())
    .filter(Boolean);

  adminChatCache = { at: now, chatIds };
  return chatIds;
}

/**
 * The standing admin's copy of every automated email: after an email has been dispatched, send him
 * a Telegram copy (the mail BCC that used to accompany it stopped on 2026-11-06). Best-effort by design —
 *
 *  • Fire-and-forget (never awaited into the email result) and it can NEVER throw: a Telegram
 *    outage, a missing bot token, or an unconnected admin must not affect the email that just
 *    went out. Every failure is swallowed and logged.
 *  • It only ever runs for a live, just-sent email — it never re-sends history.
 *  • Payslip mail never reaches the email send path at all (it is hard-blocked upstream), so no
 *    payslip content can ever be mirrored here.
 */
export async function mirrorEmailToAdminTelegram(email: AdminMirrorEmail): Promise<void> {
  try {
    const chatIds = await resolveAdminTelegramChatIds();
    if (chatIds.length === 0) return;
    const { message, title } = buildAdminMirrorMessage(email);
    for (const chatId of chatIds) {
      try {
        await sendTelegramNotification({ chatId, message, title });
      } catch (error) {
        logError("Admin Telegram email-mirror: send failed", {
          labels: { event: "admin_telegram_mirror_send_failed" },
          error,
        });
      }
    }
  } catch (error) {
    logError("Admin Telegram email-mirror: could not resolve or deliver", {
      labels: { event: "admin_telegram_mirror_error" },
      error,
    });
  }
}
