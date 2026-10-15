// Downscale + recompress oversized static assets to sizes appropriate for how
// they actually render, then overwrite them in place. Covers the admin sidebar
// brand PNGs (rail mark shipped 1254×1254 for a 44px slot; lockup shipped
// 1870px wide for a ~280px header), the PhoenixSignatureCard corner watermark
// (shipped 1536×1024 for a decorative accent that never renders past ~460px
// tall), and employee profile-photo JPGs that ship far larger than the
// ~320×360 avatar slot they render into
// (src/components/employee-portal/... PhoenixIdentityCard), both bloating the
// repo and the image optimizer.
//
// Run: pnpm run optimize:brand-assets
// Safe to re-run — it reads each file into a buffer first, so resizing never
// races the in-place write, and `withoutEnlargement` means a second run is a no-op.

import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import sharp from "sharp";

import { refuseArguments } from "./lib/refuse-arguments.mjs";

// This script takes no arguments, so it says so instead of ignoring one (scripts/lib/refuse-arguments.mjs).
refuseArguments({
  name: "optimize-brand-assets",
  usage: `optimize-brand-assets: downscale and recompress the oversized static assets, IN PLACE.

  node scripts/optimize-brand-assets.mjs      rewrite the assets, then commit the diff
  node scripts/optimize-brand-assets.mjs -h   this text

It takes no arguments and it has NO dry run — it overwrites the files it names in public/ and src/.`,
  hints: [
    "it overwrites the assets in place: run it on a branch with a clean tree and read the diff",
    "the file list and target sizes are constants in this file — edit them, do not pass them",
  ],
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

// Target sizes are ~2–3× the rendered size to stay crisp on high-DPI screens.
const targets = [
  { dir: "brand", file: "phoenix-rail-mark.png", resize: { width: 128, height: 128 } }, // renders 44×44
  { dir: "brand", file: "phoenix-sidebar-lockup.png", resize: { width: 640 } },         // renders ~280px wide
  // PhoenixSignatureCard watermark — height-driven (width: auto in CSS). Renders
  // 153px tall on the fixed 150px mobile banner, and scales with the desktop
  // card's container width up to ~460px tall in the widest real case (sidebar
  // collapsed, ≥1580px viewport).
  { dir: "brand", file: "identity-watermark.png", resize: { height: 900 } },
  // PhoenixIdentityStrip watermark — the full emblem, a SEPARATE copy from the one above so the
  // design-locked portal banner cannot be changed by an admin-strip edit. Height-driven too: 205%
  // of the 136px desktop bar is ~279px, so at 512 the source is ~1.8x — under the 2–3x band this
  // list normally targets, and deliberately so: it draws at 11.5% opacity under `multiply`, where
  // resampling softness is invisible and a larger file would be paid for on every admin page. The
  // entry is a no-op (`withoutEnlargement`) that stops a later pass from shrinking it further.
  { dir: "brand", file: "identity-strip-emblem.png", resize: { height: 512 } },
  // Employee profile photos — render at ~320×360 in PhoenixIdentityCard.
  { dir: "images/hr", file: "B-100.jpg", resize: { width: 720 } },
  { dir: "images/hr", file: "B-85.jpg", resize: { width: 720 } },
  { dir: "images/hr", file: "B-94.jpg", resize: { width: 720 } },
  { dir: "images/hr", file: "B-95.jpg", resize: { width: 720 } },
  { dir: "images/hr", file: "B-96.jpg", resize: { width: 720 } },
  { dir: "images/hr", file: "taha-mohamed.jpg", resize: { width: 720 } },
];

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function encode(image, file) {
  if (file.endsWith(".png")) {
    return image.png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 });
  }
  return image.jpeg({ quality: 80, mozjpeg: true });
}

let totalBefore = 0;
let totalAfter = 0;

for (const target of targets) {
  const filePath = path.join(publicDir, target.dir, target.file);
  const before = (await stat(filePath)).size;
  const input = await readFile(filePath);
  const output = await encode(
    sharp(input).resize({ ...target.resize, fit: "inside", withoutEnlargement: true }),
    target.file,
  ).toBuffer();
  await writeFile(filePath, output);
  const meta = await sharp(output).metadata();
  totalBefore += before;
  totalAfter += output.length;
  console.log(`${target.dir}/${target.file}: ${kb(before)} -> ${kb(output.length)} (${meta.width}×${meta.height})`);
}

console.log(`TOTAL: ${kb(totalBefore)} -> ${kb(totalAfter)} (saved ${kb(totalBefore - totalAfter)})`);
