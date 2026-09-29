import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import {
  HR_SIGNATURE_MAX_BYTES,
  HrSignatureError,
  deleteHrSignature,
  loadHrSignatureUri,
  saveHrSignature,
} from "@/lib/hiring-pack/hr-signature";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The signature an HR paper can be signed with — whether one is stored, replace it, remove it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SUPER ADMIN ON EVERY VERB, INCLUDING THE READ, and NOT the `employee_documents` grant the rest of
// `/api/hiring-pack/**` uses. That is the one place this feature is deliberately narrower than its
// neighbours, and the reason is what the object is: everyone who can print a contract holds
// `employee_documents`, and a signature image is not a document — it is the means of signing one.
// Handing it out with the printing grant would mean anybody who can print a paper can also read back
// the picture that signs it, which is precisely the "forgery kit" the private bucket exists to avoid.
//
// The owner is the sole Super Admin and this is his own signature, which is what he asked for. If a
// second person's signature is ever wanted, that is a new decision about whose signature may be
// printed on whose paper — not a widening of this gate. See `hr-signature.ts`.
//
// THE GET RETURNS THE IMAGE ITSELF, as a data URI, so the screen can show what is stored rather than
// only whether something is. That is the whole reason it is gated as tightly as the write.

async function gate(request: Request) {
  const access = await resolveAccessContext(request);
  if (access.role !== "Super Admin") {
    // Thrown rather than returned so every verb below shapes it through one `failure`, and so the
    // message is the same sentence whichever verb was refused.
    throw Object.assign(new Error("forbidden"), { code: "FORBIDDEN" });
  }
}

function failure(error: unknown) {
  const forbidden =
    isForbiddenError(error) ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "FORBIDDEN");
  if (forbidden) {
    return Response.json(
      {
        error: "forbidden",
        message: "The stored signature is the system administrator's — only a Super Admin can see or change it.",
      },
      { status: 403 },
    );
  }
  if (error instanceof HrSignatureError) {
    return Response.json({ error: "invalid_signature", message: error.message }, { status: 400 });
  }
  return Response.json(
    { error: "signature_failed", message: clientSafeErrorMessage(error, "The signature could not be saved.") },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  try {
    await gate(request);
    const dataUri = await loadHrSignatureUri();
    return Response.json(
      { present: dataUri !== null, dataUri },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    await gate(request);
    // Refused on the DECLARED length before the body is read, so an oversized upload is rejected
    // without being buffered. Doubled because a declared length is a claim, not a measurement —
    // `saveHrSignature` weighs the real bytes and is the check that actually binds.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > HR_SIGNATURE_MAX_BYTES * 2) {
      throw new HrSignatureError("The signature image is too large — keep it under 1.5 MB.");
    }
    await saveHrSignature(new Uint8Array(await request.arrayBuffer()));
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    await gate(request);
    await deleteHrSignature();
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
