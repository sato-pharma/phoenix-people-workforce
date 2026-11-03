import { assertPermission } from "@/lib/auth/permissions";
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

// ASSERT THE PERMISSION, THEN NARROW — both halves, in that order, the same shape
// `/api/phoenix-crm/settings` uses for a Super-Admin-only write.
//
// The narrowing alone was the first version of this, and `tests/access-registry-coverage.test.ts`
// refused it: a session route must gate through `assertPermission`/`canAccess`, never a bare role
// comparison. That guard is right and the reason is not bookkeeping. The access registry is the
// declarative inventory of who can call what, and a route that reads a role string directly appears
// in it as ungated — so an audit of "who can reach the signature" would answer from a matrix this
// handler never consulted. Asserting first also means a matrix change reaches this route like any
// other, instead of it quietly keeping its own private rule.
//
// The ACTION differs by verb, matching what the registry declares for `/api/hiring-pack/**`: `read`
// for the GET, `update` for the two writes. Declaring `update` on the read would overstate the gate
// in the inventory, which that test's own note calls out as the direction that reads as false
// comfort to whoever is auditing.
async function gate(request: Request, action: "read" | "update") {
  const access = await resolveAccessContext(request);
  await assertPermission(access, "employee_documents", action);
  if (access.role !== "Super Admin") {
    // Thrown rather than returned so every verb below shapes it through one `failure`, and so the
    // message is the same sentence whichever verb was refused.
    throw Object.assign(new Error("forbidden"), { code: "FORBIDDEN" });
  }
}

function isNotTheSuperAdmin(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "FORBIDDEN";
}

function failure(error: unknown) {
  if (isForbiddenError(error) || isNotTheSuperAdmin(error)) {
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
    await gate(request, "read");
    const dataUri = await loadHrSignatureUri();
    return Response.json(
      { canManage: true, present: dataUri !== null, dataUri },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Everyone who prints papers opens the editor, and the editor asks here to learn whether to draw
    // the signature panel. "Not yours" is the answer to that question, not a refusal: as a 403 it was
    // photographed as a block she met (HR Forms, 2 Nov 2026) on a page where nothing had gone wrong.
    // It carries no image, and whether one is stored stays unsaid. The writes still answer 403.
    if (isNotTheSuperAdmin(error)) {
      return Response.json(
        { canManage: false, present: false, dataUri: null },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    await gate(request, "update");
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
    await gate(request, "update");
    await deleteHrSignature();
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
