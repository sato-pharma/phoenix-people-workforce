// Downscale + recompress oversized static assets to sizes appropriate for how
// they actually render, then overwrite them in place. Covers the admin sidebar
// brand PNGs (rail mark shipped 1254×1254 for a 44px slot; lockup shipped
// 1870px wide for a ~280px header) and employee profile-photo JPGs that ship
// far larger than the ~320×360 avatar slot they render into
// (src/components/employee-portal/... PhoenixIdentityCard), both bloating the
// repo and the image optimizer.
//
// Run: npm run optimize:brand-assets
// Safe to re-run — it reads each file into a buffer first, so resizing never
// races the in-place write, and `withoutEnlargement` means a second run is a no-op.

import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

// Target sizes are ~2–3× the rendered size to stay crisp on high-DPI screens.
const targets = [
  { dir: "brand", file: "phoenix-rail-mark.png", resize: { width: 128, height: 128 } }, // renders 44×44
  { dir: "brand", file: "phoenix-sidebar-lockup.png", resize: { width: 640 } },         // renders ~280px wide
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
