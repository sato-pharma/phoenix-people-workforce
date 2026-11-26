/**
 * What build an APK on the tablet server actually is — read out of the file itself.
 *
 * 🔴 WHY THIS EXISTS. The launcher on a rep tablet decides whether to download an app by comparing
 * what is installed against the `versionCode` on the Headwind VERSION ROW, never against the file. So
 * a row whose numbers do not match the file it points at is not cosmetic: the tablet downloads the
 * file, installs a build whose code is not the one the row wants, and downloads it again on the next
 * check-in — for ever, at the file's full size. `phoenix-entrypoint.sh` re-fetches a floating app
 * whenever its publisher serves different bytes (26 Nov 2026), so the file under a row now moves on
 * its own and the row has to be able to follow it from the code.
 *
 * 🔴 AND THE FILE IS NOT DOWNLOADED TO READ IT. Telegram is 81,653,599 bytes; this reads the zip's
 * central directory from the end, then `AndroidManifest.xml` alone, then parses Android's binary XML —
 * about 100 KB over four requests. The whole-file read was the reason this was a hand step with a
 * number typed in by a human (`docs/owner-operations-recipes.md`), and a typed number is exactly what
 * puts the fleet in the re-download loop.
 */

import { inflateRawSync } from "node:zlib";

export class ApkReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApkReadError";
  }
}

/** The three things a version row has to agree with. */
export type ApkBuild = {
  /** The file's size in bytes, as the server reports it — the entrypoint's own measure. */
  bytes: number;
  /** `org.telegram.messenger.web`. Null when the manifest carries no package name. */
  packageName: string | null;
  /** `13.3.1` — what a person reads. */
  version: string | null;
  /** `73469` — what the launcher compares. */
  versionCode: number | null;
};

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;

/**
 * One ranged read.
 *
 * 🔴 THIS SERVER HANDS BACK ONE BYTE FEWER THAN THE RANGE IT CONFIRMS. Measured on
 * `https://mdm.satopharma.com/files/Telegram.apk`, 26 Nov 2026: `Range: bytes=0-1023` answered
 * `206` with `Content-Range: bytes 0-1023/81653599` and a body of 1023 bytes. So every read asks for
 * one spare byte and trims; the file's very last byte cannot be had at all, which is why the
 * end-of-central-directory is searched for rather than assumed to sit flush against the end.
 */
async function readRange(url: string, from: number, to: number, total: number, fetchImpl: typeof fetch): Promise<Buffer> {
  const want = Math.min(to, total - 1);
  const ask = Math.min(want + 1, total - 1);
  const response = await fetchImpl(url, { headers: { Range: `bytes=${from}-${ask}` } });
  if (response.status !== 206) {
    throw new ApkReadError(
      `The tablet server would not hand over part of ${url} (it answered ${response.status} to a byte range), so the ` +
        "file's own version could not be read and no version row was changed.",
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  const wanted = want - from + 1;
  // The last byte of the file is the one byte this server keeps; everything the zip trailer needs
  // sits before it.
  if (body.length < wanted && !(want === total - 1 && body.length >= wanted - 1)) {
    throw new ApkReadError(
      `Reading ${url} came back short (${body.length} bytes where ${wanted} were asked for), so the file's own ` +
        "version could not be read and no version row was changed.",
    );
  }
  return body.subarray(0, Math.min(wanted, body.length));
}

/** Find `AndroidManifest.xml`'s local header offset in a zip's central directory. */
function manifestOffsetIn(centralDirectory: Buffer): number {
  let at = 0;
  while (at + 46 <= centralDirectory.length && centralDirectory.readUInt32LE(at) === CENTRAL_HEADER) {
    const nameLength = centralDirectory.readUInt16LE(at + 28);
    const extraLength = centralDirectory.readUInt16LE(at + 30);
    const commentLength = centralDirectory.readUInt16LE(at + 32);
    const name = centralDirectory.subarray(at + 46, at + 46 + nameLength).toString("latin1");
    if (name === "AndroidManifest.xml") return centralDirectory.readUInt32LE(at + 42);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return -1;
}

/**
 * Android's binary XML, far enough to read the `<manifest>` element's own attributes.
 *
 * 🔴 `attributeStart` COUNTS FROM THE ATTRIBUTE BLOCK, NOT FROM THE CHUNK. It is 16 bytes into the
 * node (past the chunk header, the line number and the comment), and reading it from the chunk start
 * instead returns a `<manifest>` with every attribute undefined — which reads exactly like an APK
 * that declares no version, so the caller would "find" no version to write.
 */
export function parseApkManifest(manifest: Uint8Array): { packageName: string | null; version: string | null; versionCode: number | null } {
  const axml = Buffer.from(manifest);
  const strings: string[] = [];
  let at = 8; // past the file header
  while (at + 8 <= axml.length) {
    const type = axml.readUInt16LE(at);
    const size = axml.readUInt32LE(at + 4);
    if (!size) break;
    if (type === 0x0001) {
      const count = axml.readUInt32LE(at + 8);
      const flags = axml.readUInt32LE(at + 16);
      const stringsStart = axml.readUInt32LE(at + 20);
      const utf8 = (flags & 0x100) !== 0;
      for (let index = 0; index < count; index += 1) {
        let cursor = at + stringsStart + axml.readUInt32LE(at + 28 + index * 4);
        if (utf8) {
          cursor += (axml[cursor]! & 0x80) !== 0 ? 2 : 1; // the character count, which we do not need
          const byteLength = (axml[cursor]! & 0x80) !== 0 ? ((axml[cursor]! & 0x7f) << 8) | axml[cursor + 1]! : axml[cursor]!;
          cursor += (axml[cursor]! & 0x80) !== 0 ? 2 : 1;
          strings.push(axml.subarray(cursor, cursor + byteLength).toString("utf8"));
        } else {
          let characters = axml.readUInt16LE(cursor);
          cursor += 2;
          if (characters & 0x8000) {
            characters = ((characters & 0x7fff) << 16) | axml.readUInt16LE(cursor);
            cursor += 2;
          }
          strings.push(axml.subarray(cursor, cursor + characters * 2).toString("utf16le"));
        }
      }
    }
    if (type === 0x0102 && strings[axml.readUInt32LE(at + 20)] === "manifest") {
      const attributeStart = axml.readUInt16LE(at + 24);
      const attributeSize = axml.readUInt16LE(at + 26);
      const attributeCount = axml.readUInt16LE(at + 28);
      const read = (name: string): { text: string | null; number: number | null } => {
        for (let index = 0; index < attributeCount; index += 1) {
          const attribute = at + 16 + attributeStart + index * attributeSize;
          if (strings[axml.readUInt32LE(attribute + 4)] !== name) continue;
          const raw = axml.readInt32LE(attribute + 8);
          const dataType = axml[attribute + 15];
          const data = axml.readUInt32LE(attribute + 16);
          if (dataType === 0x03) return { number: null, text: strings[data] ?? null };
          return { number: data, text: raw >= 0 ? (strings[raw] ?? null) : null };
        }
        return { number: null, text: null };
      };
      const code = read("versionCode");
      const name = read("versionName");
      return {
        packageName: read("package").text,
        version: name.text ?? (name.number === null ? null : String(name.number)),
        versionCode: code.number ?? (code.text === null ? null : Number(code.text)),
      };
    }
    at += size;
  }
  throw new ApkReadError("That file has an Android manifest with no <manifest> element in it, so its version could not be read.");
}

/**
 * The build of the APK served at `url` — four ranged reads, never the whole file.
 */
export async function readApkBuild(url: string, fetchImpl: typeof fetch = fetch): Promise<ApkBuild> {
  const head = await fetchImpl(url, { method: "HEAD" });
  if (!head.ok) {
    throw new ApkReadError(
      `The tablet server does not serve ${url} any more (it answered ${head.status}), so the file's own version could ` +
        "not be read and no version row was changed.",
    );
  }
  const total = Number(head.headers.get("content-length"));
  if (!Number.isInteger(total) || total <= 0) {
    throw new ApkReadError(
      `The tablet server did not say how big ${url} is, so its version could not be read and no version row was changed.`,
    );
  }

  const tail = await readRange(url, Math.max(0, total - 65557), total - 1, total, fetchImpl);
  let endAt = -1;
  for (let index = tail.length - 4; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === END_OF_CENTRAL) {
      endAt = index;
      break;
    }
  }
  if (endAt < 0) throw new ApkReadError(`${url} does not end like a zip file, so it was not read as an APK.`);

  let centralSize = tail.readUInt32LE(endAt + 12);
  let centralAt = tail.readUInt32LE(endAt + 16);
  if (centralAt === 0xffffffff || centralSize === 0xffffffff) {
    const locator = endAt - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) {
      throw new ApkReadError(`${url} is a zip64 file with no locator, so it was not read as an APK.`);
    }
    const zip64At = Number(tail.readBigUInt64LE(locator + 8));
    const zip64 = await readRange(url, zip64At, zip64At + 56, total, fetchImpl);
    centralSize = Number(zip64.readBigUInt64LE(40));
    centralAt = Number(zip64.readBigUInt64LE(48));
  }

  const central = await readRange(url, centralAt, centralAt + centralSize - 1, total, fetchImpl);
  const localAt = manifestOffsetIn(central);
  if (localAt < 0) throw new ApkReadError(`${url} carries no AndroidManifest.xml, so it is not an APK.`);

  const header = await readRange(url, localAt, localAt + 30 + 4096, total, fetchImpl);
  if (header.readUInt32LE(0) !== LOCAL_HEADER) {
    throw new ApkReadError(`${url}'s central directory points at something that is not a file header, so it was not read as an APK.`);
  }
  const method = header.readUInt16LE(8);
  const compressed = header.readUInt32LE(18);
  const dataAt = localAt + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = await readRange(url, dataAt, dataAt + compressed - 1, total, fetchImpl);
  const manifest = method === 0 ? raw : inflateRawSync(raw);

  return { bytes: total, ...parseApkManifest(manifest) };
}
