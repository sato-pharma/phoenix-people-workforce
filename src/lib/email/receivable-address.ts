import { systemEmail } from "@/config/system-settings";

/**
 * Mail is SENT from one host and RECEIVED on another, and only one of them has mailboxes.
 *
 * `send.satopharma.com` is the sending subdomain: its only MX record is Amazon SES's bounce
 * collector, so nothing addressed to it is ever delivered — the sender gets "this mailbox is not
 * available" and no human sees the reply. The mailboxes (Yahoo/Turbify) live on the apex,
 * `satopharma.com`.
 *
 * A candidate who replied to a job offer hit exactly this, twice. The first time Resend silently
 * dropped the Reply-To (#4090), so the reply button pointed at the From address on the sending
 * subdomain. That fix is correct, but it left the trap set: ANY path that puts the sending
 * subdomain where a human can reply — a config value, a client that ignores Reply-To, a provider
 * that drops the header again, a forwarded copy — reproduces the bounce. So the address a person
 * may answer is mapped onto the receiving domain here, structurally, instead of relying on every
 * caller and every provider to get the header right.
 */
const sendingHost = (systemEmail.defaultFromEmail.split("@")[1] ?? "").toLowerCase();
const receivingHost = sendingHost.includes(".") ? sendingHost.slice(sendingHost.indexOf(".") + 1) : sendingHost;

/** The sending subdomain — the one host in this system that can send mail but never receive it. */
export const sendingOnlyDomain = sendingHost;

/** The domain that owns real mailboxes, derived from the sending subdomain (`send.` stripped). */
export const receivingDomain = receivingHost;

/**
 * `hr@send.satopharma.com` → `hr@satopharma.com`. Any address on another host — the apex, or an
 * outside domain — comes back untouched, as does anything that is not a plain address.
 */
export function toReceivableAddress(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || !sendingHost) return trimmed;
  return trimmed.slice(at + 1).toLowerCase() === sendingHost
    ? `${trimmed.slice(0, at)}@${receivingHost}`
    : trimmed;
}

/** The same rule for a full header value: `Sato Pharma HR <hr@send.satopharma.com>` keeps its name. */
export function toReceivableHeader(value: string): string {
  const match = value.match(/^(\s*.*?\s*)<([^>]+)>\s*$/);
  if (!match) return toReceivableAddress(value);
  return `${match[1]}<${toReceivableAddress(match[2])}>`;
}

/**
 * The Reply-To every outbound mail carries: the caller's own, else `NOTIFICATION_REPLY_TO`, else
 * the system default — and never an address that cannot receive.
 */
export function resolveReplyToAddress(explicit?: string): string {
  return toReceivableAddress(explicit || process.env.NOTIFICATION_REPLY_TO || systemEmail.defaultReplyTo);
}
