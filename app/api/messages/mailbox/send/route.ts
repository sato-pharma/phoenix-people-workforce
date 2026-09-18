// Send one email as the signed-in person, from their own company address, through Turbify. Only
// their own Send button reaches this: same-origin only, owner from the session, sent exactly once.

import { NextResponse } from "next/server";

import type { AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  parseAddressList,
  parseMessageIdList,
  PersonalMailboxError,
  safeAttachmentFilename,
} from "@/lib/personal-mailbox/rules";
import { personalMailboxErrorResponse } from "@/lib/personal-mailbox/route-errors";
import { assertPersonalMailboxCeiling } from "@/lib/personal-mailbox/route-limits";
import { resolveMailboxOwner, sendPersonalMailboxEmail } from "@/lib/personal-mailbox/service";
import type { PersonalMailboxOutgoingAttachment } from "@/lib/personal-mailbox/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/messages/mailbox/send";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  let access: AccessContext | null = null;
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    access = await resolveAccessContext(request);
    const owner = await resolveMailboxOwner(access);
    await assertPersonalMailboxCeiling(owner.key, "send");

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new PersonalMailboxError("The email could not be read. Try again.");
    }
    const to = parseAddressList(text(form, "to"));
    const cc = parseAddressList(text(form, "cc"));
    const invalid = [...to.invalid, ...cc.invalid];
    if (invalid.length > 0) {
      throw new PersonalMailboxError(`Not an email address: ${invalid.join(", ")}`);
    }

    const files = form.getAll("files").filter((entry): entry is File => typeof entry !== "string" && entry.size > 0);
    if (files.length > MAX_ATTACHMENTS) throw new PersonalMailboxError(`Attach at most ${MAX_ATTACHMENTS} files.`);
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES) {
      throw new PersonalMailboxError("The attachments are over 15 MB together.");
    }
    const attachments: PersonalMailboxOutgoingAttachment[] = [];
    for (const file of files) {
      attachments.push({
        content: Buffer.from(await file.arrayBuffer()),
        contentType: file.type || "application/octet-stream",
        filename: safeAttachmentFilename(file.name),
      });
    }

    const result = await sendPersonalMailboxEmail(owner, {
      attachments,
      body: text(form, "body"),
      cc: cc.valid,
      inReplyTo: parseMessageIdList(text(form, "inReplyTo"))[0] ?? null,
      references: parseMessageIdList(text(form, "references")),
      subject: text(form, "subject").trim(),
      to: to.valid,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return personalMailboxErrorResponse({ access, error, fallbackMessage: "The email was not sent.", request, route: ROUTE });
  }
}
