import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { submitMedicalRepSimpleExpenseRequest } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isWorkflowRegistryTransitionError } from "@/lib/workflow-registry/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseFormBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A photo the rep picked; its size and type are judged by the service, never capped here. */
const formPhoto = z.instanceof(File);

/**
 * The rep's own Expenses form (medical-rep-expenses.tsx): text fields set once each, and one `attachments`
 * entry per photo — a single File for one, a list for several. Every field is optional here so the service
 * still refuses a missing one with its own words (the photo count included, as a 400).
 */
const MedicalRepExpenseFormSchema = z.object({
  amWorkload: z.string().optional(),
  attachments: z.union([formPhoto, z.array(formPhoto)]).optional(),
  goTicketAmount: z.string().optional(),
  notes: z.string().optional(),
  pmWorkload: z.string().optional(),
  returnTicketAmount: z.string().optional(),
  toLocation: z.string().optional(),
  toPlaceId: z.string().optional(),
  tripEndDate: z.string().optional(),
  tripStartDate: z.string().optional(),
});

function formText(value: string | undefined) {
  return String(value ?? "").trim();
}

function isFormFile(value: FormDataEntryValue): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value &&
    "size" in value &&
    Number((value as { size?: unknown }).size) > 0
  );
}

function medicalRepExpenseStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  if (isWorkflowRegistryTransitionError(error)) return 409;

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("required") ||
    message.includes("invalid") ||
    message.includes("negative") ||
    message.includes("too large") ||
    message.includes("must be") ||
    message.includes("not configured") ||
    message.includes("not available")
  ) {
    return 400;
  }

  return 500;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "create");

    const parsedForm = await parseFormBody(request, MedicalRepExpenseFormSchema);
    if (!parsedForm.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedForm.message }, { status: 400 });
    }
    const fields = parsedForm.data;
    const pickedPhotos = Array.isArray(fields.attachments)
      ? fields.attachments
      : fields.attachments
        ? [fields.attachments]
        : [];
    const attachmentFiles = pickedPhotos.filter(isFormFile);
    const attachments = await Promise.all(
      attachmentFiles.map(async (file) => ({
        bytes: Buffer.from(await file.arrayBuffer()),
        contentType: file.type || "application/octet-stream",
        fileName: file.name || "ticket-attachment",
        size: file.size,
      })),
    );

    const requestRecord = await submitMedicalRepSimpleExpenseRequest(access, {
      amWorkload: Number(formText(fields.amWorkload) || "0"),
      attachments,
      goTicketAmount: Number(formText(fields.goTicketAmount)),
      notes: formText(fields.notes),
      pmWorkload: Number(formText(fields.pmWorkload) || "0"),
      returnTicketAmount: Number(formText(fields.returnTicketAmount)),
      toLocation: formText(fields.toLocation),
      // Empty when the rep typed without choosing a suggestion, or when an older client posts.
      // Optional on purpose: a submission must never be refused for want of a place id.
      toPlaceId: formText(fields.toPlaceId) || null,
      tripEndDate: formText(fields.tripEndDate),
      tripStartDate: formText(fields.tripStartDate),
    });

    return NextResponse.json({ request: requestRecord });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to submit expense request.");
    const status = medicalRepExpenseStatus(error);
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "medical_rep_expense_submit_failed",
        message,
      },
      { status },
    );
  }
}
