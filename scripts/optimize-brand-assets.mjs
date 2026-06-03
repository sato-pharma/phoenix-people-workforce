// Downscale + recompress the admin sidebar brand PNGs to sizes appropriate for
// how they actually render, then overwrite them in place. The source art shipped
// far larger than its display size (rail mark 1254×1254 for a 44px slot; lockup
// 1870px wide for a ~280px header), bloating the repo and the image optimizer.
//
// Run: npm run optimize:brand-assets
// Safe to re-run — it reads each file into a buffer first, so resizing never
// races the in-place write, and `withoutEnlargement` means a second run is a no-op.

import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandDir = path.join(root, "public", "brand");

// Target sizes are ~2–3× the rendered size to stay crisp on high-DPI screens.
const targets = [
  { file: "phoenix-rail-mark.png", resize: { width: 128, height: 128 } }, // renders 44×44
  { file: "phoenix-sidebar-lockup.png", resize: { width: 640 } },         // renders ~280px wide
];

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

let totalBefore = 0;
let totalAfter = 0;

for (const target of targets) {
  const filePath = path.join(brandDir, target.file);
  const before = (await stat(filePath)).size;
  const input = await readFile(filePath);
  const output = await sharp(input)
    .resize({ ...target.resize, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 })
    .toBuffer();
  await writeFile(filePath, output);
  const meta = await sharp(output).metadata();
  totalBefore += before;
  totalAfter += output.length;
  console.log(`${target.file}: ${kb(before)} -> ${kb(output.length)} (${meta.width}×${meta.height})`);
}

console.log(`TOTAL: ${kb(totalBefore)} -> ${kb(totalAfter)} (saved ${kb(totalBefore - totalAfter)})`);
