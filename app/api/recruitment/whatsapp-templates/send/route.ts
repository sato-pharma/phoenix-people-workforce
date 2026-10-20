import { NextResponse } from "next/server";

import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { resolveCommentAuthor } from "@/lib/recruitment/candidate-comments";
import { assertPermission } from "@/lib/auth/permissions";
import { candidateHiddenFrom } from "@/lib/recruitment/workspace/fence";
import { templateAllowedForCandidate } from "@/lib/recruitment/whatsapp-templates/variables";
import { loadCandidateSendContext, manualSendAutoValues } from "@/lib/recruitment/whatsapp-templates/candidate-context";
import { loadEmployeeSendContext } from "@/lib/recruitment/whatsapp-templates/employee-context";
import { toWhatsAppDialNumber, whatsAppSendUrl } from "@/lib/recruitment/whatsapp-templates/send-link";
import { getWhatsAppTemplate, recordTemplateSend } from "@/lib/recruitment/whatsapp-templates/store";
import { renderTemplate, variableLabel } from "@/lib/recruitment/whatsapp-templates/variables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Loose `{ key: value }` map off the request body, with everything coerced to trimmed strings. */
function readValues(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) values[key.trim().toLowerCase()] = text;
  }
  return values;
}

/**
 * Prepare one WhatsApp message and hand back the link that opens it.
 *
 * THE SERVER RENDERS, NOT THE BROWSER. The dialog shows a live preview as the recruiter types, but
 * that preview is a convenience — the text that actually travels is built here, from the template
 * body as stored, at the moment of sending. A client-built message would mean the audit row records
 * whatever the browser chose to report, which is not a record of anything.
 *
 * TWO WAYS TO NAME THE RECIPIENT, and exactly one must win:
 *   candidateId — the number comes from that candidate's row, and the send is filed against them.
 *   employeeHrId — the same, for someone already on the payroll. Gated separately on employees:read,
 *     because this branch resolves a staff mobile number and must not become a directory dump.
 *   toNumber    — a number typed by hand, for someone with no CV in the system.
 * A typed number overrides the candidate's stored one when both arrive, because that is what typing
 * one MEANS: the recruiter is looking at a candidate whose number on file is wrong or missing.
 *
 * The gate is `recruitment: update` — messaging a candidate is acting on the pipeline.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");

    const payload = await readJsonObject(request);
    const templateId = str(payload.templateId);
    const candidateId = str(payload.candidateId);
    const employeeHrId = str(payload.employeeHrId);
    const typedNumber = str(payload.toNumber);
    const submitted = readValues(payload.values);

    if (!templateId) {
      return recruitmentProblem("Pick a template first.", 400);
    }

    const template = await getWhatsAppTemplate(templateId);
    if (!template) {
      return recruitmentProblem("That template no longer exists.", 404);
    }
    if (!template.isActive) {
      return recruitmentProblem("That template is switched off. Turn it back on before using it.", 409);
    }

    // 🔴 THE LIST FILTER IS UX; THIS IS THE BOUNDARY. The GET route stops an employee-only template
    // appearing on a candidate screen, but that is a screen decision — a POST naming a candidateId
    // and an employee-only templateId would otherwise send it. A salary increase is the case that
    // makes this concrete: every field in it is typed, so nothing downstream would refuse, and a
    // serving employee'"'"'s pay rise would reach a job applicant with no error anywhere.
    if (candidateId && !templateAllowedForCandidate(template)) {
      return recruitmentProblem("That template can only be sent to an employee, not to a candidate.", 409);
    }

    const author = await resolveCommentAuthor(access.hrId).catch(() => ({ jobTitle: null, name: null }));

    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant cannot be messaged from her
    // seat — the same "not found" a missing candidate gets, so the refusal tells her nothing.
    const hidden = candidateId ? await candidateHiddenFrom(access, candidateId) : false;
    const candidate = candidateId && !hidden ? await loadCandidateSendContext(candidateId, author.name) : null;
    if (candidateId && !candidate) {
      return recruitmentProblem("That candidate was not found.", 404);
    }

    // Same gate as the GET, for the same reason: this resolves a staff mobile number. Refused
    // rather than silently ignored, so a caller without the permission is told, instead of being
    // handed a message addressed to nobody with the number quietly blank.
    if (employeeHrId) await assertPermission(access, "employees", "read");
    const employee = employeeHrId ? await loadEmployeeSendContext(employeeHrId, author.name) : null;
    if (employeeHrId && !employee) {
      return recruitmentProblem("That employee was not found.", 404);
    }

    // A typed number wins; otherwise fall back to what is on the candidate's row.
    const dialNumber = toWhatsAppDialNumber(typedNumber ?? candidate?.dialNumber ?? employee?.dialNumber ?? null);
    if (!dialNumber) {
      return recruitmentProblem(
        typedNumber
          ? "That number cannot be opened as a WhatsApp chat. Check the digits, or write it in full international form."
          : "There is no usable WhatsApp number on this candidate. Type one to send anyway.",
        400,
      );
    }

    // Auto values FIRST, then what the recruiter typed on top. That order lets a typed value correct
    // a wrong auto one — a candidate whose stored name is "AYA M." can be addressed as "Aya" — while
    // still filling everything in by default.
    const values: Record<string, string> = {
      ...(candidate?.autoValues ?? employee?.autoValues ?? (await manualSendAutoValues(author.name))),
      ...submitted,
    };

    const rendered = renderTemplate(template.body, values);
    if (rendered.missing.length > 0) {
      // Named in the message, in the template's own reading order, so the recruiter is told WHICH
      // box is empty rather than being sent back to hunt for it.
      const names = rendered.missing.map((key) => variableLabel(key)).join(", ");
      return recruitmentProblem(`Fill in ${names} before sending.`, 400, { missing: rendered.missing });
    }

    const url = whatsAppSendUrl(dialNumber, rendered.text);

    // Logged before the link is returned, and never allowed to fail the request — see the note on
    // recordTemplateSend. What is recorded is that the message was PREPARED, not that it arrived.
    await recordTemplateSend({
      candidateId: candidate?.candidateId ?? null,
      employeeHrId: employee?.employeeHrId ?? null,
      openedByHrId: access.hrId ?? null,
      renderedBody: rendered.text,
      templateId: template.id,
      toNumber: dialNumber,
      variableValues: values,
    });

    return NextResponse.json({ message: rendered.text, success: true, toNumber: dialNumber, url });
  } catch (error) {
    return recruitmentApiError(error, "Failed to prepare the WhatsApp message.");
  }
}
