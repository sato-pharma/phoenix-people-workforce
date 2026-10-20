import { inboxApiError, inboxForbidden } from "@/app/api/whatsapp-inbox/_lib/inbox-http";
import { requireRecruitmentAccess } from "@/app/api/recruitment/_lib/http";
import { assertInboxMessageVisibleTo, getInboxAttachment } from "@/lib/whatsapp-inbox/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Types a browser may render inline without running anything. Everything else downloads.
const INLINE_TYPES = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|3gpp|webm)|audio\/(aac|amr|mpeg|mp4|ogg)|application\/pdf)$/;

function contentDisposition(kind: "inline" | "attachment", fileName: string) {
  const ascii = fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** One message's photo, file, video or voice note. Super Admin only. `?download=1` saves it. */
export async function GET(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  try {
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const forbidden = inboxForbidden(access);
    if (forbidden) return forbidden;
    const { messageId } = await params;
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's attachment answers as if absent.
    await assertInboxMessageVisibleTo(access, messageId);

    const attachment = await getInboxAttachment(messageId);
    const mimeType = attachment.mimeType.split(";")[0]!.trim().toLowerCase();
    const inline = new URL(request.url).searchParams.get("download") !== "1" && INLINE_TYPES.test(mimeType);
    return new Response(new Uint8Array(attachment.bytes), {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", attachment.fileName),
        "Content-Length": String(attachment.bytes.length),
        "Content-Type": inline ? mimeType : "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
      status: 200,
    });
  } catch (error) {
    return inboxApiError(error, "Failed to open the attachment.");
  }
}
