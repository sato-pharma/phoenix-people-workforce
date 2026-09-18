// Personal mailbox — shared types (no I/O).
//
// Each employee connects their OWN Turbify mailbox to the envelope in the top bar, once, and then
// reads and sends their company mail inside Phoenix. Nothing here is visible to anyone but that
// employee — see src/lib/personal-mailbox/service.ts for how that is held.

export type PersonalMailboxStatus = "active" | "needs_reconnect";

/** The two folders the envelope shows. Anything else stays in Turbify's own webmail. */
export type PersonalMailboxFolder = "inbox" | "sent";

/** What the envelope needs to draw the "My email" tab. Never carries the password. */
export type PersonalMailboxState =
  | {
      connected: false;
      /** The viewer's own company address on record, or null when HR has none on file. */
      emailAddress: string | null;
    }
  | {
      connected: true;
      emailAddress: string;
      status: PersonalMailboxStatus;
      lastError: string | null;
      connectedAt: string;
    };

/** One row in a folder listing — the envelope only, no body. */
export type PersonalMailboxSummary = {
  uid: number;
  fromName: string | null;
  fromAddress: string | null;
  toAddresses: string[];
  subject: string | null;
  date: string | null;
  seen: boolean;
  answered: boolean;
  hasAttachments: boolean;
};

export type PersonalMailboxPage = {
  folder: PersonalMailboxFolder;
  messages: PersonalMailboxSummary[];
  /** Pass back as `before` to load the next, older page; null when this page reached the start. */
  nextBefore: number | null;
};

export type PersonalMailboxAttachment = {
  index: number;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
};

/** One opened message for the reader. */
export type PersonalMailboxMessage = {
  uid: number;
  folder: PersonalMailboxFolder;
  messageId: string | null;
  references: string[];
  fromName: string | null;
  fromAddress: string | null;
  replyToAddresses: string[];
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  date: string | null;
  text: string | null;
  html: string | null;
  attachments: PersonalMailboxAttachment[];
};

export type PersonalMailboxOutgoingAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
};

export type PersonalMailboxSendInput = {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string[];
  attachments: PersonalMailboxOutgoingAttachment[];
};

/** The live credential, assembled server-side from the owner's decrypted row. */
export type PersonalMailboxCredential = {
  user: string;
  password: string;
};
