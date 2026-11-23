// Recruitment — a picture the person brings to the Publish press instead of the drawn one.
//
// The careers card normally carries the picture renderJobPostPng draws. A hand-made post (a PNG or JPEG
// the person made elsewhere) can stand in for it, from the same press and only from it. It must be the
// same 4:5 portrait the drawn post is, at least as wide as the drawn post's 1080 box, so the careers page
// frames it the same way. Every refusal is a sentence for the person who pressed.

import { OWN_PICTURE_MAX_BYTES } from "@/lib/recruitment/job-posts/own-picture-limits";

export { OWN_PICTURE_MAX_BYTES };

/** The drawn post's box: 1080 x 1350, 4:5. A brought picture must keep that shape. */
const MIN_WIDTH = 1080;
const RATIO = 4 / 5;
const RATIO_TOLERANCE = 0.01;

export type OwnPicture = { bytes: Uint8Array; contentType: "image/jpeg" | "image/png"; extension: "jpg" | "png"; height: number; width: number };

export class OwnPictureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnPictureError";
  }
}

function pngSize(bytes: Uint8Array): { height: number; width: number } | null {
  // Signature, then the IHDR chunk: length (4), "IHDR" (4), width (4), height (4).
  if (bytes.length < 24 || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { height: view.getUint32(20), width: view.getUint32(16) };
}

function jpegSize(bytes: Uint8Array): { height: number; width: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = view.getUint16(at + 2);
    // Start-of-frame markers (C0–CF, except C4 DHT, C8 JPG, CC DAC) hold the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/**
 * Reads a `data:image/png;base64,…` or `data:image/jpeg;base64,…` string into a picture the press can
 * send, or throws an OwnPictureError in words. The TYPE comes from the file's own bytes, never its name
 * or the data URL's label.
 */
export function ownPictureFromDataUrl(value: string): OwnPicture {
  const match = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim());
  if (!match) throw new OwnPictureError("The picture could not be read. Choose a PNG or JPEG file.");
  const bytes = new Uint8Array(Buffer.from(match[1]!.replace(/\s+/g, ""), "base64"));
  if (bytes.length > OWN_PICTURE_MAX_BYTES) throw new OwnPictureError("The picture is larger than 8 MB. Save it smaller and choose it again.");

  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) throw new OwnPictureError("The picture must be a PNG or JPEG file.");

  const size = isPng ? pngSize(bytes) : jpegSize(bytes);
  if (!size || !size.width || !size.height) throw new OwnPictureError("The picture could not be read. Choose a PNG or JPEG file.");
  if (Math.abs(size.width / size.height - RATIO) > RATIO_TOLERANCE) {
    throw new OwnPictureError(`The picture must be a 4:5 portrait, like the drawn post (1080 × 1350). This one is ${size.width} × ${size.height}.`);
  }
  if (size.width < MIN_WIDTH) {
    throw new OwnPictureError(`The picture must be at least 1080 × 1350. This one is ${size.width} × ${size.height}.`);
  }
  return isPng
    ? { bytes, contentType: "image/png", extension: "png", height: size.height, width: size.width }
    : { bytes, contentType: "image/jpeg", extension: "jpg", height: size.height, width: size.width };
}
