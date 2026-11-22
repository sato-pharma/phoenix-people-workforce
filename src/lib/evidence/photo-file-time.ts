/**
 * The photo's own time: when an UPLOADED arrival photo says it was taken.
 *
 * Owner, 23 Nov 2026 ("make both options because they sometimes have the ticket online or soft
 * copy … even if he uploaded, it will come with a timestamp exactly like the live camera"). An
 * upload stays allowed on a non-car trip (car-evidence.ts), but the wizard re-encodes the file
 * through a canvas, which drops everything the file said about itself. So before that happens the
 * wizard reads the camera's own clock out of the file here, burns it into the watermark beside the
 * upload time, and sends it as `fileTakenAt` so the approver reads both.
 *
 * Why: the October audit found Mohamed Ramadan's training arrival photo (OUTSTATION-260) uploaded
 * on the trip's LAST evening — the upload time alone cannot say whether the picture was taken on
 * the way in or days later. The file's own time can, when the file has one.
 *
 * Read: a JPEG's EXIF block (APP1 "Exif"), DateTimeOriginal (0x9003) from the Exif sub-IFD, else
 * DateTime (0x0132) from IFD0. The offset tag (OffsetTimeOriginal 0x9011 / OffsetTime 0x9010) is
 * honoured when present; without one the time is the phone's wall clock, read as Cairo time.
 *
 * A screenshot, a WhatsApp copy or a soft-copy ticket carries no EXIF time: that is `null`, and the
 * watermark says so in words — never a guess, never the upload time passed off as the photo's.
 * The device can lie (its clock can be set by hand); this is evidence for the approver, never a
 * refusal (the module rule: the system flags an expense, it never auto-rejects one).
 *
 * Pure and synchronous: the caller reads the file's bytes.
 */

const CAIRO_TIME_ZONE = "Africa/Cairo";

const TAG_DATE_TIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME = 0x9010;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;

const TYPE_ASCII = 2;
const TYPE_LONG = 4;

/** Older than any phone this company's employees carry, or a clock that was never set. */
const EARLIEST_YEAR = 2005;

type TiffReader = {
  ascii(entryOffset: number): string | null;
  entries(ifdOffset: number): number[];
  long(entryOffset: number): number | null;
  tag(entryOffset: number): number;
};

function tiffReader(view: DataView, start: number, end: number): TiffReader | null {
  if (end - start < 8) return null;
  const order = view.getUint16(start);
  const little = order === 0x4949 ? true : order === 0x4d4d ? false : null;
  if (little === null) return null;
  if (view.getUint16(start + 2, little) !== 0x002a) return null;

  const u16 = (offset: number) => view.getUint16(offset, little);
  const u32 = (offset: number) => view.getUint32(offset, little);
  const inside = (offset: number, length: number) => offset >= start && offset + length <= end;

  return {
    ascii(entryOffset) {
      if (u16(entryOffset + 2) !== TYPE_ASCII) return null;
      const count = u32(entryOffset + 4);
      if (count <= 0 || count > 64) return null;
      const at = count <= 4 ? entryOffset + 8 : start + u32(entryOffset + 8);
      if (!inside(at, count)) return null;
      let value = "";
      for (let index = 0; index < count; index += 1) {
        const code = view.getUint8(at + index);
        if (code === 0) break;
        value += String.fromCharCode(code);
      }
      return value.trim() || null;
    },
    entries(ifdOffset) {
      const at = start + ifdOffset;
      if (!inside(at, 2)) return [];
      const count = u16(at);
      const list: number[] = [];
      for (let index = 0; index < count && index < 512; index += 1) {
        const entry = at + 2 + index * 12;
        if (!inside(entry, 12)) break;
        list.push(entry);
      }
      return list;
    },
    long(entryOffset) {
      return u16(entryOffset + 2) === TYPE_LONG ? u32(entryOffset + 8) : null;
    },
    tag(entryOffset) {
      return u16(entryOffset);
    },
  };
}

/** The EXIF block's TIFF bounds inside a JPEG, or null when the file is not a JPEG or has none. */
function findExifTiff(view: DataView): { end: number; start: number } | null {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);
    // Start of scan or end of image: the metadata segments are all before it.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    const segmentEnd = Math.min(view.byteLength, offset + 2 + length);
    if (
      marker === 0xe1 &&
      offset + 10 <= view.byteLength &&
      view.getUint32(offset + 4) === 0x45786966 && // "Exif"
      view.getUint16(offset + 8) === 0x0000
    ) {
      return { end: segmentEnd, start: offset + 10 };
    }
    offset += 2 + length;
  }
  return null;
}

function cairoOffsetMinutes(utcMillis: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: CAIRO_TIME_ZONE,
    year: "numeric",
  }).formatToParts(new Date(utcMillis));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
  return Math.round((asIfUtc - utcMillis) / 60_000);
}

/**
 * "YYYY:MM:DD HH:MM:SS" plus an optional "+HH:MM" offset → ISO time in UTC, or null when the text
 * is not a real date (all zeros, a clock never set, an impossible day).
 */
export function exifDateTimeToIso(value: string | null | undefined, offset?: string | null): string | null {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value ?? "").trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (year < EARLIEST_YEAR || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wallClock);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;

  const offsetMatch = /^([+-])(\d{2}):?(\d{2})$/.exec(String(offset ?? "").trim());
  let offsetMinutes: number;
  if (offsetMatch) {
    offsetMinutes = (offsetMatch[1] === "-" ? -1 : 1) * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
  } else {
    // No offset in the file: the phone's wall clock, read in Cairo. Twice, so a time near a
    // daylight-saving change lands on the offset of the instant itself.
    offsetMinutes = cairoOffsetMinutes(wallClock - cairoOffsetMinutes(wallClock) * 60_000);
  }
  return new Date(wallClock - offsetMinutes * 60_000).toISOString();
}

/**
 * When the photo file says it was taken, as an ISO time in UTC — or null when the file carries no
 * time of its own (a screenshot, a forwarded copy, a soft-copy ticket, a PNG, a broken file).
 * Never throws.
 */
export function readPhotoFileTakenAt(bytes: ArrayBuffer | Uint8Array): string | null {
  try {
    const view =
      bytes instanceof Uint8Array ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new DataView(bytes);
    const bounds = findExifTiff(view);
    if (!bounds) return null;
    const tiff = tiffReader(view, bounds.start, bounds.end);
    if (!tiff) return null;

    const ifd0Offset = view.getUint32(bounds.start + 4, view.getUint16(bounds.start) === 0x4949);
    let dateTime: string | null = null;
    let offsetTime: string | null = null;
    let original: string | null = null;
    let originalOffset: string | null = null;
    let exifIfd: number | null = null;

    for (const entry of tiff.entries(ifd0Offset)) {
      const tag = tiff.tag(entry);
      if (tag === TAG_DATE_TIME) dateTime = tiff.ascii(entry);
      else if (tag === TAG_EXIF_IFD) exifIfd = tiff.long(entry);
    }
    if (exifIfd !== null) {
      for (const entry of tiff.entries(exifIfd)) {
        const tag = tiff.tag(entry);
        if (tag === TAG_DATE_TIME_ORIGINAL) original = tiff.ascii(entry);
        else if (tag === TAG_OFFSET_TIME_ORIGINAL) originalOffset = tiff.ascii(entry);
        else if (tag === TAG_OFFSET_TIME) offsetTime = tiff.ascii(entry);
      }
    }

    return exifDateTimeToIso(original, originalOffset ?? offsetTime) ?? exifDateTimeToIso(dateTime, offsetTime);
  } catch {
    return null;
  }
}

/** The watermark line an uploaded photo carries, so its own time is on the face of the image. */
export function photoFileTimeCaption(fileTakenAt: string | null, formatCairo: (iso: string) => string) {
  return fileTakenAt
    ? `Photo's own time: ${formatCairo(fileTakenAt)}`
    : "Photo's own time: not in the file (screenshot or copy)";
}
