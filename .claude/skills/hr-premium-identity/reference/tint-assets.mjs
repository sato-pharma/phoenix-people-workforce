// Recolours single-ink artwork for the navy closing page: keeps each file's alpha (its ink) and
// fills it with one flat colour. Usage: node tint-assets.mjs <assetsDir>
import { createRequire } from "node:module";
const require = createRequire("F:/Phoenix Workforce/phoenix-workforce/package.json");
const sharp = require("sharp");

const dir = process.argv[2];
const jobs = [
  ["sato-pharma-arabic-on-light.png", "sato-pharma-arabic-gold.png", [0xd8, 0xb8, 0x72]],
  ["omar-signature.png", "omar-signature-gold.png", [0xe3, 0xc9, 0x8a]],
];
for (const [src, out, [r, g, b]] of jobs) {
  const { data, info } = await sharp(`${dir}/${src}`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    // ink strength: the alpha, weakened where the source pixel is light (anti-aliased paper)
    const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    const a = Math.round(data[i + 3] * Math.min(1, (1 - lum) * 1.6 + 0.15));
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  }
  await sharp(px, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(`${dir}/${out}`);
  console.log(out, `${info.width}x${info.height}`);
}
