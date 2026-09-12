import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canUseSatoEmail } from "@/lib/sato-email/access";
import { storeSatoEmailMedia } from "@/lib/sato-email/media";
import { SATO_EMAIL_MEDIA_MAX_FILE_BYTES, formatBytes, type SatoEmailMediaKind } from "@/lib/sato-email/media-limits";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Upload one picture or file for a Sato email — the attach button, and the toolbar's Insert image.
 *
 * Owner 2026-09-12: "make an option to attach pic or file and to put pic in message body".
 *
 * `kind` decides what the upload becomes and is the only thing the caller chooses: `inline` mints a
 * permanent public token so a mail client can fetch the picture days later, `attachment` mints none
 * and the bytes only ever leave inside the message. The caller never names a bucket or a path — see
 * the module header on `src/lib/sato-email/media.ts` for why that distinction is the whole design.
 *
 * Gated by exactly the same `canUseSatoEmail` as every other route behind this screen: Super Admin
 * and the HR Business Partner. A file store reachable by anyone else would be an open upload
 * endpoint on the company's own domain.
 */
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canUseSatoEmail(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 30,
      scope: "sato-email:media",
      windowMs: 60_000,
    });

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) {
      return NextResponse.json({ message: "Choose a file to upload." }, { status: 400 });
    }

    const kind = String(form.get("kind") ?? "attachment") as SatoEmailMediaKind;
    if (kind !== "inline" && kind !== "attachment") {
      return NextResponse.json({ message: "A file is either a body picture or an attachment." }, { status: 400 });
    }

    // Checked before the bytes are read into memory as well as inside the store, because reading a
    // 400MB upload into a Buffer to then refuse it is how one careless drag takes the server down.
    if (file.size > SATO_EMAIL_MEDIA_MAX_FILE_BYTES) {
      return NextResponse.json(
        { message: `A file must be ${formatBytes(SATO_EMAIL_MEDIA_MAX_FILE_BYTES)} or smaller.` },
        { status: 413 },
      );
    }

    const stored = await storeSatoEmailMedia({
      bytes: Buffer.from(await file.arrayBuffer()),
      contentType: file.type,
      filename: file.name,
      kind,
      uploadedByHrId: access.hrId ?? null,
      uploadedByLoginId: access.loginId ?? null,
    });

    if ("message" in stored) {
      return NextResponse.json({ message: stored.message }, { status: 400 });
    }

    // Best effort, and after the fact: the file is already stored, and throwing here would report a
    // failure for an upload that succeeded. It matters because an inline picture has just been given
    // a permanent public address, and who minted it should be answerable later.
    await writeAuditLog({
      actorLoginId: access.loginId ?? access.hrId ?? null,
      entityId: stored.id,
      entityType: "sato_email_media",
      newValues: {
        byteSize: stored.byteSize,
        contentType: stored.contentType,
        filename: stored.filename,
        kind,
        // The address itself, not just the fact that one exists: an inline picture is reachable by
        // anybody holding this link, and a later question about it starts from the link.
        url: stored.url,
      },
      summary: `Uploaded "${stored.filename}" (${formatBytes(stored.byteSize)}) as a Sato email ${kind === "inline" ? "body picture" : "attachment"}`,
    });

    return NextResponse.json({ file: stored });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many uploads — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json({ message: clientSafeErrorMessage(error, "The file could not be uploaded.") }, { status: 500 });
  }
}
