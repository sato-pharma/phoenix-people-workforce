// Download one attachment from the signed-in person's own email. Always served as a download
// (octet-stream, Content-Disposition: attachment, nosniff): a received HTML or SVG file must never
// render on Phoenix's own origin, where it could act as the signed-in person.

import type { AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { attachmentDisposition, parseFolder, PersonalMailboxError } from "@/lib/personal-mailbox/rules";
import { personalMailboxErrorResponse } from "@/lib/personal-mailbox/route-errors";
import { assertPersonalMailboxCeiling } from "@/lib/personal-mailbox/route-limits";
import { readPersonalMailboxAttachment, resolveMailboxOwner } from "@/lib/personal-mailbox/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/messages/mailbox/attachment";

export async function GET(request: Request) {
  let access: AccessContext | null = null;
  try {
    access = await resolveAccessContext(request);
    const owner = await resolveMailboxOwner(access);
    const url = new URL(request.url);
    const folder = parseFolder(url.searchParams.get("folder"));
    const uid = Number(url.searchParams.get("uid"));
    const index = Number(url.searchParams.get("index"));
    if (!folder || !Number.isInteger(uid) || uid <= 0 || !Number.isInteger(index) || index < 0) {
      throw new PersonalMailboxError("Unknown attachment.");
    }
    await assertPersonalMailboxCeiling(owner.key, "read");
    const attachment = await readPersonalMailboxAttachment(owner, folder, uid, index);
    return new Response(new Uint8Array(attachment.content), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": attachmentDisposition(attachment.filename),
        "Content-Length": String(attachment.content.length),
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return personalMailboxErrorResponse({ access, error, fallbackMessage: "Could not download that file.", request, route: ROUTE });
  }
}
