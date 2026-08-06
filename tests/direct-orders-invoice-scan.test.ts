import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import sharp from "sharp";

import { MAX_PREPARED_EDGE_PX, prepareInvoicePhoto } from "../src/lib/direct-orders/invoice-scan.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The scanner step: making a counter-top photograph legible before it is read.
//
// Executed against real images rather than matched against source text. Everything here is a
// property of what comes OUT of sharp — tonal spread, orientation, size — so a change that
// silently weakens the pipeline fails on the pixels, not on a regex.
// ─────────────────────────────────────────────────────────────────────────────

/** A dim, low-contrast page: faint bands of "text" on grey paper, the way a pharmacy counter looks. */
async function dimInvoice(width = 900, height = 500): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const x = i % width;
    const y = Math.floor(i / width);
    const isText = y % 40 < 6 && x % 13 < 9;
    const value = isText ? 118 : 138; // 20 levels apart, out of 255
    raw[i * 3] = value;
    raw[i * 3 + 1] = value;
    raw[i * 3 + 2] = value;
  }
  return sharp(raw, { raw: { channels: 3, height, width } }).jpeg({ quality: 90 }).toBuffer();
}

const spread = async (bytes: Buffer) => {
  const stats = await sharp(bytes).stats();
  return stats.channels[0].max - stats.channels[0].min;
};

export async function runDirectOrdersInvoiceScanTests() {
  // ── The measured win: a dim page becomes a legible one ──────────────────────
  // This is the entire justification for spending CPU on every read. If the tonal spread does not
  // move, the step is pure cost and should be deleted rather than defended.
  {
    const dim = await dimInvoice();
    const before = await spread(dim);
    const result = await prepareInvoicePhoto({ bytes: dim, mimeType: "image/jpeg" });
    const after = await spread(result.bytes);

    assert.ok(result.prepared, "a normal JPEG invoice must actually be prepared, not passed through");
    assert.ok(
      after > before * 3,
      `THE SCANNER STEP MUST ACTUALLY LIFT CONTRAST: a counter-top photo occupies a narrow band of ` +
        `greys and 8pt Arabic inside it is unreadable. Spread went ${before} → ${after}; anything ` +
        "under 3x means this is spending CPU on every read and returning the same picture",
    );
  }

  // ── It can never refuse the photograph ─────────────────────────────────────
  // The rule every improvement step in this module follows: a thing that exists to make a read
  // BETTER must never be the reason there is no read. Fed bytes sharp cannot parse, it hands back
  // exactly what it was given so the reader still gets its chance.
  {
    const notAnImage = Buffer.from("this is not an image, it is a sentence", "utf8");
    // Caught deliberately. Letting the throw propagate turns the whole test file red with no
    // AssertionError at all — the suite fails, but for an unnamed reason, which reads exactly like
    // a crash and tells the next reader nothing. Converting it into THIS assertion is what makes
    // the rule provable rather than merely violated.
    let result: Awaited<ReturnType<typeof prepareInvoicePhoto>>;
    try {
      result = await prepareInvoicePhoto({ bytes: notAnImage, mimeType: "image/jpeg" });
    } catch (error) {
      assert.fail(
        "A FAILED PREPARE MUST RETURN THE ORIGINAL BYTES, NOT THROW: an enhancement that can stop a " +
          `readable invoice from being read is worse than no enhancement. It threw: ${String(error)}`,
      );
    }
    assert.equal(
      result.prepared,
      false,
      "an unparseable image must report prepared:false rather than claiming work it could not do",
    );
    assert.deepEqual(
      result.bytes,
      notAnImage,
      "A FAILED PREPARE MUST RETURN THE ORIGINAL BYTES: an enhancement that can stop a readable invoice from being read is worse than no enhancement",
    );
    const empty = await prepareInvoicePhoto({ bytes: Buffer.alloc(0), mimeType: "image/jpeg" });
    assert.equal(empty.prepared, false, "an empty upload must pass straight through rather than throw");
  }

  // ── EXIF orientation is applied ────────────────────────────────────────────
  // Phones record rotation in metadata instead of rotating pixels, so a portrait photo can arrive
  // on its side. Sideways 8pt Arabic is not harder to read — it is a different problem.
  {
    const upright = await sharp({
      create: { background: { b: 255, g: 255, r: 255 }, channels: 3, height: 200, width: 600 },
    })
      .jpeg()
      .withMetadata({ orientation: 6 }) // 6 = rotate 90° clockwise on display
      .toBuffer();

    const result = await prepareInvoicePhoto({ bytes: upright, mimeType: "image/jpeg" });
    const meta = await sharp(result.bytes).metadata();
    assert.ok(
      (meta.height ?? 0) > (meta.width ?? 0),
      `EXIF ORIENTATION MUST BE APPLIED: a 600x200 image tagged "rotate 90°" must come out taller ` +
        `than it is wide (${meta.width}x${meta.height}). A sideways invoice is unreadable no matter ` +
        "how good the contrast is",
    );
  }

  // ── It never enlarges, and never binarises ─────────────────────────────────
  {
    const small = await sharp({
      create: { background: { b: 200, g: 200, r: 200 }, channels: 3, height: 120, width: 300 },
    })
      .jpeg()
      .toBuffer();
    const result = await prepareInvoicePhoto({ bytes: small, mimeType: "image/jpeg" });
    const meta = await sharp(result.bytes).metadata();
    assert.ok(
      (meta.width ?? 0) <= 300 && (meta.height ?? 0) <= 120,
      `a small photo must NOT be enlarged (${meta.width}x${meta.height} from 300x120): upscaling ` +
        "invents pixels and makes a blurred digit look confident rather than blurred",
    );

    const source = readFileSync(new URL("../src/lib/direct-orders/invoice-scan.ts", import.meta.url), "utf8");
    assert.ok(
      !/\.threshold\(/.test(source),
      "NO BINARISATION: threshold() turns every pixel pure black or white, which eats the thin strokes " +
        "and diacritics that distinguish Arabic letters — the invoices this reads are mostly Arabic",
    );
    assert.match(
      source,
      /withoutEnlargement: true/,
      "the resize must carry withoutEnlargement, or a small photo is upscaled into false confidence",
    );
  }

  // ── The cap keeps small print readable ─────────────────────────────────────
  // 2000px on the long edge is ~170 dpi for A4 — enough that a 6 stays a 6. The read itself asks
  // for `detail: "high"` for the same reason, and shrinking here would undo it.
  {
    assert.ok(
      MAX_PREPARED_EDGE_PX >= 1600,
      `the long-edge cap must stay high enough for 8pt print (currently ${MAX_PREPARED_EDGE_PX}): ` +
        "below roughly 1600px an invoice digit stops being distinguishable from its neighbour, which " +
        "is the exact failure `detail: \"high\"` exists to avoid",
    );
    const big = await sharp({
      create: { background: { b: 255, g: 255, r: 255 }, channels: 3, height: 1000, width: 4000 },
    })
      .jpeg()
      .toBuffer();
    const result = await prepareInvoicePhoto({ bytes: big, mimeType: "image/jpeg" });
    const meta = await sharp(result.bytes).metadata();
    assert.ok(
      (meta.width ?? 0) <= MAX_PREPARED_EDGE_PX,
      `an oversized photo must be capped to ${MAX_PREPARED_EDGE_PX}px on the long edge, got ${meta.width}px — ` +
        "every byte here crosses the Atlantic on each read",
    );
  }

  // ── The extractor actually uses the prepared image ─────────────────────────
  // Preparing it and then sending the original is the silent-no-op this whole module keeps
  // producing: the counters would say prepared:true while the reader saw the untouched photo.
  {
    const extractor = readFileSync(
      new URL("../src/lib/direct-orders/invoice-extraction.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      extractor,
      /image_url: `data:\$\{readableMimeType\};base64,\$\{readableBase64\}`/,
      "THE READER MUST BE SENT THE PREPARED IMAGE: preparing it and then sending the original is a " +
        "silent no-op that reports prepared:true while nothing improved",
    );
    assert.match(
      extractor,
      /prepared: scan\.prepared/,
      "whether preparation ran must be recorded, or the CPU it costs on every read cannot be judged",
    );
  }
}
