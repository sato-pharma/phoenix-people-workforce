import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";

// ─────────────────────────────────────────────────────────────────────────────
// THE OFFICIAL PHOENIX LOGO IS THE RINGED EMBLEM — the phoenix inside a ring, over rising bars.
//
// The owner, 2026-09-11, sending that mark: "This is the original contract logo of Phoenix. So fix
// here and deep audit everywhere in the system and fix with the correct logo." The same night two
// document attempts had carried other Phoenix drawings that sat in `public/brand/` beside the real
// one — a bird with no ring, and a brand-sheet lockup reading PEOPLE • PERFORMANCE • INTELLIGENCE —
// and the browser tab, the phone home-screen icon, the desktop notification and the Excel exports'
// corner mark were all still wearing a glowing bird that is not the logo at all.
//
// WHY A PICTURE TEST, NOT A FILE-NAME TEST. Every wrong mark had a plausible name
// (`phoenix-main-logo.png`, `phoenix-required-brand.png`), and the Excel mark was a base64 string no
// name search can see. So each surface is compared with the official emblem by a 64-bit difference
// hash. Measured when this was written: every correct surface sat 0–5 bits from the reference, and
// every wrong drawing it replaced sat 17–30 bits away.
//
// WHAT IT PINS
//   1. the reference emblem itself, by its own hash — so swapping the reference cannot make every
//      other check agree with a wrong mark;
//   2. a negative control — the Sato mark must read as DIFFERENT, or the comparator is blind and
//      every pass below is vacuous;
//   3. the browser and app icons, the marks the app shell draws, the email signatures, the camera
//      watermark, the notification icon and the Excel exports' embedded mark;
//   4. that the retired drawings are gone from `public/` and no code path points at them.
//
// A red here is a wrong logo reaching users. Fix the ASSET, never the hash: the reference hash moves
// only when the owner changes the logo.
// ─────────────────────────────────────────────────────────────────────────────

const OFFICIAL_EMBLEM = "public/brand/identity-strip-emblem.png";

/** Difference hash of the official emblem flattened on white and on black, measured 2026-09-11. */
const OFFICIAL_HASH = { onBlack: "55cc69692f5b0f0e", onWhite: "b20e96c4e8d0c879" } as const;

/** Slack for a resampler or libvips upgrade re-rounding the reference itself. */
const REFERENCE_DRIFT_BITS = 4;

/** At most this many bits apart is the same mark. Correct surfaces measured 0–5, wrong ones 17–30. */
const SAME_MARK_BITS = 10;

const WHITE = "#ffffff";
const BLACK = "#000000";

/** Drawings that are NOT the logo, removed 2026-09-11. None may come back, and nothing may point at one. */
const RETIRED = [
  "brand/phoenix-favicon-transparent.png",
  "brand/phoenix-icon-transparent.png",
  "brand/phoenix-logo-reference.png",
  "brand/phoenix-main-logo.png",
  "brand/phoenix-primary-icon.png",
  "brand/phoenix-primary-logo.png",
  "brand/phoenix-required-brand.png",
  "brand/sfe-logo.png",
  "assets/branding/phoenix-mindset-banner.png",
] as const;

async function differenceHash(input: string | Buffer, background: string): Promise<string> {
  const flat = await sharp(input).flatten({ background }).png().toBuffer();
  let framed = flat;
  try {
    // Trim the uniform border, so the padding a mark has inside its own canvas does not decide it.
    framed = await sharp(flat).trim({ threshold: 24 }).png().toBuffer();
  } catch {
    framed = flat;
  }
  const grey = await sharp(framed).resize(9, 8, { fit: "fill" }).grayscale().raw().toBuffer();
  let hex = "";
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (grey[y * 9 + x] > grey[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function hammingBits(a: string, b: string): number {
  let bits = 0;
  for (let i = 0; i < a.length; i += 2) {
    let v = Number.parseInt(a.slice(i, i + 2), 16) ^ Number.parseInt(b.slice(i, i + 2), 16);
    while (v) {
      bits += v & 1;
      v >>= 1;
    }
  }
  return bits;
}

function icoEntries(file: string): { png: Buffer; size: number }[] {
  const buf = readFileSync(file);
  const entries: { png: Buffer; size: number }[] = [];
  for (let i = 0; i < buf.readUInt16LE(4); i++) {
    const at = 6 + i * 16;
    const offset = buf.readUInt32LE(at + 12);
    entries.push({ png: buf.subarray(offset, offset + buf.readUInt32LE(at + 8)), size: buf[at] || 256 });
  }
  return entries;
}

function textFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      files.push(...textFilesUnder(full));
    } else if (/\.(ts|tsx|js|mjs|cjs|jsx|json|html|css|sql|toml)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

export async function runPhoenixOfficialLogoTests() {
  const referenceOnWhite = await differenceHash(OFFICIAL_EMBLEM, WHITE);
  const referenceOnBlack = await differenceHash(OFFICIAL_EMBLEM, BLACK);
  assert.ok(
    hammingBits(referenceOnWhite, OFFICIAL_HASH.onWhite) <= REFERENCE_DRIFT_BITS
      && hammingBits(referenceOnBlack, OFFICIAL_HASH.onBlack) <= REFERENCE_DRIFT_BITS,
    `${OFFICIAL_EMBLEM} is no longer the emblem the owner named — every check below compares against it, so a swapped reference would pass a wrong logo everywhere`,
  );

  const satoBits = hammingBits(await differenceHash("public/brand/sato-pharma-logo-on-light.png", WHITE), referenceOnWhite);
  assert.ok(
    satoBits > SAME_MARK_BITS + 4,
    `the comparator reads the Sato mark as the Phoenix emblem (${satoBits} bits apart) — it can no longer tell two marks apart, so every pass below would be vacuous`,
  );

  const sameMark = async (label: string, input: string | Buffer, background: string) => {
    const reference = background === BLACK ? referenceOnBlack : referenceOnWhite;
    const bits = hammingBits(await differenceHash(input, background), reference);
    assert.ok(
      bits <= SAME_MARK_BITS,
      `${label} is not the ringed Phoenix emblem (${bits} bits from it, where the same mark is at most ${SAME_MARK_BITS}) — the owner's original logo is the phoenix inside a ring over rising bars`,
    );
  };

  // The browser tab, the installed app and the iPhone home screen.
  await sameMark("app/icon.png, the browser-tab and installed-app icon", "app/icon.png", WHITE);
  await sameMark("app/apple-icon.png, the iPhone home-screen icon", "app/apple-icon.png", WHITE);
  const favicon = icoEntries("app/favicon.ico");
  assert.deepEqual(
    favicon.map((entry) => entry.size).sort((a, b) => a - b),
    [16, 32, 48, 64],
    "favicon.ico carries exactly the 16/32/48/64 sizes app/layout.tsx declares for it",
  );
  for (const entry of favicon) {
    // Sixteen pixels cannot hold the ring and the bars apart, so below 32 the hash measures noise
    // (the correct 16 px entry reads 14 bits). That entry is held to its size above, not its picture.
    if (entry.size >= 32) await sameMark(`app/favicon.ico at ${entry.size}px`, entry.png, WHITE);
  }

  // The marks the app shell draws — read from the brand config, so a repointed key is checked too.
  const settings = readFileSync("src/config/system-settings.ts", "utf8");
  const configured = new Map(
    [...settings.matchAll(/\b(iconLogo|loginEmblem|adminRailMark|adminSidebarLockup):\s*"([^"]+)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""] as const),
  );
  for (const key of ["iconLogo", "loginEmblem", "adminRailMark", "adminSidebarLockup"]) {
    const src = configured.get(key);
    assert.ok(src, `system-settings.ts no longer names ${key}, so this test can no longer see the mark the app shell draws`);
    assert.ok(existsSync(`public${src}`), `${key} points at ${src}, which is not in public/ — the app shell would draw a broken image`);
  }
  await sameMark("the brand config's iconLogo", `public${configured.get("iconLogo")}`, WHITE);
  await sameMark("the brand config's loginEmblem", `public${configured.get("loginEmblem")}`, WHITE);
  await sameMark("the brand config's adminRailMark", `public${configured.get("adminRailMark")}`, BLACK);
  // The lockup sets the wordmark beside the emblem, so the emblem is the lockup's left square.
  const lockup = `public${configured.get("adminSidebarLockup")}`;
  const lockupHeight = (await sharp(lockup).metadata()).height ?? 0;
  const lockupEmblem = await sharp(lockup).extract({ height: lockupHeight, left: 0, top: 0, width: lockupHeight }).png().toBuffer();
  await sameMark("the emblem in the brand config's adminSidebarLockup", lockupEmblem, BLACK);

  // Everywhere the mark leaves the app.
  await sameMark("the desktop notification icon", "public/brand/phoenix-notification-icon.png", WHITE);
  assert.match(
    readFileSync("src/lib/nav-badge-store.ts", "utf8"),
    /icon:\s*"\/brand\/phoenix-notification-icon\.png"/,
    "the Action Center desktop notification draws the notification icon — the favicon is 64px at most and blurs at notification size",
  );
  await sameMark("the HR email signature", "public/assets/branding/phoenix-hr-email-signature.png", WHITE);
  await sameMark("the small HR email signature", "public/assets/branding/phoenix-hr-signature-small.png", WHITE);
  await sameMark("the camera evidence watermark", "public/brand/phoenix-camera-watermark.png", WHITE);

  const assets = readFileSync("src/lib/export/phoenix-pdf-assets.ts", "utf8");
  const quote = assets.indexOf('"');
  const exportMark = Buffer.from(assets.slice(quote + 1, assets.indexOf('"', quote + 1)), "base64");
  await sameMark("the Excel exports' corner mark (PHOENIX_RAIL_MARK_PNG_BASE64)", exportMark, BLACK);

  // The retired drawings stay retired.
  for (const retired of RETIRED) {
    assert.ok(!existsSync(`public/${retired}`), `public/${retired} is back — it is not the Phoenix logo, and it was removed so no session reaches for it again`);
  }
  // ── The Sato Arabic mark carries no dots BELOW the line ─────────────────────────────────
  // The owner, 2026-09-12: "you will find 2 point under س and another 2 under ا remove them". Four
  // diamonds sat under the baseline of the calligraphy and came off by hand — 5,461 pixels, two
  // connected components, nothing else touched.
  //
  // 🔴 THIS IS A PIXEL TEST BECAUSE THE FILE IS DERIVED. The mark was built from a source image
  // by a recipe (trim, resize to 1100, luminance to alpha, flatten to the house blue, 4-colour
  // palette), and re-running that recipe puts every one of these dots straight back. Nothing about
  // the file name, its size or its hash would say so. The two boxes below are where they were.
  const MARK = "public/brand/sato-pharma-arabic-on-light.png";
  // One box per dot, 25px square on the dot's own centre. MEASURED: each was 625 of 625 cells solid
  // ink before the edit and 0 after. A box round the whole PAIR cannot be used — a real stroke clips
  // the corner of the left pair's bounding box, so that test could never read zero.
  const DOTS = [
    { name: "the right dot under the right group", cx: 984, cy: 786 },
    { name: "the left dot under the right group", cx: 937, cy: 786 },
    { name: "the right dot under the alif", cx: 430, cy: 767 },
    { name: "the left dot under the alif", cx: 384, cy: 771 },
  ];
  {
    const { data, info } = await sharp(MARK).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 1100, "the boxes below are measured in this artwork's own pixels, so its size is part of the check");
    assert.equal(info.height, 813, "the same — a resized mark would move the boxes off the dots and pass while still wearing them");
    const inkAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3] > 8;
    let total = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (inkAt(x, y)) total++;
    assert.ok(total > 150_000, `the mark has almost no ink in it (${total} px) — an empty file would pass every box below`);
    for (const dot of DOTS) {
      let found = 0;
      for (let y = dot.cy - 12; y <= dot.cy + 12; y++) for (let x = dot.cx - 12; x <= dot.cx + 12; x++) if (inkAt(x, y)) found++;
      assert.equal(
        found, 0,
        `${dot.name} is back on the Arabic mark (${found} px of ink where it stood) — the owner had it removed, `
          + "and rebuilding the file from its source image restores it silently",
      );
    }
  }

  const pointers: string[] = [];
  for (const file of ["src", "app", "public", "lib", "scripts", "supabase"].flatMap(textFilesUnder)) {
    const text = readFileSync(file, "utf8");
    for (const retired of RETIRED) if (text.includes(retired)) pointers.push(`${file} -> ${retired}`);
  }
  assert.deepEqual(pointers, [], "a code path points at a retired Phoenix drawing, which would render a broken image or a wrong logo");
}
