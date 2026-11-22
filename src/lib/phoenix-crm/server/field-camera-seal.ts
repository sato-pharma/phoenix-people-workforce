/**
 * The Phoenix Camera seal — the cryptographic half (server only: Node crypto).
 *
 * A seal holds when ALL of this is true, and the first that is not is the refusal:
 *   1. the file ends in a well-formed seal and the payload names the SHA-256 of the JPEG exactly — one changed
 *      pixel, one changed stamp, and it does not;
 *   2. the payload is signed by the leaf key of the attestation chain;
 *   3. the chain links certificate by certificate to one of GOOGLE'S attestation roots (by public key, never by
 *      name) — so the key was made inside a real phone's secure chip, never in software;
 *   4. the leaf's attestation says the key lives in that chip (TEE or StrongBox), the phone's bootloader is LOCKED
 *      and its software is VERIFIED (a rooted or re-flashed phone fails here, whatever the payload says), and the
 *      key belongs to the Phoenix Camera signed with OUR release certificate — a modified app cannot reach it;
 *   5. the payload's own rules (seal-rules.ts).
 * Revocation (Google's list), the rep's identity and the phone's history are server/field-camera.ts's.
 */

import { createHash, createVerify, X509Certificate } from "node:crypto";

import {
  FIELD_CAMERA_PACKAGE,
  FIELD_CAMERA_SIGNING_DIGEST,
  SEAL_ATTESTATION_CHALLENGE,
  splitSealedFile,
} from "@/lib/phoenix-crm/field-camera/seal-format";
import {
  parseSealPayload,
  sealIntegrityProblems,
  sealLocationProblems,
  sealPayloadProblems,
  sealPayloadWarnings,
  type SealPayload,
} from "@/lib/phoenix-crm/field-camera/seal-rules";

export type SealIdentity = { packageName: string; signingDigest: string; challenge: string };

export const RELEASE_IDENTITY: SealIdentity = {
  packageName: FIELD_CAMERA_PACKAGE,
  signingDigest: FIELD_CAMERA_SIGNING_DIGEST,
  challenge: SEAL_ATTESTATION_CHALLENGE,
};

export type SealVerdict =
  | {
      ok: true;
      payload: SealPayload;
      /** SHA-256 of the signed payload (never the signature, which can be re-written): one seal, one use. */
      sealId: string;
      /** SHA-256 of the phone key's public half: the same phone, photo after photo. */
      deviceKey: string;
      securityLevel: "TEE" | "StrongBox";
      /** Every certificate's serial (lower-case hex), for Google's revocation list. */
      serials: string[];
      warnings: string[];
      /** The genuineness problems (`sealIntegrityProblems`); always empty unless `purpose` is "camera_sync". */
      integrity: string[];
      /** Why the position cannot stand (`sealLocationProblems`); always empty unless `purpose` is "camera_sync". */
      location: string[];
    }
  | { ok: false; problem: string };

// ── A small DER reader: enough for a certificate's extensions and Android's KeyDescription ───────────────────

type Tlv = { cls: number; constructed: boolean; tag: number; start: number; body: number; end: number };

function readTlv(buf: Uint8Array, offset: number, limit: number = buf.length): Tlv {
  let p = offset;
  if (p >= limit) throw new Error("der: past the end");
  const first = buf[p++];
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let byte: number;
    let guard = 0;
    do {
      if (p >= limit || guard++ > 4) throw new Error("der: bad tag");
      byte = buf[p++];
      tag = tag * 128 + (byte & 0x7f);
    } while (byte & 0x80);
  }
  if (p >= limit) throw new Error("der: no length");
  let length = buf[p++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error("der: bad length");
    length = 0;
    for (let index = 0; index < count; index += 1) {
      if (p >= limit) throw new Error("der: short length");
      length = length * 256 + buf[p++];
    }
  }
  const end = p + length;
  if (end > limit) throw new Error("der: body past the end");
  return { cls: first >> 6, constructed: (first & 0x20) !== 0, tag, start: offset, body: p, end };
}

function childrenOf(buf: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = parent.body;
  while (p < parent.end) {
    const child = readTlv(buf, p, parent.end);
    out.push(child);
    p = child.end;
  }
  return out;
}

function bodyOf(buf: Uint8Array, tlv: Tlv): Uint8Array {
  return buf.subarray(tlv.body, tlv.end);
}

function smallInt(buf: Uint8Array, tlv: Tlv): number {
  const bytes = bodyOf(buf, tlv);
  if (bytes.length === 0 || bytes.length > 6) throw new Error("der: integer too large");
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

const KEY_DESCRIPTION_OID = Uint8Array.from([0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x11]); // 1.3.6.1.4.1.11129.2.1.17
const TAG_ROOT_OF_TRUST = 704;
const TAG_APPLICATION_ID = 709;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

export type KeyAttestation = {
  securityLevel: number;
  keymasterSecurityLevel: number;
  challenge: string;
  deviceLocked: boolean | null;
  verifiedBootState: number | null;
  packageNames: string[];
  signingDigests: string[];
};

function derBoolean(buf: Uint8Array, tlv: Tlv): boolean {
  const bytes = bodyOf(buf, tlv);
  if (tlv.cls !== 0 || tlv.tag !== 1 || bytes.length !== 1 || (bytes[0] !== 0x00 && bytes[0] !== 0xff)) throw new Error("der: not a boolean");
  return bytes[0] === 0xff;
}

/** Every KeyDescription extension a certificate carries (a genuine attestation leaf has exactly one; a CA none). */
function keyDescriptionExtensions(certDer: Uint8Array): Tlv[][] {
  const cert = readTlv(certDer, 0);
  const tbs = childrenOf(certDer, cert)[0];
  const extensionsWrapper = childrenOf(certDer, tbs).find((child) => child.cls === 2 && child.tag === 3);
  if (!extensionsWrapper) return [];
  return childrenOf(certDer, childrenOf(certDer, extensionsWrapper)[0])
    .map((extension) => childrenOf(certDer, extension))
    .filter((parts) => sameBytes(bodyOf(certDer, parts[0]), KEY_DESCRIPTION_OID));
}

/** How many KeyDescription extensions a certificate carries. */
export function keyDescriptionCount(certDer: Uint8Array): number {
  return keyDescriptionExtensions(certDer).length;
}

/** Android's KeyDescription extension of an attestation leaf, read field by field; null when the leaf has none. */
export function readKeyAttestation(certDer: Uint8Array): KeyAttestation | null {
  const found = keyDescriptionExtensions(certDer);
  if (found.length > 1) throw new Error("attestation: two KeyDescriptions");
  for (const parts of found) {
    const value = parts[parts.length - 1];
    const description = readTlv(certDer, value.body, value.end);
    const fields = childrenOf(certDer, description);
    if (fields.length < 8) throw new Error("attestation: short KeyDescription");
    const out: KeyAttestation = {
      securityLevel: smallInt(certDer, fields[1]),
      keymasterSecurityLevel: smallInt(certDer, fields[3]),
      challenge: Buffer.from(bodyOf(certDer, fields[4])).toString("utf8"),
      deviceLocked: null,
      verifiedBootState: null,
      packageNames: [],
      signingDigests: [],
    };
    for (const list of [fields[6], fields[7]]) {
      for (const entry of childrenOf(certDer, list)) {
        if (entry.cls !== 2) continue;
        if (entry.tag === TAG_ROOT_OF_TRUST && list === fields[7]) {
          const root = childrenOf(certDer, childrenOf(certDer, entry)[0]);
          out.deviceLocked = derBoolean(certDer, root[1]);
          out.verifiedBootState = smallInt(certDer, root[2]);
        }
        if (entry.tag === TAG_APPLICATION_ID) {
          const octets = childrenOf(certDer, entry)[0];
          const appId = readTlv(certDer, octets.body, octets.end);
          const [packages, digests] = childrenOf(certDer, appId);
          for (const info of childrenOf(certDer, packages)) {
            out.packageNames.push(Buffer.from(bodyOf(certDer, childrenOf(certDer, info)[0])).toString("utf8"));
          }
          for (const digest of childrenOf(certDer, digests)) out.signingDigests.push(Buffer.from(bodyOf(certDer, digest)).toString("hex"));
        }
      }
    }
    return out;
  }
  return null;
}

function spkiOf(cert: X509Certificate): Buffer {
  return cert.publicKey.export({ type: "spki", format: "der" });
}

function serialHex(cert: X509Certificate): string {
  return BigInt(`0x${cert.serialNumber}`).toString(16);
}

/** Judge a sealed file. `rootsPem` are the trusted anchors (Google's in production, a test root in the tests). */
export function verifySealedPhoto(
  bytes: Uint8Array,
  options: {
    rootsPem: readonly string[];
    identity: SealIdentity;
    nowMs?: number;
    /**
     * "camera_sync" (the rep's own camera sending its queue) never refuses on what the payload says — only on a
     * seal that is not ours or was changed; the rest is returned for the Super Admin's camera page (owner, 20 Nov
     * 2026: "Phoenix will not reject anything"). The Super Admin's own upload keeps refusing on every problem.
     */
    purpose?: "admin_upload" | "camera_sync";
  },
): SealVerdict {
  const refuse = (problem: string): SealVerdict => ({ ok: false, problem });
  const parts = splitSealedFile(bytes);
  if (!parts) return refuse("The file's seal is damaged or cut off. Ask the rep to send it again as a Document, not as a photo.");

  let seal: { v?: unknown; payload?: unknown; sig?: unknown; chain?: unknown };
  try {
    seal = JSON.parse(parts.sealText) as typeof seal;
  } catch {
    return refuse("The file's seal cannot be read.");
  }
  if (seal.v !== 1 || typeof seal.payload !== "string" || typeof seal.sig !== "string" || !Array.isArray(seal.chain)) {
    return refuse("The file's seal cannot be read.");
  }
  if (seal.chain.length < 2 || seal.chain.length > 6 || !seal.chain.every((entry) => typeof entry === "string")) {
    return refuse("The seal does not carry the phone's certificate chain.");
  }

  const payload = parseSealPayload(seal.payload);
  if (typeof payload === "string") return refuse(payload);
  const imageSha256 = createHash("sha256").update(parts.image).digest("hex");
  if (imageSha256 !== payload.imageSha256) return refuse("The picture was changed after it was sealed.");

  let certs: X509Certificate[];
  let ders: Buffer[];
  try {
    ders = (seal.chain as string[]).map((entry) => Buffer.from(entry, "base64"));
    certs = ders.map((der) => new X509Certificate(der));
  } catch {
    return refuse("The seal's certificate chain cannot be read.");
  }

  let signed = false;
  try {
    signed = createVerify("SHA256").update(seal.payload, "utf8").verify(certs[0].publicKey, Buffer.from(seal.sig, "base64"));
  } catch {
    signed = false;
  }
  if (!signed) return refuse("The seal's signature does not match its contents — something was changed.");

  for (let index = 0; index < certs.length - 1; index += 1) {
    if (!certs[index].verify(certs[index + 1].publicKey) || !certs[index].checkIssued(certs[index + 1])) {
      return refuse("The seal's certificate chain is broken.");
    }
  }
  try {
    if (ders.slice(1).some((der) => keyDescriptionCount(der) > 0)) {
      return refuse("The seal's key was vouched for by another app's key, not by the phone's secure chip.");
    }
  } catch {
    return refuse("The seal's certificate chain cannot be read.");
  }
  const root = certs[certs.length - 1];
  const trusted = options.rootsPem.map((pem) => spkiOf(new X509Certificate(pem)));
  if (!trusted.some((key) => key.equals(spkiOf(root))) || !root.verify(root.publicKey)) {
    return refuse("The seal was not made inside a genuine phone's secure chip.");
  }

  let attestation: KeyAttestation | null;
  try {
    attestation = readKeyAttestation(ders[0]);
  } catch {
    attestation = null;
  }
  if (!attestation) return refuse("The phone did not vouch for the seal's key.");
  if (attestation.securityLevel < 1 || attestation.keymasterSecurityLevel < 1) return refuse("The seal's key was not kept in the phone's secure chip.");
  if (attestation.challenge !== options.identity.challenge) return refuse("The seal's key was not made by the Phoenix Camera.");
  if (attestation.deviceLocked !== true || attestation.verifiedBootState !== 0) {
    return refuse("The phone's system was unlocked or modified (rooted), so its location cannot be trusted.");
  }
  if (!attestation.packageNames.includes(options.identity.packageName)) return refuse("The seal was not made by the Phoenix Camera.");
  if (!attestation.signingDigests.includes(options.identity.signingDigest.toLowerCase())) {
    return refuse("The seal was made by a modified copy of the Phoenix Camera.");
  }

  const nowMs = options.nowMs ?? Date.now();
  const cameraSync = options.purpose === "camera_sync";
  if (!cameraSync) {
    const problems = sealPayloadProblems(payload, nowMs);
    if (problems.length > 0) return refuse(problems[0]);
  }

  return {
    ok: true,
    payload,
    sealId: createHash("sha256").update(seal.payload, "utf8").digest("hex"),
    deviceKey: createHash("sha256").update(spkiOf(certs[0])).digest("hex"),
    securityLevel: attestation.securityLevel >= 2 ? "StrongBox" : "TEE",
    serials: certs.map(serialHex),
    warnings: sealPayloadWarnings(payload),
    integrity: cameraSync ? sealIntegrityProblems(payload, nowMs) : [],
    location: cameraSync ? sealLocationProblems(payload) : [],
  };
}

/**
 * What a seal SAYS, before anything about it is believed — for the Super Admin's camera page when the seal itself
 * does not hold (a changed picture, a modified app), so he still sees who, which customer and when it claims.
 * Never used to decide anything.
 */
export function readUnverifiedSealPayload(bytes: Uint8Array): SealPayload | null {
  const parts = splitSealedFile(bytes);
  if (!parts) return null;
  try {
    const seal = JSON.parse(parts.sealText) as { payload?: unknown };
    if (typeof seal.payload !== "string") return null;
    const payload = parseSealPayload(seal.payload);
    return typeof payload === "string" ? null : payload;
  } catch {
    return null;
  }
}
