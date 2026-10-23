import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  assertMayPrintPaper,
  assertMayUseHrForms,
  paperIssuesForViewer,
} from "@/lib/hiring-pack/paper-access";
import { asPrintableDocument, documentLabel } from "@/lib/hiring-pack/document-registry";
import {
  issuePaperNumber,
  listRecentPaperIssues,
  type PaperIssueMode,
} from "@/lib/hiring-pack/paper-register-store";
import { isBuiltInDocument } from "@/lib/hiring-pack/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The paper register — the reference numbers printed on HR Forms papers.
//
// ISSUING A NUMBER IS PART OF PRINTING, so it takes the same permission as printing
// (`employee_documents` read) rather than a write grant. Anyone who can put a paper through the
// printer must be able to number it; a number that only some printers could take would leave the
// rest of the papers un-numbered, which is exactly what the register exists to end. The request is
// still a same-origin POST, because it writes a row.

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: "Not permitted.", status: 403 };
  return { message: clientSafeErrorMessage(error, "Something went wrong."), status: 500 };
}

/** Names for the people who printed, so the register shows a name rather than a code. */
async function namesFor(hrIds: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(hrIds.filter(Boolean))];
  if (unique.length === 0) return {};
  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, full_name")
    .in("hr_id", unique);
  if (error) return {};
  const names: Record<string, string> = {};
  for (const row of (data ?? []) as { hr_id: string; full_name: string | null }[]) {
    if (row.full_name?.trim()) names[row.hr_id.toUpperCase()] = row.full_name.trim();
  }
  return names;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // employee_documents as before, or a seat in SEAT_PRINTABLE_DOCUMENTS — which then reads only
    // the register rows of its own papers.
    await assertMayUseHrForms(access, "read");

    const listed = await listRecentPaperIssues(25);
    const issues = listed ? paperIssuesForViewer(access, listed) : null;
    if (!issues) {
      return NextResponse.json(
        { issues: [], ready: false },
        { headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }
    const names = await namesFor(issues.map((issue) => issue.issuedByHrId ?? ""));
    return NextResponse.json(
      {
        issues: issues.map((issue) => ({
          ...issue,
          issuedByName: issue.issuedByHrId ? (names[issue.issuedByHrId.toUpperCase()] ?? null) : null,
        })),
        ready: true,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_paper_register_read_failed", message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    // Gated like printing — numbering a paper is the first half of printing it.
    await assertMayUseHrForms(access, "read");

    const payload = (await request.json()) as {
      copies?: unknown;
      document?: unknown;
      documentLabel?: unknown;
      hrId?: unknown;
      mode?: unknown;
      subjectName?: unknown;
    };

    const document = typeof payload.document === "string" ? asPrintableDocument(payload.document) : null;
    if (!document) {
      return NextResponse.json(
        { error: "invalid_request", message: "That is not a paper this system prints." },
        { status: 400 },
      );
    }
    await assertMayPrintPaper(access, document, "read");
    const mode: PaperIssueMode = payload.mode === "manual" ? "manual" : "employee";
    const copies = Number.parseInt(String(payload.copies ?? "1"), 10);
    // A built-in paper is named from the registry, never from the request. Only an uploaded
    // template's name has to come from the caller, which holds the row.
    const label = isBuiltInDocument(document)
      ? documentLabel(document)
      : typeof payload.documentLabel === "string" && payload.documentLabel.trim()
        ? payload.documentLabel.trim()
        : documentLabel(document);

    const reference = await issuePaperNumber({
      copies: Number.isFinite(copies) ? copies : 1,
      document,
      documentLabel: label,
      hrId: mode === "employee" && typeof payload.hrId === "string" ? payload.hrId : null,
      issuedByHrId: access.hrId ?? null,
      mode,
      subjectName: typeof payload.subjectName === "string" ? payload.subjectName : null,
    });

    return NextResponse.json({ reference, ready: reference !== null });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_paper_register_issue_failed", message }, { status });
  }
}
