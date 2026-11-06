// Personal mailbox — the outgoing half. Sends as the OWNER, through Turbify's own server, with the
// owner's own app password: the email leaves from their real address and is indistinguishable from
// one sent in Turbify's webmail. Nothing here ever sends on Phoenix's behalf, and nothing here is
// reachable except from the owner's own Send button (app/api/messages/mailbox/send/route.ts).

import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";

import { isTestDryRunRequest } from "@/lib/auth/test-dry-run";
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

type ComposerOptions = ConstructorParameters<typeof MailComposer>[0];

/**
 * Build a message's exact bytes and its Message-ID. Shared by the personal mailbox and the job offer
 * (`src/lib/email/job-offer-smtp.ts`), which both send through Turbify and then file the same bytes
 * in Sent. A Bcc is never written into the bytes (MailComposer's default), so a blind copy travels
 * in the SMTP envelope only.
 */
export async function composeRawMessage(options: ComposerOptions): Promise<{ raw: Buffer; messageId: string }> {
  const node = new MailComposer({ date: new Date(), ...options }).compile();
  const raw = await new Promise<Buffer>((resolve, reject) => {
    node.build((error, message) => (error ? reject(error) : resolve(message)));
  });
  return { messageId: node.messageId(), raw };
}

/** Build the exact bytes that will be sent, so the same bytes can be filed in Sent. */
export async function composeMessage(
  input: PersonalMailboxSendInput,
  from: { name: string; address: string },
): Promise<{ raw: Buffer; messageId: string }> {
  return composeRawMessage({
    attachments: input.attachments.map((file) => ({
      content: file.content,
      contentType: file.contentType,
      filename: file.filename,
    })),
    cc: input.cc.length > 0 ? input.cc : undefined,
    from,
    inReplyTo: input.inReplyTo ?? undefined,
    references: input.references.length > 0 ? input.references : undefined,
    subject: input.subject,
    text: input.body,
    to: input.to,
  });
}

/** Hand the built message to Turbify's server. Resolves only once the server has accepted it. */
export async function sendComposedMessage(
  credential: PersonalMailboxCredential,
  envelope: { from: string; to: string[] },
  raw: Buffer,
): Promise<{ rejected: string[] }> {
  // SMTP is not fetch, so the test-account fence (src/lib/auth/test-dry-run.ts) cannot see it: a test
  // account's dry run is answered here, accepted and never sent.
  if (await isTestDryRunRequest()) return { rejected: [] };
  const transport = transportFor(credential);
  try {
    const info = await transport.sendMail({ envelope, raw });
    // nodemailer types `rejected` as `string[]` — the addresses the server refused. The removed
    // hand-written v9 shim declared it `Array<string | { address: string }>`, so this used to map
    // an object branch that the SMTP transport never actually produces. Copied, not returned by
    // reference, to keep handing the caller its own array exactly as the old `.map()` did.
    const rejected = [...(info.rejected ?? [])];
    return { rejected };
  } finally {
    transport.close();
  }
}
