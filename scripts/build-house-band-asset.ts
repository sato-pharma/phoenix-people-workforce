/**
 * Renders the house engine-turned band to `public/brand/sato-house-band.png`.
 *
 * WHY AN ASSET EXISTS AT ALL. On paper the band is a `data:` SVG tiled as a CSS background
 * (`houseBandBackground()`), and email throws away both halves of that: Gmail and Outlook drop
 * `data:` images, and Word-rendered Outlook ignores `background-image` outright. So the one medium
 * that cannot use the runtime band is the one the whole company reads every week. An `<img>` served
 * from the public site is the only form of the ornament email can actually show.
 *
 * WHY A SCRIPT AND NOT A HAND-DRAWN PNG. The geometry is imported from `house-identity.ts` rather
 * than re-typed, so the email band cannot drift from the printed one: change the wavelength, height
 * or stroke there and re-run this, and the two stay the same ornament. A committed PNG with no
 * generator beside it is an asset nobody can reproduce once its author has gone.
 *
 * Run from the repo root (never `pnpm exec` from a worktree — AGENTS.md §5):
 *   node --experimental-strip-types --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/build-house-band-asset.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import {
  HOUSE_BAND_HEIGHT_MM,
  HOUSE_BAND_STROKE_MM,
  HOUSE_BAND_WAVELENGTH_MM,
  HOUSE_COLORS,
} from "@/lib/hiring-pack/house-identity";

/** The email content column. The strip is drawn to span it exactly. */
const EMAIL_WIDTH_PX = 640;
/** Whole wavelengths across that column — whole, so the strip begins and ends mid-period-free. */
const REPEATS = 20;
/** Drawn at 2x so it stays crisp on the phone screens most of this mail is opened on. */
const SCALE = 2;

const OUTPUT = path.join(process.cwd(), "public", "brand", "sato-house-band.png");

function bandSvg(): string {
  const w = HOUSE_BAND_WAVELENGTH_MM;
  const h = HOUSE_BAND_HEIGHT_MM;
  const mid = h / 2;
  // The same quadratic approximation to a sine hump the CSS band uses, so the two curves match.
  const amp = (mid - HOUSE_BAND_STROKE_MM) * (4 / 3);
  const n = (v: number) => Number(v.toFixed(3));

  const totalWidth = w * REPEATS;
  const passes: string[] = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const x = i * w;
    passes.push(
      `<path d="M${n(x)} ${mid}Q${n(x + w / 4)} ${n(mid - amp)} ${n(x + w / 2)} ${mid}T${n(x + w)} ${mid}"/>`,
      `<path d="M${n(x)} ${mid}Q${n(x + w / 4)} ${n(mid + amp)} ${n(x + w / 2)} ${mid}T${n(x + w)} ${mid}"/>`,
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${EMAIL_WIDTH_PX * SCALE}" ` +
    `height="${Math.round((EMAIL_WIDTH_PX * SCALE * h) / totalWidth)}" viewBox="0 0 ${totalWidth} ${h}">` +
    `<g fill="none" stroke="${HOUSE_COLORS.deep}" stroke-width="${HOUSE_BAND_STROKE_MM}">` +
    passes.join("") +
    "</g></svg>"
  );
}

async function main(): Promise<void> {
  const svg = bandSvg();
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  // A white ground rather than transparency: an email client in dark mode composites a transparent
  // PNG onto its own dark paper, and the deep-blue curve disappears into it.
  const png = await sharp(Buffer.from(svg))
    .flatten({ background: "#ffffff" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(OUTPUT, png);

  const meta = await sharp(png).metadata();
  console.log(`wrote ${path.relative(process.cwd(), OUTPUT)} — ${meta.width}x${meta.height}, ${png.length} bytes`);
}

await main();
