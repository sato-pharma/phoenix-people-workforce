// The paper register: issuing the next reference number, and reading back what was issued.
//
// NEVER BLOCKS A PRINT. A register that is not set up yet (the migration not applied) answers null,
// and the caller prints the paper without a number and says so. Refusing to print a contract because
// a numbering table is missing would be the worse failure by far. A genuine database error is also
// swallowed into null for the same reason, and logged, because the paper still has to come out.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isPaperReference } from "@/lib/hiring-pack/paper-reference";

export type PaperIssueMode = "employee" | "manual";

export type PaperIssue = {
  reference: string;
  document: string;
  documentLabel: string;
  hrId: string | null;
  subjectName: string | null;
  mode: PaperIssueMode;
  copies: number;
  issuedByHrId: string | null;
  issuedAt: string;
};

type RegisterRow = {
  reference: string;
  document: string;
  document_label: string;
  hr_id: string | null;
  subject_name: string | null;
  mode: string;
  copies: number;
  issued_by_hr_id: string | null;
  issued_at: string;
};

const TABLE = "hiring_pack_paper_register";

/** "Not set up yet", in each of the shapes PostgREST and Postgres say it. */
export function isPaperRegisterMissing(error: { code?: string | null } | null | undefined): boolean {
  const code = error?.code ?? "";
  return code === "PGRST205" || code === "PGRST204" || code === "42P01" || code === "42703";
}

function clip(value: string | null | undefined, max: number): string | null {
  const text = (value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function mapRow(row: RegisterRow): PaperIssue {
  return {
    reference: row.reference,
    document: row.document,
    documentLabel: row.document_label,
    hrId: row.hr_id,
    subjectName: row.subject_name,
    mode: row.mode === "manual" ? "manual" : "employee",
    copies: row.copies,
    issuedByHrId: row.issued_by_hr_id,
    issuedAt: row.issued_at,
  };
}

/**
 * Take the next number for one paper about to be printed.
 *
 * Null when the register is not there yet, or the write failed — see the header. Never throws.
 */
export async function issuePaperNumber(input: {
  document: string;
  documentLabel: string;
  hrId: string | null;
  subjectName: string | null;
  mode: PaperIssueMode;
  copies: number;
  issuedByHrId: string | null;
}): Promise<string | null> {
  try {
    const copies = Number.isInteger(input.copies) ? Math.min(Math.max(input.copies, 1), 20) : 1;
    const { data, error } = await getSupabaseAdmin()
      .from(TABLE)
      .insert({
        copies,
        document: input.document,
        document_label: clip(input.documentLabel, 200) ?? input.document,
        hr_id: clip(input.hrId, 40),
        issued_by_hr_id: clip(input.issuedByHrId, 40),
        mode: input.mode,
        subject_name: clip(input.subjectName, 200),
      })
      .select("reference")
      .single();
    if (error) {
      if (!isPaperRegisterMissing(error)) {
        console.error("[hiring-pack] paper register write failed", error.message);
      }
      return null;
    }
    const reference = (data as { reference?: unknown } | null)?.reference;
    return isPaperReference(reference) ? reference : null;
  } catch (cause) {
    console.error("[hiring-pack] paper register write failed", cause);
    return null;
  }
}

/**
 * The newest number printed for this paper for this employee — what a filed signed copy carries.
 *
 * The copy filed after a signature is re-rendered, not scanned, so without this it would reach the
 * employee's file without the number printed on the sheet he signed.
 */
export async function latestPaperNumber(document: string, hrId: string): Promise<string | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(TABLE)
      .select("reference")
      .eq("document", document)
      .ilike("hr_id", hrId)
      .order("issued_at", { ascending: false })
      .limit(1);
    if (error) return null;
    const reference = (data ?? [])[0]?.reference;
    return isPaperReference(reference) ? reference : null;
  } catch {
    return null;
  }
}

/** The most recent papers printed, newest first. Null when the register is not set up yet. */
export async function listRecentPaperIssues(limit = 25): Promise<PaperIssue[] | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select(
      "reference, document, document_label, hr_id, subject_name, mode, copies, issued_by_hr_id, issued_at",
    )
    .order("issued_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) {
    if (isPaperRegisterMissing(error)) return null;
    throw new Error(error.message);
  }
  return ((data ?? []) as RegisterRow[]).map(mapRow);
}
