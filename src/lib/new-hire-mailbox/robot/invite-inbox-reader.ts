/**
 * Fetch a new mailbox's activation invitation out of the invite inbox.
 *
 * ## Why this exists at all
 *
 * Turbify's CREATE does not behave like its RESET. A reset raises a "One-time password" dialog the
 * robot reads on the spot; a create makes the mailbox **PENDING** and emails the credential to
 * whatever address the form's invite field carried — which `createMailbox` fills with
 * `TURBIFY_INVITE_RECIPIENT`, the inbox Phoenix owns for this and nothing else. So the create path
 * cannot be finished by looking at a page. The password arrives by mail or it does not arrive.
 *
 * `invitation.ts` has read that mail correctly since it was written — `readInvitation`,
 * `readTempPassword`, `pickInvitation`, all tested against the real 2026-10-03 message. It had **no
 * caller**: the inbox was readable and nothing read it. This is the caller. It turns "a monitored
 * mailbox" into "the messages those three functions judge", and decides nothing about them itself.
 *
 * ## Four decisions that are not obvious
 *
 * 🔴 **THE ORDER IS IMPOSED HERE, NOT TRUSTED.** `pickInvitation` documents that it takes messages
 * newest-first and returns the first match, so a mailbox re-invited after a failed activation gets
 * its LATEST temp password rather than a spent one — Turbify's are one-use. That contract is
 * satisfied only if somebody sorts, and IMAP returns what the server feels like returning. So this
 * sorts by `date` descending, and an undated message sorts LAST rather than first: undated jumping
 * the queue is exactly how a spent password gets chosen.
 *
 * 🔴 **ONLY PLAUSIBLE INVITATIONS ARE OPENED.** A listing is headers; a body is another fetch each.
 * Narrowing on headers — Turbify's own sender, or the wanted address named in the subject or the
 * recipients — keeps a run at one or two body fetches instead of `limit`, and means Phoenix does not
 * open mail it has no business opening even in a mailbox it owns. Every one of those fetches is
 * audited by `withMonitorRead` under the robot's actor, so "fewer" is not only cheaper.
 *
 * 🔴 **AN UNREADABLE INBOX IS NOT AN EMPTY ONE.** "No invitation has arrived yet" is a WAIT and "the
 * inbox is not connected" is a JOB somebody has to do, and a caller that cannot tell them apart
 * polls for ever. `pickInvitation` already refuses a non-array for this reason; the same care
 * applies one level up, so every failure path here returns a refusal naming what could not be done.
 *
 * 🔴 **THERE IS DELIBERATELY NO "ONLY INVITATIONS NEWER THAN THE CREATE" FILTER.** It was considered
 * and rejected: it defends against a spent invitation for the same address, which `readExistingRow`
 * has already refused one step earlier (the create does not run at all if Turbify knows the
 * address), while it would silently drop the REAL invitation whenever the mail server's clock and
 * the container's disagree. The failure it prevents is honest and retryable — an activation with a
 * dead password, reported as such. The failure it would introduce reports a mailbox as never created
 * while it sits PENDING on the live domain, which is the exact confusion this whole flow exists to
 * end.
 *
 * Nothing here logs a body, a subject or a temp password, and no refusal carries one.
 */
import {
  INVITATION_SENDER,
  pickInvitation,
  readInvitation,
  type InvitationMessage,
  type InvitationReading,
} from "@/lib/new-hire-mailbox/robot/invitation";
import { INVITE_INBOX_ADDRESS } from "@/lib/new-hire-mailbox/robot/invite-inbox";

/** The folder an invitation lands in. Turbify files it nowhere else. */
export const INVITE_INBOX_FOLDER = "INBOX" as const;

/** How many headers to pull before narrowing. Generous: headers are cheap, bodies are not. */
export const INVITE_INBOX_SCAN_LIMIT = 40;

/**
 * How long the create path waits for Turbify to deliver. Measured 2026-10-03: the invitation for
 * `hr.mailbox@satopharma.com` was in the inbox by the time anyone looked, and Turbify sends it as
 * part of the save. Six passes ten seconds apart is a minute — long enough for a slow delivery,
 * short enough that a browser session does not expire underneath it.
 */
export const INVITATION_POLL = { attempts: 6, waitMs: 10_000 } as const;

/** One listed message, in the only fields this module judges. */
export type ListedMessage = {
  date: string | null;
  fromAddress: string | null;
  subject: string | null;
  toAddresses?: readonly string[] | null;
  uid: number;
};

/** One opened message. `text` is preferred; `html` is the fallback Turbify sometimes sends. */
export type OpenedMessage = {
  html: string | null;
  subject: string | null;
  text: string | null;
};

/** Everything the reader needs from the world, so its own tests need no IMAP. */
export type InviteInboxReaderDeps = {
  /** The monitor id for an address, or `null` when that mailbox is not connected to Phoenix. */
  findMonitorId: (address: string) => Promise<string | null>;
  /** Headers only. */
  listMessages: (monitorId: string, folder: string, limit: number) => Promise<readonly ListedMessage[]>;
  /** One body. `null` when the message has gone between the listing and the fetch. */
  openMessage: (monitorId: string, folder: string, uid: number) => Promise<OpenedMessage | null>;
};

/**
 * Sort newest-first, putting undated messages LAST.
 *
 * 🔴 THE HAZARD IS `NaN`, NOT 1970. `Date.parse` of a missing or malformed header returns `NaN`, and
 * every comparison with `NaN` is false — so a comparator that returns `NaN` is inconsistent, the
 * sort is free to leave the array as it found it, and an undated message sitting first in the IMAP
 * listing is then taken as the newest invitation. That hands back a password that may be spent, for
 * a message whose age nothing knows. Measured by break-and-watch 2026-10-03: `0` in place of
 * `-Infinity` changes NOTHING for any real date (1970 is still older than everything), so the guard
 * is specifically against the unguarded `NaN` and `-Infinity` is simply the value that is right by
 * construction rather than by the calendar.
 */
function newestFirst(messages: readonly ListedMessage[]): ListedMessage[] {
  const when = (message: ListedMessage): number => {
    const parsed = Date.parse(String(message.date ?? ""));
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  return [...messages].sort((left, right) => when(right) - when(left));
}

/**
 * Could this be the invitation for `wanted`? Judged on headers alone, so the rest stay unopened.
 *
 * The recipient test is identity, never `includes`: one invite inbox receives every new hire's
 * invitation and `adel.sayed@satopharma.com` contains `el.sayed@satopharma.com`, a pair that has
 * already cost this robot a wrongly-refused new hire. The SUBJECT test is the one containment test,
 * because Turbify writes the address inside brackets in a sentence — and it only promotes a message
 * to being OPENED, after which `readInvitation` matches by identity and refuses the near miss.
 */
export function looksLikeInvitationFor(message: ListedMessage, wanted: string): boolean {
  const target = String(wanted ?? "").trim().toLowerCase();
  if (target.length === 0) return false;
  if (String(message.fromAddress ?? "").trim().toLowerCase().includes(INVITATION_SENDER)) return true;
  if (String(message.subject ?? "").toLowerCase().includes(target)) return true;
  return (message.toAddresses ?? []).some(
    (address) => String(address ?? "").trim().toLowerCase() === target,
  );
}

/**
 * A reading, plus whether WAITING could change it.
 *
 * 🔴 **THIS DISTINCTION IS THE WHOLE VALUE OF THE POLL.** Only one refusal improves with time: the
 * inbox was read and holds no invitation for this mailbox *yet*. Every other one — no invite inbox
 * configured, the inbox not connected to Phoenix, a lookup or a listing that threw — says the same
 * thing on the sixth pass as on the first, and retrying it only delays an honest report by a minute
 * while a browser session ages. So the reader decides it here, where it knows which branch it took,
 * instead of leaving the caller to guess from the wording of a sentence.
 */
export type InviteInboxReading = {
  reading: InvitationReading;
  /** True only when the inbox was READ and simply has nothing for this mailbox yet. */
  retryable: boolean;
};

/**
 * The newest invitation in the invite inbox that activates `address`, or a refusal saying why not.
 *
 * `inbox` is the mailbox being READ — Phoenix's own invite inbox — and `address` is the mailbox being
 * ACTIVATED. They are never the same one, and keeping them as two arguments is deliberate: a
 * single-address version of this function is how a flow ends up reading the wrong mailbox.
 */
export async function readInvitationFromInbox(input: {
  address: string;
  deps: InviteInboxReaderDeps;
  inbox?: string;
  limit?: number;
}): Promise<InvitationReading> {
  return (await readInviteInbox(input)).reading;
}

/** As `readInvitationFromInbox`, and says whether waiting could change the answer. */
export async function readInviteInbox(input: {
  address: string;
  deps: InviteInboxReaderDeps;
  inbox?: string;
  limit?: number;
}): Promise<InviteInboxReading> {
  const settled = (refusal: string): InviteInboxReading => ({ reading: { refusal }, retryable: false });
  const wanted = String(input.address ?? "").trim().toLowerCase();
  const inbox = String(input.inbox ?? INVITE_INBOX_ADDRESS).trim().toLowerCase();
  const limit = input.limit ?? INVITE_INBOX_SCAN_LIMIT;

  if (wanted.length === 0) {
    return settled("No address was given to look for an invitation for, so nothing was read.");
  }
  if (inbox.length === 0) {
    return settled(
      "No invite inbox is configured (TURBIFY_INVITE_RECIPIENT is empty), so Turbify's invitation "
      + "has nowhere to be read from and a created mailbox cannot be finished.",
    );
  }

  let monitorId: string | null = null;
  try {
    monitorId = await input.deps.findMonitorId(inbox);
  } catch (error) {
    return settled(
      `Could not look up the invite inbox ${inbox} in the mailbox monitor, so the robot cannot tell `
      + "whether an invitation arrived. It stopped rather than treat an unreadable inbox as an empty "
      + `one. (${describe(error)})`,
    );
  }
  if (!monitorId) {
    return settled(
      `${inbox} is not connected to Phoenix, so Turbify's invitation cannot be read and a created `
      + "mailbox cannot be finished. Connect it on the Mailbox Monitor page — it needs an app "
      + "password for that mailbox, and the connection is tested before it is saved.",
    );
  }

  let listed: readonly ListedMessage[];
  try {
    listed = await input.deps.listMessages(monitorId, INVITE_INBOX_FOLDER, limit);
  } catch (error) {
    return settled(
      `Could not read ${inbox}, so the robot cannot tell whether an invitation for ${wanted} `
      + "arrived. It stopped rather than treat an unreadable inbox as an empty one. "
      + `(${describe(error)})`,
    );
  }
  // A listing that is not an array is an inbox nothing could be read from, not an empty one —
  // `pickInvitation` owns that wording, and this is settled: another pass reads the same thing.
  if (!Array.isArray(listed)) return { reading: pickInvitation(null, wanted), retryable: false };

  const candidates = newestFirst(listed).filter((message) => looksLikeInvitationFor(message, wanted));

  // Opened lazily, newest-first, stopping at the first message that yields credentials. The ones
  // already opened are KEPT so that, when none matches, `pickInvitation` writes the refusal — one
  // wording for "nothing has arrived yet" and "none of these is for you", rather than a second copy
  // of both here that will drift from the first.
  const opened: InvitationMessage[] = [];
  for (const candidate of candidates) {
    let body: OpenedMessage | null = null;
    try {
      body = await input.deps.openMessage(monitorId, INVITE_INBOX_FOLDER, candidate.uid);
    } catch {
      // One unreadable message is not an unreadable inbox: the next candidate may be the invitation.
      continue;
    }
    if (!body) continue;
    const message: InvitationMessage = {
      body: body.text ?? body.html ?? "",
      from: candidate.fromAddress,
      subject: body.subject ?? candidate.subject,
    };
    opened.push(message);
    const reading = readInvitation(message, wanted);
    if ("credentials" in reading) return { reading, retryable: false };
  }

  // The inbox WAS read. Whether it held nothing yet or held nothing for this mailbox, the next pass
  // can legitimately differ — Turbify delivers the invitation as part of the save, not before it.
  return { reading: pickInvitation(opened, wanted), retryable: true };
}

/**
 * Read the invite inbox until the invitation for `address` turns up, or stop with the reason.
 *
 * Stops on the FIRST settled refusal rather than burning the remaining passes on an answer that
 * cannot change, and never waits after the last attempt — a trailing sleep only delays the report.
 */
export async function pollForInvitation(input: {
  address: string;
  attempts?: number;
  deps: InviteInboxReaderDeps;
  inbox?: string;
  limit?: number;
  wait?: (ms: number) => Promise<void>;
  waitMs?: number;
}): Promise<InvitationReading> {
  const attempts = Math.max(1, input.attempts ?? INVITATION_POLL.attempts);
  const waitMs = Math.max(0, input.waitMs ?? INVITATION_POLL.waitMs);
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let last: InviteInboxReading = {
    reading: { refusal: `No attempt to read the invite inbox for ${input.address} was made.` },
    retryable: false,
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await readInviteInbox(input);
    if ("credentials" in last.reading) return last.reading;
    if (!last.retryable) return last.reading;
    if (attempt < attempts - 1) await wait(waitMs);
  }
  return last.reading;
}

/** An error's message, for a refusal. Never the error itself: a stack can carry a URL and a token. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
