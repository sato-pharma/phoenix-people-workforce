// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE NATIONAL ID PAGES THAT FOLLOW THE BANK ACCOUNT LETTER (owner, 2026-11-27): "in every one I
// mark … an A4 paper should be printed: its top showing the front of his ID, and at the end showing
// the back of the ID. If I choose 10 people in the bank account letter, I will also have 10 more
// papers. Every paper has the front and the back of every one I choose."
//
// So the Word file is the letter, then ONE A4 PAGE PER CHOSEN PERSON, in the letter's order: the
// front of the card in the top half, the back in the bottom half. The pictures are the ones filed
// on Hiring Documents in the slot marked `joining_form_upload = 'national_id'` ("National ID copy") —
// the joining form files them there as `national-id-front` and `national-id-back`, and HR may upload
// them by hand. A person with no picture still gets the page, with an empty box where the copy goes,
// so the stack the desk prints always has one page per person and the gap is plain to see.
//
// Pure and client-safe: the screen reads `idCardStatus` and its labels, the store and the Word
// builder read the rest, and `tests/hiring-pack-bank-account-letter.test.ts` pins it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What a stored file in the national ID slot looks like, as far as this module cares. */
export type StoredIdFile = {
  fileName: string;
  contentType: string;
  /** ISO time; the earlier upload is the front when the names do not say. */
  uploadedAt: string;
};

/**
 * What the slot holds for one person:
 * - `photos`: a front and a back picture — the page prints both;
 * - `one-photo`: a single picture, printed as the front, the back box left empty;
 * - `scan`: only a PDF scan, which a Word page cannot carry — printed from Hiring Documents instead;
 * - `missing`: nothing on file.
 */
export type IdCardStatus = "photos" | "one-photo" | "scan" | "missing";

export const ID_CARD_STATUS_LABELS: Record<IdCardStatus, string> = {
  missing: "No ID card on file",
  "one-photo": "Only one side of the ID card on file",
  photos: "ID card front and back on file",
  scan: "ID card on file as a PDF scan only",
};

/** The picture types a Word page carries. Anything else is re-encoded on the server, or left out. */
const PICTURE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function isPicture(file: StoredIdFile): boolean {
  return PICTURE_TYPES.has(file.contentType.toLowerCase());
}

function sideNamed(file: StoredIdFile): "front" | "back" | null {
  const name = file.fileName.toLowerCase();
  if (/front|وجه/.test(name)) return "front";
  if (/back|ظهر/.test(name)) return "back";
  return null;
}

/**
 * Which file is the front and which the back. A name that says so wins (`national-id-front.jpg`,
 * "وجه"); otherwise the pictures go in upload order, the first the front. Only pictures are sides;
 * a PDF makes the person a `scan` when it is all there is.
 */
export function pickIdSides<T extends StoredIdFile>(files: readonly T[]): { front: T | null; back: T | null; status: IdCardStatus } {
  const pictures = files
    .filter(isPicture)
    .slice()
    .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
  let front = pictures.filter((file) => sideNamed(file) === "front").at(-1) ?? null;
  let back = pictures.filter((file) => sideNamed(file) === "back").at(-1) ?? null;
  const rest = pictures.filter((file) => file !== front && file !== back && sideNamed(file) === null);
  if (!front) front = rest.shift() ?? null;
  if (!back) back = rest.shift() ?? null;
  if (front && back) return { back, front, status: "photos" };
  if (front || back) return { back: null, front: front ?? back, status: "one-photo" };
  return { back: null, front: null, status: files.length > 0 ? "scan" : "missing" };
}

/** The status the screen shows beside a person, from the files the slot holds for them. */
export function idCardStatus(files: readonly StoredIdFile[]): IdCardStatus {
  return pickIdSides(files).status;
}

/** English Metric Units — Word's picture unit. 36,000 to the millimetre. */
export const EMU_PER_MM = 36_000;

/**
 * The box each side of the card is fitted into: 170 mm wide, 110 mm tall — two of them, the name
 * line and the two captions fill an A4 page inside 15 mm margins.
 */
export const ID_SIDE_BOX_MM = { height: 110, width: 170 } as const;

/** A picture's size on the page, in EMU: as large as fits the box, never stretched. */
export function fitIdPicture(widthPx: number, heightPx: number, box = ID_SIDE_BOX_MM): { cx: number; cy: number } {
  if (!(widthPx > 0) || !(heightPx > 0)) throw new Error("A picture needs a width and a height to be placed.");
  const scale = Math.min(box.width / widthPx, box.height / heightPx);
  return {
    cx: Math.round(widthPx * scale * EMU_PER_MM),
    cy: Math.round(heightPx * scale * EMU_PER_MM),
  };
}

/** One side's picture, ready for the page: JPEG or PNG bytes and their pixel size. */
export type IdPicture = {
  bytes: Uint8Array;
  contentType: "image/jpeg" | "image/png";
  widthPx: number;
  heightPx: number;
};

/** One person's ID page. */
export type BankLetterIdPage = {
  /** The name printed at the top: the Arabic name, else the screen name. */
  name: string;
  nationalId: string | null;
  front: IdPicture | null;
  back: IdPicture | null;
  status: IdCardStatus;
};

/**
 * The pixel size of a JPEG or PNG, read from its header — the fallback when the image library
 * cannot load, so a picture still lands at its own proportion. Null for anything else.
 */
export function pictureSize(bytes: Uint8Array): { widthPx: number; heightPx: number; contentType: "image/jpeg" | "image/png" } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { contentType: "image/png", heightPx: view.getUint32(20), widthPx: view.getUint32(16) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      // SOF0–SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const heightPx = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const widthPx = (bytes[offset + 7] << 8) | bytes[offset + 8];
        return widthPx > 0 && heightPx > 0 ? { contentType: "image/jpeg", heightPx, widthPx } : null;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
    }
  }
  return null;
}
