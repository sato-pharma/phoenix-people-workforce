import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { submitMedicalRepSimpleExpenseRequest } from "@/lib/outstation/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isWorkflowRegistryTransitionError } from "@/lib/workflow-registry/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formText(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
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

    const formData = await request.formData();
    const attachmentFiles = formData.getAll("attachments").filter(isFormFile);
    const attachments = await Promise.all(
      attachmentFiles.map(async (file) => ({
        bytes: Buffer.from(await file.arrayBuffer()),
        contentType: file.type || "application/octet-stream",
        fileName: file.name || "ticket-attachment",
        size: file.size,
      })),
    );

    const requestRecord = await submitMedicalRepSimpleExpenseRequest(access, {
      amWorkload: Number(formText(formData, "amWorkload") || "0"),
      attachments,
      goTicketAmount: Number(formText(formData, "goTicketAmount")),
      notes: formText(formData, "notes"),
      pmWorkload: Number(formText(formData, "pmWorkload") || "0"),
      returnTicketAmount: Number(formText(formData, "returnTicketAmount")),
      toLocation: formText(formData, "toLocation"),
      tripEndDate: formText(formData, "tripEndDate"),
      tripStartDate: formText(formData, "tripStartDate"),
    });

    return NextResponse.json({ request: requestRecord });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit expense request.";
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
