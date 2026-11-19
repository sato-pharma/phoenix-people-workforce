import { approvalsApiError, approvalsWhatsAppForbidden } from "@/app/api/admin/approvals-whatsapp/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { getApprovalsAttachment } from "@/lib/approvals-whatsapp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Types a browser may render inline without running anything. Everything else downloads.
const INLINE_TYPES = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|3gpp|webm)|audio\/(aac|amr|mpeg|mp4|ogg)|application\/pdf)$/;

function contentDisposition(kind: "inline" | "attachment", fileName: string) {
  const ascii = fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** One message's photo, file, video or voice note on the approvals line. Super Admin only. `?download=1` saves it. */
export async function GET(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const { messageId } = await params;
    const attachment = await getApprovalsAttachment(messageId);
    const mimeType = attachment.mimeType.split(";")[0]!.trim().toLowerCase();
    const inline = new URL(request.url).searchParams.get("download") !== "1" && INLINE_TYPES.test(mimeType);
    return new Response(new Uint8Array(attachment.bytes), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", attachment.fileName),
        "Content-Length": String(attachment.bytes.length),
        "Content-Type": inline ? mimeType : "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
      status: 200,
    });
  } catch (error) {
    return approvalsApiError(error, "Failed to open the attachment.");
  }
}
