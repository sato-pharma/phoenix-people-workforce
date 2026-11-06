import { NextResponse } from "next/server";

import { assertPermission, canSeeEmployee } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  canDownloadEmployeeCv,
  clearEmployeeCv,
  copyCandidateCvToEmployee,
  getEmployeeCv,
  readCvPayload,
  setEmployeeCv,
  streamEmployeeCv,
} from "@/lib/employees/employee-cv";
import { findCandidateCvMatches } from "@/lib/employees/employee-cv-candidates";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A 15MB scan on Egyptian mobile data is past the default handler timeout on a cold container,
// in both directions — the download of one as much as the replacement of one.
export const maxDuration = 60;

/**
 * One employee's CV: download it, replace it, remove it.
 *
 * THE DOWNLOAD IS THE POINT OF THE WHOLE FEATURE — this is the link the new-hire notice puts in
 * front of the SFE Manager (src/lib/crm/account-setup-messages.ts). It is a plain GET returning
 * the file with a Content-Disposition, so following it from an email is a saved file and nothing
 * else, and there is no token in the URL: the session is the authorization.
 *
 * READ AND WRITE ARE DELIBERATELY DIFFERENT SETS. Reading is canDownloadEmployeeCv — the
 * seats the owner named, of which the SFE Manager holds no `employees` grant at all. Writing is
 * `employees:update`, because attaching or removing a CV is an edit to the employee master
 * record. The reasoning for the split lives with the predicate, in employee-cv.ts.
 *
 * NOT to be confused with the CANDIDATE CV routes under /api/recruitment/**. Those serve a person
 * being considered for a job, and the hiring-manager one deliberately refuses to hand over a file
 * at all (owner, 2026-09-09). This one serves a document on the record of somebody already hired,
 * to the seats that administer that record.
 */

function errorStatus(error: unknown): { message: string; status: number } {
  const message = clientSafeErrorMessage(error, "Unexpected error.");
  if (isForbiddenError(error)) return { message, status: 403 };
  const lower = message.toLowerCase();
  if (lower.includes("not authenticat") || lower.includes("unauthenticat")) return { message, status: 401 };
  if (lower.includes("forbidden")) return { message, status: 403 };
  if (lower.includes("not found")) return { message, status: 404 };
  if (
    lower.includes("larger than") ||
    lower.includes("unsupported") ||
    lower.includes("required") ||
    lower.includes("empty")
  ) {
    return { message, status: 400 };
  }
  return { message, status: 500 };
}

async function loadTargetForScopeCheck(hrId: string) {
  const { data: target } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, manager_hr_id")
    // HR ids are mixed case in this database (AGENTS.md §2.1), so `ilike` with no wildcard rather
    // than `.eq` on an upper-cased value.
    .ilike("hr_id", hrId.trim())
    .limit(1)
    .maybeSingle();
  if (!target) throw new Error(`Employee ${hrId} was not found.`);
  return target as { hr_id: string | null; manager_hr_id: string | null };
}

/** Downloads the CV. Also answers "is there one" — a HEAD-shaped 404 when there is not. */
export async function GET(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    // `?candidates=<who>` — the recruitment candidates who have a CV and could be this employee.
    //
    // GATED ON assertCanManage, NOT on the download gate below, and the difference is the whole
    // reason it is handled before anything else in this handler. Reading a CV is the
    // employeeCvReaderRoles set (it exists so the SFE Manager can open one); searching the
    // CANDIDATE database is not that privilege, and it must not ride in on it. Only somebody who
    // could actually attach the result — employees:update, so Super Admin and the two HR seats —
    // may ask. HR Operations holds no candidates:read of its own, which is exactly why this lives
    // here rather than reusing /api/recruitment/candidates: that route would 403 the one person
    // whose job this is.
    const candidateQuery = new URL(request.url).searchParams.get("candidates");
    if (candidateQuery !== null) {
      const { hrId } = await params;
      await assertCanManage(request, hrId);
      return NextResponse.json({
        candidates: await findCandidateCvMatches({ query: candidateQuery }),
        success: true,
      });
    }

    const access = await resolveAccessContext(request);
    // resolveAccessContext never throws for a missing session — it returns a guest context whose
    // role is "Employee" (AGENTS.md §2.1). canDownloadEmployeeCv refuses that outright, and this
    // is the check that stops an anonymous request walking straight into a private document.
    if (!canDownloadEmployeeCv(access)) {
      throw new Error(
        access.source === "guest"
          ? "Not authenticated."
          : "Forbidden: your role cannot open employee CVs.",
      );
    }

    const { hrId } = await params;

    // `?meta=1` answers "is there a CV, what is it called, how big" without moving the bytes, so a
    // screen can render the row and its download button without fetching the document to find out
    // whether there is one. Same read gate as the download itself, one verb, no second route.
    if (new URL(request.url).searchParams.get("meta") === "1") {
      return NextResponse.json({ cv: await getEmployeeCv(hrId), success: true });
    }

    const cv = await streamEmployeeCv(hrId);
    if (!cv) {
      return NextResponse.json(
        { error: "not_found", message: "No CV is on file for this employee." },
        { status: 404 },
      );
    }

    return new NextResponse(new Uint8Array(cv.bytes), {
      status: 200,
      headers: {
        "Content-Type": cv.contentType,
        // `attachment`, so the link in the notice saves the file rather than opening a viewer the
        // reader then has to fight. The filename is RFC 5987-encoded because a CV is routinely
        // named in Arabic, and the plain `filename` beside it is the ASCII fallback.
        "Content-Disposition": `attachment; filename="${cv.fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(cv.fileName)}`,
        // Never cached by a shared proxy. This is one named person's private document.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    const { message, status } = errorStatus(error);
    return NextResponse.json({ error: "employee_cv_download_failed", message }, { status });
  }
}

async function assertCanManage(request: Request, hrId: string) {
  const access = await resolveAccessContext(request);
  await assertPermission(access, "employees", "update");
  const row = await loadTargetForScopeCheck(hrId);
  if (!canSeeEmployee(access, { hrId: row.hr_id ?? hrId, managerHrId: row.manager_hr_id })) {
    throw new Error("Forbidden: you do not have access to this employee.");
  }
  return access;
}

/** Attaches or replaces the CV. Multipart `file`, same shape as the photo route beside it. */
export async function POST(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { hrId } = await params;
    const access = await assertCanManage(request, hrId);
    const payload = await readCvPayload(request);
    const record = await setEmployeeCv({ actorHrId: access.hrId ?? null, hrId, payload });
    return NextResponse.json({ cv: record, success: true });
  } catch (error) {
    const { message, status } = errorStatus(error);
    return NextResponse.json({ error: "employee_cv_upload_failed", message }, { status });
  }
}

/**
 * Carry a named candidate's CV onto this employee — the already-hired half of the same move the
 * create path makes by itself.
 *
 * A DELIBERATE CHOICE OF ONE CANDIDATE, never a match this route worked out. The body carries the
 * candidate id a person picked out of the search above, having compared the name, the phone tail
 * and the CV's own filename. Nothing here infers who the employee is: on this production data a
 * phone match was wrong 3 times in 8 (see employee-cv-candidates.ts), and a stranger's CV filed
 * under an employee's name is worse than no CV at all.
 *
 * A COPY, not a link, because copyCandidateCvToEmployee copies — the employee outlives the
 * application, and `ats_files` cascades when a candidate row is merged away.
 *
 * PUT rather than a second POST because this REPLACES the whole CV from a named source, and the
 * two bodies could not be told apart otherwise (multipart for an upload, JSON here).
 */
export async function PUT(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { hrId } = await params;
    const access = await assertCanManage(request, hrId);
    const body = (await request.json().catch(() => ({}))) as { candidateId?: unknown };
    const candidateId = String(body.candidateId ?? "").trim();
    if (!candidateId) {
      return NextResponse.json(
        { error: "employee_cv_carry_no_candidate", message: "Choose the candidate whose CV this is." },
        { status: 400 },
      );
    }
    const record = await copyCandidateCvToEmployee({
      actorHrId: access.hrId ?? null,
      candidateId,
      hrId,
    });
    if (!record) {
      // 422, not 500: the request was understood and the candidate is real, there is simply no CV
      // behind them to carry. Says so plainly, because the person just chose them from a list that
      // only offers candidates with a CV — so if this fires, the file went missing between the two
      // calls and "nothing happened" would be the wrong thing to show.
      return NextResponse.json(
        {
          error: "employee_cv_carry_empty",
          message: "That candidate has no CV file on record any more.",
        },
        { status: 422 },
      );
    }
    return NextResponse.json({ cv: record, success: true });
  } catch (error) {
    const { message, status } = errorStatus(error);
    return NextResponse.json({ error: "employee_cv_carry_failed", message }, { status });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { hrId } = await params;
    await assertCanManage(request, hrId);
    await clearEmployeeCv(hrId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const { message, status } = errorStatus(error);
    return NextResponse.json({ error: "employee_cv_clear_failed", message }, { status });
  }
}
