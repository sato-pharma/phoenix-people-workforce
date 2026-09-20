// Award cheque generator - the CEO's stored signature.
//
// The signature is a transparent PNG and it lives in a PRIVATE Storage bucket, never in the repository
// and never under public/: a signature image served statically is a forgery kit. It leaves this module
// only inside a rendered cheque, and the routes that reach it require `spotlight:export`, which is the
// Super Admin and the CEO.
//
// The bucket is created on first use rather than by a migration, so the feature ships in one deploy
// with nothing for the database to apply. A missing bucket or object answers "no signature", never an
// error - a cheque can always be drawn without one.

import { getSupabaseAdmin } from "@/lib/supabase/server";

export const CHEQUE_SIGNATURE_BUCKET = "spotlight-signatures";
const OBJECT_PATH = "ceo-signature.png";
export const CHEQUE_SIGNATURE_MAX_BYTES = 1_500_000;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class ChequeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChequeSignatureError";
  }
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > PNG_MAGIC.length && PNG_MAGIC.every((b, i) => bytes[i] === b);
}

/** The stored signature as a data URI for the sheet, or null when none is stored. */
export async function loadChequeSignatureUri(): Promise<string | null> {
  try {
    const { data, error } = await getSupabaseAdmin().storage.from(CHEQUE_SIGNATURE_BUCKET).download(OBJECT_PATH);
    if (error || !data) return null;
    const bytes = Buffer.from(await data.arrayBuffer());
    return isPng(bytes) ? `data:image/png;base64,${bytes.toString("base64")}` : null;
  } catch {
    return null;
  }
}

export async function saveChequeSignature(bytes: Uint8Array): Promise<void> {
  if (!isPng(bytes)) throw new ChequeSignatureError("The signature must be a PNG image.");
  if (bytes.length > CHEQUE_SIGNATURE_MAX_BYTES) {
    throw new ChequeSignatureError("The signature image is too large - keep it under 1.5 MB.");
  }
  const storage = getSupabaseAdmin().storage;
  const existing = await storage.getBucket(CHEQUE_SIGNATURE_BUCKET);
  if (existing.error || !existing.data) {
    const created = await storage.createBucket(CHEQUE_SIGNATURE_BUCKET, {
      public: false,
      allowedMimeTypes: ["image/png"],
      fileSizeLimit: CHEQUE_SIGNATURE_MAX_BYTES,
    });
    // A concurrent first save already made it - that is fine.
    if (created.error && !/already exists/i.test(created.error.message)) {
      throw new Error(`Unable to prepare the signature store: ${created.error.message}`);
    }
  }
  const { error } = await storage
    .from(CHEQUE_SIGNATURE_BUCKET)
    .upload(OBJECT_PATH, bytes, { contentType: "image/png", upsert: true, cacheControl: "0" });
  if (error) throw new Error(`Unable to store the signature: ${error.message}`);
}

export async function deleteChequeSignature(): Promise<void> {
  const { error } = await getSupabaseAdmin().storage.from(CHEQUE_SIGNATURE_BUCKET).remove([OBJECT_PATH]);
  if (error) throw new Error(`Unable to remove the signature: ${error.message}`);
}
