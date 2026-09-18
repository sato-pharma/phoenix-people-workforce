// Minimal ambient types for "nodemailer" (the personal mailbox's outgoing half). The package ships
// no TypeScript definitions and @types/nodemailer is not in this lockfile, so only the surface
// src/lib/personal-mailbox/smtp.ts actually calls is declared: an SMTP transport that verifies a
// login and sends a pre-built raw message, and the composer that builds that message.
declare module "nodemailer" {
  export type SmtpTransportOptions = {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
    connectionTimeout?: number;
    greetingTimeout?: number;
    socketTimeout?: number;
    logger?: boolean;
    debug?: boolean;
  };

  export type SendRawOptions = {
    envelope: { from: string; to: string[] };
    raw: Buffer;
  };

  export type SentMessageInfo = {
    accepted?: Array<string | { address: string }>;
    rejected?: Array<string | { address: string }>;
    messageId?: string;
    response?: string;
  };

  export interface Transporter {
    verify(): Promise<true>;
    sendMail(options: SendRawOptions): Promise<SentMessageInfo>;
    close(): void;
  }

  export function createTransport(options: SmtpTransportOptions): Transporter;

  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}

declare module "nodemailer/lib/mail-composer" {
  type Address = { name: string; address: string };

  export type ComposerAttachment = {
    filename: string;
    content: Buffer;
    contentType?: string;
  };

  export type ComposerOptions = {
    from: Address;
    to: string[];
    cc?: string[];
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: ComposerAttachment[];
    date?: Date;
  };

  export interface MimeNode {
    build(callback: (error: Error | null, message: Buffer) => void): void;
    messageId(): string;
  }

  export default class MailComposer {
    constructor(options: ComposerOptions);
    compile(): MimeNode;
  }
}
