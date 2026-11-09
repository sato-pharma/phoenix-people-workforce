import { createHash, createHmac } from "node:crypto";

import { isCredentialEmailKind } from "@/lib/email/transactional-types";
import { openSecret, sealSecret } from "@/lib/security/secret-box";

/**
 * A credential email in the outbox never sits in the table readable (owner, 9 Nov 2026).
 *
 * The reset code rides in the email's `metrics` and the set-your-password link in its `ctaHref`, and
 * the outbox stored the whole email input as its payload: every code and every 48-hour link sent
 * since 7 Oct 2026 was readable in `notification_outbox` for the 90 days a sent row is kept. A
 * database read was a password reset.
 *
 * Now the two fields are sealed (AES-256-GCM, secret-box) before the row is written and opened only
 * in memory to send. Once the row is finished (sent, skipped, or out of retries) they are deleted
 * outright and the row says `credentialRedacted`. Only emails stamped `credentialEmail` are touched;
 * every other email is stored exactly as before.
 */
export const CREDENTIAL_SEAL_CONTEXT = "notification-outbox-credential";

/** The fields of a credential email that carry the credential itself. */
type CredentialFields = {
  ctaHref?: string;
  metrics?: Array<{ label: string; value: string | number }>;
};

type SealablePayload = CredentialFields & {
  credentialEmail?: string | null;
  credentialRedacted?: boolean;
  sealedCredential?: string;
};

const sealOptions = { context: CREDENTIAL_SEAL_CONTEXT, keyEnv: "PHOENIX_AUTH_SECRET" } as const;

/** The payload the outbox writes: a credential email's code and link sealed, any other email unchanged. */
export function sealCredentialFields<T extends SealablePayload>(input: T): T {
  if (!isCredentialEmailKind(input.credentialEmail)) return input;
  const { ctaHref, metrics, ...rest } = input;
  const fields: CredentialFields = { ctaHref, metrics };
  return { ...rest, sealedCredential: sealSecret(JSON.stringify(fields), sealOptions) } as T;
}

/**
 * The payload as the sender needs it: the sealed fields opened back in place. A row with nothing
 * sealed (any other email, or a row queued before the seal) is returned as it is. Throws when the
 * seal cannot be opened (the secret changed), which fails the attempt like any other send error.
 */
export function openCredentialFields<T extends SealablePayload>(payload: T): T {
  if (typeof payload.sealedCredential !== "string") return payload;
  const { sealedCredential, ...rest } = payload;
  const fields = JSON.parse(openSecret(sealedCredential, sealOptions)) as CredentialFields;
  return { ...rest, ctaHref: fields.ctaHref, metrics: fields.metrics } as T;
}

/**
 * The payload a FINISHED credential row keeps: the code and the link deleted, sealed or not.
 * Null when the row is not a credential email and nothing should change.
 */
export function redactedCredentialPayload<T extends SealablePayload>(payload: T): T | null {
  if (!isCredentialEmailKind(payload.credentialEmail) && typeof payload.sealedCredential !== "string") return null;
  const redacted: T = { ...payload, credentialRedacted: true };
  delete redacted.ctaHref;
  delete redacted.metrics;
  delete redacted.sealedCredential;
  return redacted;
}

/**
 * The outbox dedupe key. A plain SHA-256 of a payload holding a six-digit code is the code: a
 * million guesses re-derive it. A credential email's key is keyed with PHOENIX_AUTH_SECRET instead.
 */
export function outboxDedupeDigest(normalizedJson: string, credentialEmail: unknown): string {
  if (!isCredentialEmailKind(credentialEmail)) {
    return createHash("sha256").update(normalizedJson).digest("hex");
  }
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  if (!secret) throw new Error("PHOENIX_AUTH_SECRET is required to queue a credential email.");
  return createHmac("sha256", `${secret}\u0000${CREDENTIAL_SEAL_CONTEXT}`).update(normalizedJson).digest("hex");
}
