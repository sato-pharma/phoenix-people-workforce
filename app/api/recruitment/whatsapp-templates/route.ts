import { NextResponse } from "next/server";

import {
  assertSameOriginMutation,
  bool,
  num,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { resolveCommentAuthor } from "@/lib/recruitment/candidate-comments";
import { assertPermission } from "@/lib/auth/permissions";
import { assertCandidateVisible } from "@/lib/recruitment/workspace/fence";
import { templateAllowedForCandidate } from "@/lib/recruitment/whatsapp-templates/variables";
import { loadCandidateSendContext, manualSendAutoValues } from "@/lib/recruitment/whatsapp-templates/candidate-context";
import { loadEmployeeSendContext } from "@/lib/recruitment/whatsapp-templates/employee-context";
import { createWhatsAppTemplate, listWhatsAppTemplates } from "@/lib/recruitment/whatsapp-templates/store";
import { DEFAULT_TEMPLATE_CATEGORY } from "@/lib/recruitment/whatsapp-templates/template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The WhatsApp message templates, and — when a candidate is named — everything Phoenix can fill in
 * for that person without asking.
 *
 * BOTH IN ONE RESPONSE, deliberately. The send dialog needs the templates and the candidate's number
 * before it can render anything at all; two round trips would show the recruiter an empty box that
 * fills in twice.
 *
 * The gate is `recruitment: update`, not `candidates: read`. Reading a template is one keystroke away
 * from messaging a candidate with it, so the audience for this endpoint is the audience allowed to
 * act on the pipeline — the same grant that sends a CV to a manager or writes a note on a candidate.
 *
 * `includeInactive` is honoured only for a manager view; the send list must never offer a template
 * that was switched off, so it is opt-in rather than the default.
 */
export async function GET(request: Request) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const url = new URL(request.url);
    const candidateId = str(url.searchParams.get("candidateId"));
    const includeInactive = url.searchParams.get("includeInactive") === "true";
    const employeeHrId = url.searchParams.get("employeeHrId");

    const author = await resolveCommentAuthor(access.hrId).catch(() => ({ jobTitle: null, name: null }));
    const allTemplates = await listWhatsAppTemplates({ includeInactive });

    // A CV screen is not offered templates it could never fill. `probation_end_date` is answerable
    // only from an employee record, so a probation template opened from a candidate was refused with
    // "asks for: Probation end date" — safe, but two rows a recruiter can never use.
    //
    // ONLY when a candidate is named. The template MANAGER calls this route with no target at all
    // (it passes includeInactive=true), and it must keep showing every template, because it is where
    // they are written — a template hidden from its own editor cannot be edited. The employee screen
    // is unaffected for the obvious reason.
    const templates = candidateId
      ? allTemplates.filter((template) => templateAllowedForCandidate(template))
      : allTemplates;

    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's number and name never reach
    // her through the send dialog — the candidate answers as if absent.
    if (candidateId) await assertCandidateVisible(access, candidateId);
    const candidate = candidateId ? await loadCandidateSendContext(candidateId, author.name) : null;

    // THE EMPLOYEE TARGET CARRIES ITS OWN GATE. This branch returns a staff member's name, job title
    // and MOBILE NUMBER, which `recruitment:update` does not cover and must not become a way to
    // enumerate the directory. `employees:read` is the permission that already governs seeing an
    // employee record, so it is the one asked for here — a recruiter who cannot open the employee
    // record cannot pull the same fields out through this endpoint either.
    if (employeeHrId) await assertPermission(access, "employees", "read");
    const employee = employeeHrId ? await loadEmployeeSendContext(employeeHrId, author.name) : null;

    return NextResponse.json({
      candidate,
      employee,
      // The manual path gets the same auto values a candidate would, minus anything person-specific.
      // Handed over even when a candidate WAS named, so the dialog can switch to a typed number
      // without another request.
      manualAutoValues: await manualSendAutoValues(author.name),
      success: true,
      templates,
    });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the WhatsApp templates.");
  }
}

/**
 * Create a template.
 *
 * `admin: update` — Super Admin only, the same gate as the WhatsApp screening-question wording. The
 * wording of a message that goes to candidates in the company's name is an owner-level decision, and
 * the audience allowed to SEND one is deliberately much wider than the audience allowed to REWRITE
 * what everybody sends.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "admin", "update");

    const payload = await readJsonObject(request);
    const template = await createWhatsAppTemplate(
      {
        body: str(payload.body) ?? "",
        category: str(payload.category) ?? DEFAULT_TEMPLATE_CATEGORY,
        isActive: bool(payload.isActive) ?? true,
        name: str(payload.name) ?? "",
        sortOrder: num(payload.sortOrder) ?? 0,
      },
      access.hrId ?? null,
    );

    return NextResponse.json({ success: true, template });
  } catch (error) {
    return recruitmentApiError(error, "Failed to create the template.");
  }
}
