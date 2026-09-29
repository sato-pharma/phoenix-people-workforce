// The stored signature an HR paper can be signed with.
//
// A TRANSPARENT PNG IN A PRIVATE BUCKET, never in the repository and never under `public/`. The
// reasoning is `spotlight/cheque-signature.ts`'s, word for word and for the same reason: a signature
// image served statically is a forgery kit. It leaves this module only inside a rendered document,
// as a data URI, and the routes that reach it are the Super Admin's alone.
//
// ONE SIGNATURE, DELIBERATELY. The owner asked for "my signature" — he is the sole Super Admin and
// the HR Section Head, so the paper that needs signing here needs HIS. A library of named
// signatures is the obvious next thing and is NOT built on a guess: a second signature is a second
// person's, and whose signature may be printed on whose paper is a decision, not a data model.
//
// THE BUCKET IS CREATED ON FIRST USE rather than by a migration, so this ships in one deploy with
// nothing for the database to apply. A missing bucket or object answers "no signature", never an
// error — a paper must always be printable, and an unsigned one is the correct fallback.

import { getSupabaseAdmin } from "@/lib/supabase/server";

export const HR_SIGNATURE_BUCKET = "hr-form-signatures";
const OBJECT_PATH = "hr-signature.png";
export const HR_SIGNATURE_MAX_BYTES = 1_500_000;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class HrSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HrSignatureError";
  }
}

/**
 * A PNG, by its own first eight bytes.
 *
 * Checked rather than trusting the upload's declared type, and checked again on the way OUT: the
 * bytes in the bucket are what gets embedded in a document, and a file that is not an image would
 * embed as a `data:image/png` URI that renders as nothing — an unsigned paper that the screen
 * showed as signed.
 */
export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > PNG_MAGIC.length && PNG_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** The stored signature as a data URI for a document, or null when none is stored. */
export async function loadHrSignatureUri(): Promise<string | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .storage.from(HR_SIGNATURE_BUCKET)
      .download(OBJECT_PATH);
    if (error || !data) return null;
    const bytes = Buffer.from(await data.arrayBuffer());
    return isPng(bytes) ? `data:image/png;base64,${bytes.toString("base64")}` : null;
  } catch {
    return null;
  }
}

export async function saveHrSignature(bytes: Uint8Array): Promise<void> {
  if (!isPng(bytes)) {
    throw new HrSignatureError("The signature must be a PNG image — ideally one with a transparent background.");
  }
  if (bytes.length > HR_SIGNATURE_MAX_BYTES) {
    throw new HrSignatureError("The signature image is too large — keep it under 1.5 MB.");
  }
  const storage = getSupabaseAdmin().storage;
  const existing = await storage.getBucket(HR_SIGNATURE_BUCKET);
  if (existing.error || !existing.data) {
    const created = await storage.createBucket(HR_SIGNATURE_BUCKET, {
      public: false,
      allowedMimeTypes: ["image/png"],
      fileSizeLimit: HR_SIGNATURE_MAX_BYTES,
    });
    // A concurrent first save already made it — that is fine.
    if (created.error && !/already exists/i.test(created.error.message)) {
      throw new Error(`Unable to prepare the signature store: ${created.error.message}`);
    }
  }
  const { error } = await storage
    .from(HR_SIGNATURE_BUCKET)
    .upload(OBJECT_PATH, bytes, { contentType: "image/png", upsert: true, cacheControl: "0" });
  if (error) throw new Error(`Unable to store the signature: ${error.message}`);
}

export async function deleteHrSignature(): Promise<void> {
  const { error } = await getSupabaseAdmin().storage.from(HR_SIGNATURE_BUCKET).remove([OBJECT_PATH]);
  if (error) throw new Error(`Unable to remove the signature: ${error.message}`);
}
