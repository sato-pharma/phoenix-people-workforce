import { assertPermission } from "@/lib/auth/permissions";
import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  CHEQUE_SIGNATURE_MAX_BYTES,
  ChequeSignatureError,
  deleteChequeSignature,
  loadChequeSignatureUri,
  saveChequeSignature,
} from "@/lib/spotlight/cheque-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The CEO's signature for the award cheques - whether one is stored, replace it, remove it.
 *
 * `spotlight:export` and the page's seat fence on every verb: the Super Admin and the CEO. The image
 * is a transparent PNG kept in a private bucket (`cheque-signature.ts`), and the browser only ever
 * gets it back as a thumbnail for the person who is allowed to print it.
 */
async function gate(request: Request) {
  const access = await resolveAccessContext(request);
  await assertPermission(access, "spotlight", "export");
  assertPageOpenForRole(access.role, "/spotlight/cheques");
}

function failure(error: unknown) {
  if (isForbiddenError(error)) {
    return Response.json(
      { error: "The cheque generator is available to the system administrator and the CEO only." },
      { status: 403 },
    );
  }
  if (error instanceof ChequeSignatureError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  return Response.json({ error: clientSafeErrorMessage(error, "The signature could not be saved.") }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    await gate(request);
    const dataUri = await loadChequeSignatureUri();
    return Response.json({ present: dataUri !== null, dataUri }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    await gate(request);
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > CHEQUE_SIGNATURE_MAX_BYTES * 2) {
      throw new ChequeSignatureError("The signature image is too large - keep it under 1.5 MB.");
    }
    await saveChequeSignature(new Uint8Array(await request.arrayBuffer()));
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
    await deleteChequeSignature();
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
