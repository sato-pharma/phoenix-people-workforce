import assert from "node:assert/strict";

import sharp from "sharp";

import {
  EMPLOYEE_PORTRAIT_MAX_WIDTH,
  EMPLOYEE_PORTRAIT_RATIO,
  normalizeEmployeePhoto,
  portraitWindow,
} from "@/lib/employees/photo-normalize";

// Every profile photo is made a portrait before it is stored (owner, 2026-11-01: a new joiner's
// identity card showed her face in the lower half of the frame under a solid black block — the
// phone's letterbox bar baked into the file she uploaded). These tests build the shapes people
// actually send and read the PIXELS that come back, never the source.

const SKIN = "#d9a883";
const NAVY = "#1f2d4e";

/** A person: a skin ellipse (the face) over a dark rectangle (the shoulders). */
function person(width: number, faceCx: number, faceCy: number, faceR: number, shouldersTop: number, bottom: number) {
  return `<ellipse cx="${faceCx}" cy="${faceCy}" rx="${faceR}" ry="${Math.round(faceR * 1.3)}" fill="${SKIN}"/>
          <rect x="${Math.round(width * 0.12)}" y="${shouldersTop}" width="${Math.round(width * 0.76)}" height="${bottom - shouldersTop}" fill="${NAVY}"/>`;
}

function svg(width: number, height: number, body: string) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`);
}

/**
 * Mean greyscale value of a horizontal slice of the picture, 0 (black) to 255 (white). Read from
 * raw pixels — sharp's `stats()` is computed on the INPUT and ignores an `extract`, so it would
 * answer the whole picture's mean whatever slice was asked for (that is how this helper first
 * read 184 for a slice that was pure white).
 */
async function sliceMean(bytes: Buffer, fromShare: number, toShare: number): Promise<number> {
  const meta = await sharp(bytes).metadata();
  const h = meta.height ?? 0;
  const top = Math.floor(h * fromShare);
  const height = Math.max(1, Math.floor(h * toShare) - top);
  const { data } = await sharp(bytes)
    .extract({ left: 0, top, width: meta.width ?? 1, height })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (const v of data) sum += v;
  return sum / data.length;
}

function ratioOf(width: number, height: number) {
  return width / height;
}

export async function runEmployeePhotoNormalizeTests() {
  // ── 1. The phone screenshot: black bars above and below a passport photo ──────────────────────
  // This is the file the owner saw. 400 × 900, the photo itself in the middle 540 rows on white.
  {
    const bytes = await sharp(
      svg(
        400,
        900,
        `<rect width="400" height="900" fill="#000"/>
         <rect y="180" width="400" height="540" fill="#fff"/>
         ${person(400, 200, 330, 70, 440, 720)}`,
      ),
    )
      .jpeg({ quality: 90 })
      .toBuffer();

    const out = await normalizeEmployeePhoto(bytes);
    assert.ok(out, "a letterboxed photo is normalised, not refused");
    assert.ok(out.bars.top >= 170 && out.bars.top <= 200, `the top bar is measured in source pixels (${out.bars.top}, expected ~180)`);
    assert.ok(out.bars.bottom >= 170 && out.bars.bottom <= 200, `and so is the bottom one (${out.bars.bottom})`);
    assert.equal(out.bars.left, 0, "no bar on the left");
    assert.equal(out.bars.right, 0, "no bar on the right");
    assert.ok(Math.abs(ratioOf(out.width, out.height) - EMPLOYEE_PORTRAIT_RATIO) < 0.01, `the stored picture IS the frame's ratio (${out.width}×${out.height})`);
    const meta = await sharp(out.bytes).metadata();
    assert.equal(meta.format, "jpeg", "stored as JPEG");
    assert.equal(meta.width, out.width);
    assert.equal(meta.height, out.height);
    const topRows = await sliceMean(out.bytes, 0, 0.04);
    assert.ok(topRows > 120, `THE BLACK BAR IS GONE: the top of the stored picture reads ${topRows.toFixed(0)}/255, it was 0`);
    const bottomRows = await sliceMean(out.bytes, 0.96, 1);
    assert.ok(bottomRows > 20, `and the bottom bar too (${bottomRows.toFixed(0)}/255)`);
  }

  // ── 2. A studio portrait on a white backdrop: NOT a bar, the air above the head stays ──────────
  // A backdrop is flat too, but it ends where the HEAD begins — a narrow change — not across the
  // whole width. Stripping it would put the hair on the frame's top edge.
  {
    const bytes = await sharp(svg(600, 800, `<rect width="600" height="800" fill="#fff"/>${person(600, 300, 300, 90, 460, 800)}`))
      .jpeg({ quality: 90 })
      .toBuffer();
    const out = await normalizeEmployeePhoto(bytes);
    assert.ok(out);
    assert.deepEqual(out.bars, { top: 0, bottom: 0, left: 0, right: 0 }, "a white backdrop is not a letterbox bar");
    assert.equal(out.width, 600, "never enlarged: the full width is kept");
    assert.equal(out.height, Math.round(600 / EMPLOYEE_PORTRAIT_RATIO));
    const topRows = await sliceMean(out.bytes, 0, 0.03);
    assert.ok(topRows > 200, `the breathing room above the head is kept (${topRows.toFixed(0)}/255)`);
  }

  // ── 3. The phone saved it sideways: EXIF orientation is honoured before anything else ─────────
  {
    const bytes = await sharp(svg(300, 500, `<rect width="300" height="500" fill="#8899aa"/>${person(300, 150, 160, 50, 240, 500)}`))
      .jpeg()
      .withMetadata({ orientation: 6 }) // rotate 90° clockwise on display → 500 wide, 300 high
      .toBuffer();
    const out = await normalizeEmployeePhoto(bytes);
    assert.ok(out);
    assert.deepEqual(out.source, { width: 500, height: 300 }, "the picture is turned upright first");
    assert.equal(out.height, 300, "a landscape source is limited by its height");
    assert.equal(out.width, Math.floor(300 * EMPLOYEE_PORTRAIT_RATIO));
  }

  // ── 4. A transparent PNG is flattened onto WHITE — a transparent surround turns black in a JPEG ─
  {
    const bytes = await sharp(svg(400, 600, `<circle cx="200" cy="300" r="60" fill="#888"/>`)).png().toBuffer();
    const out = await normalizeEmployeePhoto(bytes);
    assert.ok(out);
    const topRows = await sliceMean(out.bytes, 0, 0.1);
    assert.ok(topRows > 240, `transparency becomes white, never black (${topRows.toFixed(0)}/255)`);
  }

  // ── 5. Big pictures come down to the stored width; nothing is ever enlarged ───────────────────
  {
    const bytes = await sharp(svg(2400, 3200, `<rect width="2400" height="3200" fill="#eee"/>${person(2400, 1200, 1100, 360, 1700, 3200)}`))
      .jpeg({ quality: 80 })
      .toBuffer();
    const out = await normalizeEmployeePhoto(bytes);
    assert.ok(out);
    assert.equal(out.width, EMPLOYEE_PORTRAIT_MAX_WIDTH, "capped at the stored width");
    assert.equal(out.height, Math.round(EMPLOYEE_PORTRAIT_MAX_WIDTH / EMPLOYEE_PORTRAIT_RATIO));
  }

  // ── 6. What cannot be cut is handed back as null, and the caller stores the original ──────────
  {
    assert.equal(await normalizeEmployeePhoto(Buffer.from("not a picture at all")), null, "garbage is null, never a throw");
    const tiny = await sharp(svg(20, 20, `<rect width="20" height="20" fill="#000"/>`)).png().toBuffer();
    assert.equal(await normalizeEmployeePhoto(tiny), null, "a thumbnail is too small to crop");
  }

  // ── 7. The window arithmetic ──────────────────────────────────────────────────────────────────
  {
    assert.deepEqual(portraitWindow(900, 2000), { width: 900, height: Math.floor(900 / EMPLOYEE_PORTRAIT_RATIO) }, "a tall picture is limited by its width");
    assert.deepEqual(portraitWindow(2000, 900), { width: Math.floor(900 * EMPLOYEE_PORTRAIT_RATIO), height: 900 }, "a wide one by its height");
    assert.deepEqual(portraitWindow(785, 1000), { width: 785, height: 1000 }, "the frame's own ratio is untouched");
  }
}
