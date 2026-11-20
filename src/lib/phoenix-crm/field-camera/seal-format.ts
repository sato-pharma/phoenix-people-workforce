/**
 * The Phoenix Camera seal — its file shape and its identity, shared by the browser (to recognise a sealed file
 * before it is shrunk) and the server (to verify it). No Node import here: this module reaches the client bundle.
 *
 * Owner, 20 Nov 2026: a separate Android camera app that takes the validation photo with NO network — "بتصور
 * بتايم ستامب، لوكيشن، ووقت وتاريخ" — for the call with the System Administrator and for a clinic with no signal,
 * "with every precaution against fake locations and fraud, and keep its seal".
 *
 * A sealed file is an ordinary JPEG with the seal appended after its end marker:
 *
 *   <JPEG bytes, FFD8 … FFD9> <seal JSON, UTF-8> <seal length, 4 bytes big-endian> <"PHXSEAL1">
 *
 * Any viewer shows the picture and ignores the tail. The seal JSON is
 * `{ "v": 1, "payload": "<JSON text>", "sig": "<base64>", "chain": ["<base64 DER>", …] }`: the payload names the
 * SHA-256 of the JPEG bytes, `sig` is ECDSA-SHA256 over the payload text by a key that never leaves the phone's
 * secure chip, and `chain` is that key's Android attestation chain, leaf first, ending at a Google root.
 *
 * 🔴 The identity below is the release build's: a rebuilt or modified app signs with another certificate and its
 * attestation names another digest, so its seals are refused. Change it only with a new signing key, on purpose.
 */

export const SEAL_MAGIC = "PHXSEAL1";
export const SEAL_TRAILER_BYTES = SEAL_MAGIC.length + 4;
export const SEAL_MAX_JSON_BYTES = 64 * 1024;

/** The Android package name of the Phoenix Camera. */
export const FIELD_CAMERA_PACKAGE = "com.satopharma.phoenixcamera";

/** SHA-256 of the Phoenix Camera's release signing certificate, as Android attestation reports it. */
export const FIELD_CAMERA_SIGNING_DIGEST = "4417e26fb1a41c4d374297f305f043edeee00e11c55a14bd5ae69fff1ff1f4f1";

/** The challenge the app writes into its key's attestation. */
export const SEAL_ATTESTATION_CHALLENGE = "PHOENIX-CAMERA-SEAL-V1";

function magicAt(bytes: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + SEAL_MAGIC.length > bytes.length) return false;
  for (let index = 0; index < SEAL_MAGIC.length; index += 1) {
    if (bytes[offset + index] !== SEAL_MAGIC.charCodeAt(index)) return false;
  }
  return true;
}

/** Whether the file ends in a Phoenix Camera seal (it says nothing about whether the seal holds). */
export function hasSealTrailer(bytes: Uint8Array): boolean {
  return bytes.length > SEAL_TRAILER_BYTES && magicAt(bytes, bytes.length - SEAL_MAGIC.length);
}

/** The JPEG and the seal text of a sealed file, or null when the tail is not a well-formed seal. */
export function splitSealedFile(bytes: Uint8Array): { image: Uint8Array; sealText: string } | null {
  if (!hasSealTrailer(bytes)) return null;
  const lengthAt = bytes.length - SEAL_TRAILER_BYTES;
  const length = ((bytes[lengthAt] << 24) >>> 0) + (bytes[lengthAt + 1] << 16) + (bytes[lengthAt + 2] << 8) + bytes[lengthAt + 3];
  if (length <= 0 || length > SEAL_MAX_JSON_BYTES || length > lengthAt) return null;
  const image = bytes.subarray(0, lengthAt - length);
  if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9) {
    return null;
  }
  let sealText: string;
  try {
    sealText = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(lengthAt - length, lengthAt));
  } catch {
    return null;
  }
  return { image, sealText };
}
