import { canAccessSystemAdministratorWorkspace, type AccessContext } from "@/lib/auth/permissions";
import { splitCommunicationEmailList } from "@/lib/communication/metrics";
import type { ComposerPayload } from "@/lib/email/email-composer-service";
import { resolveReplyToAddress } from "@/lib/email/receivable-address";
import { SATO_EMAIL_MAX_PER_EMAIL, type SatoEmailRecipient } from "@/lib/sato-email/plan";

/**
 * The pure rules of a distribution-list send from the Email Reply Composer: who may send one, what a
 * request names, why one may not carry variables, and how its audience is counted. The send itself is
 * src/lib/email/email-reply-lists.ts; this file stays free of the mail and database code so
 * tests/email-reply-lists.test.ts can run every rule for real.
 */
/** Emails of 25: the manual recipient policy's own cap, so every email passes it unchanged. */
export const REPLY_BULK_MAX_PER_EMAIL = SATO_EMAIL_MAX_PER_EMAIL;

/** "Dear colleagues," — what a list email opens with when the sender leaves the greeting blank. */
export const REPLY_BULK_GREETING_FALLBACK = "colleagues";

/** A sanity ceiling on how many lists one request may name; the picker offers about seventy. */
const MAX_LIST_KEYS = 100;

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export type ReplyBulkSourceCount = { count: number; source: string };

export type ReplyBulkSummary = {
  emailCount: number;
  listKeys: string[];
  recipientCount: number;
  skipped: Array<{ displayName: string; hrId: string; reason: string }>;
  sources: ReplyBulkSourceCount[];
  visibleTo: string;
};

export type ReplyBulkOutcome = {
  batchIndex: number;
  id: string | null;
  reason: string | null;
  recipients: number;
  status: "sent" | "skipped";
};

export type ReplyBulkSendResult = {
  emailCount: number;
  outcomes: ReplyBulkOutcome[];
  recipientCount: number;
  sentEmails: number;
  status: "failed" | "partial" | "sent" | "skipped";
  /** Set when nothing was attempted at all, with the reason. */
  stoppedReason: string | null;
};

/** Super Admin only — see the file header. Never widened through `communication`. */
export function canSendReplyComposerToLists(access: Pick<AccessContext, "role" | "scope">): boolean {
  return canAccessSystemAdministratorWorkspace(access);
}

/** The list keys a request names: strings only, trimmed, deduped, capped. */
export function normalizeReplyListKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const key = entry.trim();
    if (key) keys.add(key);
    if (keys.size >= MAX_LIST_KEYS) break;
  }
  return Array.from(keys);
}

/** True when this composer request is a list (bulk) send. */
export function isReplyBulkPayload(input: ComposerPayload): boolean {
  return normalizeReplyListKeys(input.listKeys).length > 0;
}

/**
 * Why a list email may not carry variables, or null when it carries none.
 *
 * Refused rather than blanked: the single-send path fills {{employeeName}} from the FIRST selected
 * employee, so the same token in a list email would either mail one person's name to everyone or
 * vanish into "Dear ," — and neither is visible until it has gone.
 */
export function replyBulkVariableProblem(...texts: string[]): string | null {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(VARIABLE_PATTERN)) found.add(`{{${match[1]}}}`);
  }
  if (found.size === 0) return null;
  return `A distribution-list email goes to many people at once, so it cannot fill variables (${Array.from(found).join(", ")}). Write those words out, then preview again.`;
}

/**
 * The one address every copy shows in its To line: the Reply-To inbox, resolved exactly as
 * sendPhoenixEmail resolves it (so a fan-out with no fanoutVisibleTo would land on the same
 * address), and only its first entry when the Reply-To names several. It is a real envelope
 * recipient, so it must be a live inbox — which is what the Reply-To rule already demands.
 */
export function replyBulkVisibleTo(replyTo: string | undefined): string {
  return resolveReplyToAddress(replyTo).split(",")[0]?.trim() ?? "";
}

/** Addresses the sender TYPED (raw fields and email chips) — the only ones that need their own reason. */
export function replyBulkTypedAddresses(input: ComposerPayload): string[] {
  const typed = [
    ...splitCommunicationEmailList(input.to),
    ...splitCommunicationEmailList(input.cc),
    ...splitCommunicationEmailList(input.bcc),
    ...[...(input.toSelections ?? []), ...(input.ccSelections ?? []), ...(input.bccSelections ?? [])]
      .flatMap((selection) => (selection.type === "email" ? [selection.email] : [])),
  ];
  return Array.from(new Set(typed.map((email) => String(email).trim().toLowerCase()).filter(Boolean)));
}

/** Count the planned audience by where each address came from, largest first. */
export function countReplyBulkSources(recipients: readonly SatoEmailRecipient[]): ReplyBulkSourceCount[] {
  const counts = new Map<string, number>();
  for (const recipient of recipients) {
    const source = recipient.source?.trim() || "Picked in the composer";
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return Array.from(counts, ([source, count]) => ({ count, source })).sort(
    (left, right) => right.count - left.count || left.source.localeCompare(right.source),
  );
}
