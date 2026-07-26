// Recruitment / ATS — buffer for inbound WhatsApp text messages (ats_whatsapp_inbound_messages).
//
// WhatsApp delivers a sender's plain-text messages as their own webhook events, separate from and
// usually just before the document message that carries the CV. To show the "first few messages"
// next to a candidate, those texts are parked here per sender (wa_id) until the CV document
// arrives, then read + consumed. A retention sweep drops anything a CV never claimed so the table
// can't grow unbounded. All server-only via the service-role client.

import { recruitmentDb } from "@/lib/recruitment/db";

// Only look back this far when attaching preceding messages to a CV — a text from days ago is not
// context for today's CV. Also the retention horizon for the sweep.
const WHATSAPP_BUFFER_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function bufferWhatsAppMessage(waId: string, body: string): Promise<void> {
  const trimmed = body.trim();
  if (!trimmed) return;
  const supabase = recruitmentDb();
  const { error } = await supabase.from("ats_whatsapp_inbound_messages").insert({ body: trimmed, wa_id: waId });
  if (error) throw error;
}

// Returns this sender's recent buffered messages, NEWEST first (the assembler re-orders to sent
// order and caps the count). Bounded to the look-back window so stale chatter isn't attached.
export async function takeRecentWhatsAppMessages(waId: string, limit: number = 3): Promise<string[]> {
  const supabase = recruitmentDb();
  const sinceIso = new Date(Date.now() - WHATSAPP_BUFFER_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("ats_whatsapp_inbound_messages")
    .select("body")
    .eq("wa_id", waId)
    .gte("received_at", sinceIso)
    .order("received_at", { ascending: false })
    .limit(Math.max(1, limit));
  if (error) throw error;
  return ((data ?? []) as Array<{ body: string | null }>)
    .map((row) => String(row.body ?? "").trim())
    .filter((body) => body.length > 0);
}

// Consume this sender's buffered messages once they've been attached to a CV, so a later CV from
// the same sender doesn't re-inherit them. Best-effort: a failure here must not fail intake.
export async function clearWhatsAppMessages(waId: string): Promise<void> {
  const supabase = recruitmentDb();
  await supabase.from("ats_whatsapp_inbound_messages").delete().eq("wa_id", waId);
}

// Opportunistic retention sweep — drops anything past the look-back window (buffered texts whose
// CV never arrived). Cheap to run inline on the webhook; failures are swallowed.
export async function sweepOldWhatsAppMessages(): Promise<void> {
  const supabase = recruitmentDb();
  const cutoffIso = new Date(Date.now() - WHATSAPP_BUFFER_WINDOW_MS).toISOString();
  await supabase.from("ats_whatsapp_inbound_messages").delete().lt("received_at", cutoffIso);
}
