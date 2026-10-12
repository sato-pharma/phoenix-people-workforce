// Crops every team photo to one 3:4 head-and-shoulders frame, 600x800, so all faces read at the
// same size: the head (top of hair or hijab to chin) fills HEAD of the frame height, with HEADROOM
// above it, and the face is centred. A photo too tight for that keeps its whole height instead.
// Usage: node crop-team.mjs <teamDir>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire("F:/Phoenix Workforce/phoenix-workforce/package.json");
const sharp = require("sharp");

const dir = process.argv[2];
const out = `${dir}/crop`;
mkdirSync(out, { recursive: true });
const HEAD = 0.55;
const HEADROOM = 0.09;

// [source, output, faceCentreX, headTop, chin, bounds?] as fractions of the source; bounds
// [x0, y0, x1, y1] keeps the frame inside the real picture when the file has bars or borders.
const photos = [
  ["anwar-fill.png", "anwar", 0.545, 0.06, 0.435],
  ["maraghy.jpg", "maraghy", 0.53, 0.105, 0.73],
  ["omar-studio.png", "omar", 0.5, 0.095, 0.61],
  ["hossam.jpg", "hossam", 0.5, 0.13, 0.7],
  ["sahar.jpg", "sahar", 0.54, 0.141, 0.415],
  ["khaled.jpeg", "khaled", 0.49, 0.095, 0.415],
  ["adel.jpg", "adel", 0.48, 0.158, 0.457],
  ["yasmeena.jpg", "yasmeena", 0.35, 0.051, 0.249],
  ["rasha.jpg", "rasha", 0.25, 0.069, 0.198],
  ["magdy.jpg", "magdy", 0.44, 0.054, 0.35],
  ["ali.jpg", "ali", 0.45, 0.04, 0.34],
  ["amr.jpeg", "amr", 0.475, 0.05, 0.53],
  ["sharaf.jpeg", "sharaf", 0.54, 0.11, 0.405],
  ["samaa.jpeg", "samaa", 0.49, 0.08, 0.52],
  ["ahmedamin.jpeg", "ahmedamin", 0.5, 0.11, 0.7],
  ["mahmoud.jpg", "mahmoud", 0.48, 0.044, 0.34],
  ["zain.jpeg", "zain", 0.55, 0.07, 0.36],
];

// Dr Anwar's file is a round cut-out on white. Fill the white outside the circle by carrying the
// blue backdrop at its rim outwards, so a rectangular frame has no white corners.
{
  const { data, info } = await sharp(`${dir}/anwar.jpg`).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: ch } = info;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 7;
  const outBuf = Buffer.from(data);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
    if (d <= R) continue;
    const sx = Math.round(cx + (dx / d) * (R - 4)), sy = Math.round(cy + (dy / d) * (R - 4));
    for (let c = 0; c < ch; c++) outBuf[(y * W + x) * ch + c] = data[(sy * W + sx) * ch + c];
  }
  await sharp(outBuf, { raw: { width: W, height: H, channels: ch } }).png().toFile(`${dir}/anwar-fill.png`);
}

for (const [src, name, fx, top, chin, b = [0, 0, 1, 1]] of photos) {
  const img = sharp(`${dir}/${src}`).rotate();
  const { info } = await sharp(`${dir}/${src}`).rotate().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const bx0 = b[0] * W, by0 = b[1] * H, bx1 = b[2] * W, by1 = b[3] * H;
  let h = ((chin - top) * H) / HEAD;
  let w = (h * 3) / 4;
  const fit = Math.min(1, (by1 - by0) / h, (bx1 - bx0) / w);
  h *= fit; w *= fit;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const left = Math.round(clamp(fx * W - w / 2, bx0, bx1 - w));
  const y0 = Math.round(clamp(top * H - HEADROOM * h, by0, by1 - h));
  const box = { left, top: y0, width: Math.round(w), height: Math.round(h) };
  const res = await img.extract(box).resize(600, 800, { fit: "fill" }).jpeg({ quality: 90, mozjpeg: true }).toFile(`${out}/${name}.jpg`);
  const head = (((chin - top) * H) / box.height) * 100;
  console.log(name.padEnd(10), `${W}x${H}`, JSON.stringify(box), `head ${head.toFixed(0)}%`, `${res.width}x${res.height}`);
}
