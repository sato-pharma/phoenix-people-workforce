// ─────────────────────────────────────────────────────────────────────────────────────────────
// The name printed on an employee's national ID card, read from the card they uploaded when they accepted the
// offer (owner, 27 Nov 2026: "anyone who accepts the offer uploads the ID card; when they upload it, extract the
// name"). Libano-Suisse's Additions sheet wants a first, father and last name, and a Phoenix name of two words
// ("Nourhan Abdelmoniem") sent the Father Name blank. The card always carries the full name, so the sheet reads it
// from here.
//
// One row per employee in public.employee_id_card_names: the Arabic name as printed, and the three parts in
// English capitals. The read goes through the one AI door (createOpenAiResponseText). Nothing here throws: a card
// that cannot be read leaves no row, and the Medical Insurance add list flags that person until it is read.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { createOpenAiResponseText, hasAiApiKey, OPENAI_ROUTE_BUDGET_MS } from "@/lib/ai/openai-client";
import { parseAiJson } from "@/lib/ai/parse-ai-json";
import { downloadHiringDocumentFile } from "@/lib/hiring-documents/file-storage";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type IdCardName = { nameAr: string; first: string; father: string; last: string };

export type IdCardNameRead = { status: "read"; name: IdCardName } | { status: "unreadable" } | { status: "unavailable" };

const INSTRUCTIONS = [
  "You read the FRONT of an Egyptian national ID card (بطاقة تحقيق الشخصية) from a photo.",
  "The full name is printed in Arabic over two lines: the first name on the top line, then the father's name, the grandfather's name and the family name.",
  "Return name_ar: the whole name exactly as printed, in Arabic, on one line, the words in order.",
  "Split it into three parts: first = the person's own first name; father = the father's name; last = every word after the father's name (grandfather and family), in order.",
  "A compound name is ONE name and is never split: عبد المنعم, عبد الله, عبد الرحمن, محمد علي when printed as one name, أبو بكر, and any name starting with عبد or أبو together with the word after it.",
  "Write each part in English capital letters as it is spoken in Egypt.",
  "When the employee's own English spelling of a word is given and it is the same name, use that spelling (for example NOURHAN, ABDELMONIEM).",
  "Return null for every field unless the card's name is fully readable. Never guess a word. is_id_card is false when the photo is not the front of an Egyptian national ID card.",
].join(" ");

const TEXT_FORMAT = {
  format: {
    name: "id_card_name",
    schema: {
      additionalProperties: false,
      properties: {
        father: { type: ["string", "null"] as const },
        first: { type: ["string", "null"] as const },
        is_id_card: { type: "boolean" as const },
        last: { type: ["string", "null"] as const },
        name_ar: { type: ["string", "null"] as const },
      },
      required: ["is_id_card", "name_ar", "first", "father", "last"],
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

function cleanEnglish(value: unknown): string {
  return typeof value === "string" ? value.replace(/[^A-Za-z' -]/g, " ").replace(/\s+/g, " ").trim().toUpperCase() : "";
}

function cleanArabic(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** The model's answer, kept only when every part is there: the Arabic name and all three English parts. */
export function normalizeIdCardRead(raw: unknown): IdCardName | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.is_id_card !== true) return null;
  const name = { father: cleanEnglish(value.father), first: cleanEnglish(value.first), last: cleanEnglish(value.last), nameAr: cleanArabic(value.name_ar) };
  if (!/[؀-ۿ]/.test(name.nameAr)) return null;
  if (!name.first || !name.father || !name.last) return null;
  return name;
}

/** Reads the name off the front of one ID card photo. Never throws. */
export async function readIdCardName(front: { bytes: Buffer; contentType: string }, englishName: string | null): Promise<IdCardNameRead> {
  if (!hasAiApiKey()) return { status: "unavailable" };
  const dataUrl = `data:${front.contentType || "image/jpeg"};base64,${front.bytes.toString("base64")}`;
  const hint = englishName?.trim() ? `The employee's own English spelling of their name: ${englishName.trim()}.` : "No English spelling is on record.";
  try {
    const response = await createOpenAiResponseText({
      input: [{ content: [{ text: `Read the name on this ID card. ${hint}`, type: "input_text" as const }, { detail: "high" as const, image_url: dataUrl, type: "input_image" as const }], role: "user" as const }],
      instructions: INSTRUCTIONS,
      maxOutputTokens: 600,
      purpose: "employee-id-card-name",
      reasoning: { effort: "low" },
      text: TEXT_FORMAT,
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
    });
    const name = normalizeIdCardRead(parseAiJson(response.outputText));
    return name ? { name, status: "read" } : { status: "unreadable" };
  } catch {
    return { status: "unavailable" };
  }
}

type NameRow = { hr_id: string; name_ar: string; first_name: string; father_name: string; last_name: string };

/** The card names already read, by HR id. An unreadable table answers an empty map (the list then flags everyone). */
export async function loadIdCardNames(hrIds: readonly string[]): Promise<Map<string, IdCardName>> {
  const wanted = [...new Set(hrIds.filter(Boolean))];
  const names = new Map<string, IdCardName>();
  if (wanted.length === 0) return names;
  const { data, error } = await getSupabaseAdmin().from("employee_id_card_names").select("hr_id,name_ar,first_name,father_name,last_name").in("hr_id", wanted);
  if (error) {
    logError("Could not read the ID card names", { error: new Error(error.message), labels: { event: "employee_id_card_names_read_failed" } });
    return names;
  }
  for (const row of (data ?? []) as NameRow[]) {
    names.set(row.hr_id, { father: row.father_name, first: row.first_name, last: row.last_name, nameAr: row.name_ar });
  }
  return names;
}

/**
 * Reads and keeps the name from the ID card the employee uploaded: the front page of the Hiring Documents slot the
 * joining form files the card into (`joining_form_upload = 'national_id'`). Never throws.
 */
export async function readAndSaveIdCardName(hrId: string, readBy: string): Promise<IdCardNameRead | { status: "no_card" }> {
  try {
    const db = getSupabaseAdmin();
    const slot = await db.from("hiring_document_definitions").select("id").eq("joining_form_upload", "national_id").eq("is_active", true).maybeSingle();
    if (slot.error) throw new Error(slot.error.message);
    const documentId = String((slot.data as { id?: string } | null)?.id ?? "").trim();
    if (!documentId) return { status: "no_card" };
    const files = await db
      .from("hiring_document_files")
      .select("id,file_name,content_type,storage_path,uploaded_at")
      .eq("employee_hr_id", hrId)
      .eq("document_id", documentId)
      .order("uploaded_at", { ascending: false });
    if (files.error) throw new Error(files.error.message);
    const rows = (files.data ?? []) as Array<{ id: string; file_name: string | null; content_type: string | null; storage_path: string }>;
    const images = rows.filter((row) => String(row.content_type ?? "").startsWith("image/"));
    const front = images.find((row) => /front/i.test(row.file_name ?? "")) ?? images[0];
    if (!front) return { status: "no_card" };
    const bytes = await downloadHiringDocumentFile(front.storage_path);
    const employee = await db.from("employees").select("full_name").eq("hr_id", hrId).maybeSingle();
    const englishName = (employee.data as { full_name?: string | null } | null)?.full_name ?? null;
    const read = await readIdCardName({ bytes, contentType: front.content_type ?? "image/jpeg" }, englishName);
    if (read.status !== "read") return read;
    const saved = await db.from("employee_id_card_names").upsert(
      {
        father_name: read.name.father,
        first_name: read.name.first,
        hr_id: hrId,
        last_name: read.name.last,
        name_ar: read.name.nameAr,
        read_at: new Date().toISOString(),
        read_by: readBy,
        source_file_id: front.id,
      },
      { onConflict: "hr_id" },
    );
    if (saved.error) throw new Error(saved.error.message);
    return read;
  } catch (error) {
    logError("Could not read the name from the ID card", {
      context: { hrId },
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "employee_id_card_name_failed" },
    });
    return { status: "unavailable" };
  }
}
