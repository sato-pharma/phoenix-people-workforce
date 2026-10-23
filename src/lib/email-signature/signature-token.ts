import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";

import { previousAuthSecret } from "@/lib/auth/previous-secret";
import { hrIdForStorage } from "@/lib/hr-id";

// The public address of a signature picture. A mail app fetches the picture with no Phoenix session, so
// the address itself is the credential — but it must not SAY who it is for: an HR id in every email a
// person sends is a code, not a name. The id is sealed (AES-256-GCM under a key derived from
// PHOENIX_AUTH_SECRET); the nonce is derived from the id so the SAME person always gets the SAME address
// — copy the signature twice and both pastes point at one picture — and a tampered address fails to
// open rather than opening someone else.

const KEY_LABEL = "phoenix-email-signature-token-v1";

function keyFrom(secret: string): Buffer {
  return createHmac("sha256", secret).update(KEY_LABEL).digest();
}

function key(): Buffer {
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  if (!secret) throw new Error("PHOENIX_AUTH_SECRET is required for email signature addresses.");
  return keyFrom(secret);
}

function openWith(raw: Buffer, secretKey: Buffer): string | null {
  try {
    // authTagLength pins the tag at the full 16 bytes, so a shortened tag is refused rather than checked.
    const decipher = createDecipheriv("aes-256-gcm", secretKey, raw.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(raw.subarray(12, 28));
    const id = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return id || null;
  } catch {
    return null;
  }
}

export function sealSignatureToken(hrId: string): string {
  const id = hrIdForStorage(hrId);
  if (!id) throw new Error("An HR id is required to seal a signature address.");
  const secretKey = key();
  const iv = createHmac("sha256", secretKey).update(`iv:${id}`).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", secretKey, iv);
  const sealed = Buffer.concat([cipher.update(id, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url");
}

export function openSignatureToken(token: string | null | undefined, now: Date = new Date()): string | null {
  if (!token || token.length > 200) return null;
  let raw: Buffer;
  let currentKey: Buffer;
  try {
    raw = Buffer.from(token, "base64url");
    currentKey = key();
  } catch {
    return null;
  }
  if (raw.length <= 28) return null;
  const opened = openWith(raw, currentKey);
  if (opened) return opened;
  // An address pasted into signatures before the secret rotation keeps its picture until the end date
  // in src/lib/auth/previous-secret.ts. Sealing above always uses the current secret.
  const previous = previousAuthSecret(now);
  return previous ? openWith(raw, keyFrom(previous)) : null;
}
