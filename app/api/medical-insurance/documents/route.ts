import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { medicalInsuranceErrorResponse } from "@/lib/medical-insurance/route-helpers";
import { addMedicalInsuranceDocument, SEAT_DOCUMENT_KINDS } from "@/lib/medical-insurance/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Saves a communication tool or a form: a file, or an email's pasted text. */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance", "update");

    const form = await request.formData();
    const upload = form.get("file");
    const file = upload instanceof File && upload.size > 0 ? { bytes: Buffer.from(await upload.arrayBuffer()), fileName: upload.name || "document" } : null;
    await addMedicalInsuranceDocument(
      access,
      {
        body: form.get("body"),
        emailFrom: form.get("emailFrom"),
        emailSentOn: form.get("emailSentOn"),
        emailTo: form.get("emailTo"),
        file,
        kind: form.get("kind"),
        note: form.get("note"),
        title: form.get("title"),
      },
      SEAT_DOCUMENT_KINDS,
    );
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return medicalInsuranceErrorResponse(error, "medical_insurance_document_failed");
  }
}
