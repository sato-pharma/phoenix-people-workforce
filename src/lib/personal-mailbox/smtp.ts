// Personal mailbox — the outgoing half. Sends as the OWNER, through Turbify's own server, with the
// owner's own app password: the email leaves from their real address and is indistinguishable from
// one sent in Turbify's webmail. Nothing here ever sends on Phoenix's behalf, and nothing here is
// reachable except from the owner's own Send button (app/api/messages/mailbox/send/route.ts).

import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";

import { TURBIFY_SMTP } from "@/lib/personal-mailbox/rules";
import type { PersonalMailboxCredential, PersonalMailboxSendInput } from "@/lib/personal-mailbox/types";

function transportFor(credential: PersonalMailboxCredential) {
  return nodemailer.createTransport({
    auth: { pass: credential.password, user: credential.user },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    host: TURBIFY_SMTP.host,
    logger: false,
    port: TURBIFY_SMTP.port,
    secure: TURBIFY_SMTP.secure,
    socketTimeout: 30_000,
  });
}

/** Log in to the outgoing server and log out again. Sends nothing. Throws the refusal as-is. */
export async function verifySmtpLogin(credential: PersonalMailboxCredential): Promise<void> {
  const transport = transportFor(credential);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

/** Build the exact bytes that will be sent, so the same bytes can be filed in Sent. */
export async function composeMessage(
  input: PersonalMailboxSendInput,
  from: { name: string; address: string },
): Promise<{ raw: Buffer; messageId: string }> {
  const node = new MailComposer({
    attachments: input.attachments.map((file) => ({
      content: file.content,
      contentType: file.contentType,
      filename: file.filename,
    })),
    cc: input.cc.length > 0 ? input.cc : undefined,
    date: new Date(),
    from,
    inReplyTo: input.inReplyTo ?? undefined,
    references: input.references.length > 0 ? input.references : undefined,
    subject: input.subject,
    text: input.body,
    to: input.to,
  }).compile();
  const raw = await new Promise<Buffer>((resolve, reject) => {
    node.build((error, message) => (error ? reject(error) : resolve(message)));
  });
  return { messageId: node.messageId(), raw };
}

/** Hand the built message to Turbify's server. Resolves only once the server has accepted it. */
export async function sendComposedMessage(
  credential: PersonalMailboxCredential,
  envelope: { from: string; to: string[] },
  raw: Buffer,
): Promise<{ rejected: string[] }> {
  const transport = transportFor(credential);
  try {
    const info = await transport.sendMail({ envelope, raw });
    const rejected = (info.rejected ?? []).map((entry) => (typeof entry === "string" ? entry : entry.address));
    return { rejected };
  } finally {
    transport.close();
  }
}
