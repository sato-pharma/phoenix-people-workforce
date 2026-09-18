import type {
  SkCanvas,
  SkData,
  SkParagraph,
  SkTypefaceFontProvider,
  Skia as SkiaValue,
} from "@shopify/react-native-skia";
import { FilterMode, FontWeight, ImageFormat, MipmapMode, TileMode } from "@shopify/react-native-skia";

import {
  EVIDENCE_JPEG_QUALITY,
  getCompressedEvidenceSize,
  planEvidenceWatermark,
  type EvidenceFontWeight,
  type EvidenceStampDetails,
  type EvidenceTextMeasure,
} from "./evidence-stamp";

/**
 * Burning the evidence stamp into a photo, with Skia.
 *
 * This file only EXECUTES the stamp. What it says and where every piece goes comes from
 * `planEvidenceWatermark` in `evidence-stamp.ts`, which is pinned to the web's own drawing code by
 * `tests/mobile-evidence-stamp-parity.test.ts` — so nothing here may invent a number. The web draws
 * with the browser canvas; this draws the same plan with Skia, translating the three canvas
 * behaviours that have no direct Skia equivalent:
 *
 *   - `fillText(text, x, y)` puts the alphabetic BASELINE at y. A Skia paragraph paints from its
 *     top, so each run is painted at `y - baseline`, the baseline read from the paragraph itself.
 *   - canvas `shadowBlur` is not a Skia blur radius: the HTML spec defines the shadow as a Gaussian
 *     whose standard deviation is HALF of `shadowBlur`, and Skia takes that standard deviation.
 *   - text is drawn as a PARAGRAPH, not with a font and a glyph run, because the address line comes
 *     back from Google in Arabic as often as in English. A paragraph shapes Arabic, joins it, orders
 *     it right to left inside the line and falls back to a font that has the glyphs; a glyph run in
 *     one typeface prints a row of empty boxes.
 *
 * WHY THE PHOTO IS DECODED HERE AND NOT BY AN IMAGE LIBRARY. Skia's decoder applies the JPEG's EXIF
 * orientation itself, so a photo the camera saved sideways with a "rotate 90°" tag comes out
 * upright — measured before this was written, and the reason no image-manipulation package was
 * added. Scaling happens in the same draw, with mipmapped linear sampling, so a 12-megapixel frame
 * shrinks to 1280 without the shimmer a plain bilinear downscale leaves.
 *
 * The Skia API object is PASSED IN rather than imported, and so is the font source. On the phone
 * that is the native `Skia` with the system fonts; the local render check runs this same file on
 * Skia's own WebAssembly build with fonts it registers itself, so the JPEG that check produces is
 * drawn by this code, not by a copy of it.
 */

type SkiaApi = typeof SkiaValue;

export type BurnFonts = {
  /** Family names to try, in order. On Android "sans-serif" is the system UI face, as on the web. */
  families?: string[];
  /** Fonts to draw with instead of the system's. Only the off-device render check passes this. */
  provider?: SkTypefaceFontProvider;
};

export type BurnedEvidencePhoto = {
  /** The stamped JPEG, base64, no line breaks — ready to follow `data:image/jpeg;base64,`. */
  base64: string;
  byteLength: number;
  height: number;
  width: number;
};

/** Raised when the photo cannot be turned into a stamped JPEG at all. The message is for the person. */
export class EvidenceBurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceBurnError";
  }
}

/** Wide enough that no stamp line ever wraps inside Skia — the wrapping is decided by the plan. */
const UNBOUNDED_WIDTH = 100_000;

function skiaWeight(weight: EvidenceFontWeight): FontWeight {
  return weight === 800 ? FontWeight.ExtraBold : FontWeight.Bold;
}

function makeParagraph(
  Skia: SkiaApi,
  fonts: Required<Pick<BurnFonts, "families">> & Pick<BurnFonts, "provider">,
  run: {
    color: string;
    shadow: { blur: number; color: string } | null;
    sizePx: number;
    text: string;
    weight: EvidenceFontWeight;
  },
): SkParagraph {
  const builder = Skia.ParagraphBuilder.Make({}, fonts.provider);
  builder.pushStyle({
    color: Skia.Color(run.color),
    fontFamilies: fonts.families,
    fontSize: run.sizePx,
    fontStyle: { weight: skiaWeight(run.weight) },
    shadows: run.shadow
      ? [{ blurRadius: run.shadow.blur / 2, color: Skia.Color(run.shadow.color), offset: Skia.Point(0, 0) }]
      : [],
  });
  builder.addText(run.text);
  const paragraph = builder.build();
  paragraph.layout(UNBOUNDED_WIDTH);
  builder.dispose();
  return paragraph;
}

/**
 * The measuring half of the plan's contract: the width Skia will actually draw `text` at.
 *
 * Cached, because the wrapper measures a growing prefix of every caption once per word and repeats
 * that for each font size it tries; the same string at the same size is measured once.
 */
function makeMeasure(Skia: SkiaApi, fonts: Required<Pick<BurnFonts, "families">> & Pick<BurnFonts, "provider">): EvidenceTextMeasure {
  const cache = new Map<string, number>();
  return (text, sizePx, weight) => {
    const key = `${sizePx}|${weight}|${text}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const paragraph = makeParagraph(Skia, fonts, { color: "#fff", shadow: null, sizePx, text, weight });
    const width = paragraph.getLongestLine();
    paragraph.dispose();
    cache.set(key, width);
    return width;
  };
}

function drawRun(
  Skia: SkiaApi,
  canvas: SkCanvas,
  fonts: Required<Pick<BurnFonts, "families">> & Pick<BurnFonts, "provider">,
  run: Parameters<typeof makeParagraph>[2] & { x: number; y: number },
) {
  const paragraph = makeParagraph(Skia, fonts, run);
  // `baseline` is the distance from the paragraph's top to its first line's baseline — the offset
  // that turns canvas's baseline-anchored `fillText` into Skia's top-anchored paint.
  const baseline = paragraph.getLineMetrics()[0]?.baseline ?? run.sizePx;
  paragraph.paint(canvas, run.x, run.y - baseline);
  paragraph.dispose();
}

/**
 * Stamp one photo and encode it as the JPEG the server accepts.
 *
 * `photo` is the camera's file as bytes; `logo` is the Phoenix watermark mark, or null when it could
 * not be loaded — in which case the stamp is drawn without it, exactly as the web does when its
 * logo request fails.
 */
export function burnEvidencePhoto(
  Skia: SkiaApi,
  input: { details: EvidenceStampDetails; logo: SkData | null; photo: SkData },
  fontOptions: BurnFonts = {},
): BurnedEvidencePhoto {
  const fonts = { families: fontOptions.families ?? ["sans-serif"], provider: fontOptions.provider };

  const photo = Skia.Image.MakeImageFromEncoded(input.photo);
  if (!photo) {
    throw new EvidenceBurnError("The photo could not be read on this phone. Take it again.");
  }

  const { height, width } = getCompressedEvidenceSize(photo.width(), photo.height());
  const surface = Skia.Surface.Make(width, height);
  if (!surface) {
    photo.dispose();
    throw new EvidenceBurnError("This phone could not prepare the photo. Close other apps and try again.");
  }

  try {
    const canvas = surface.getCanvas();

    // 1. The frame itself, shrunk to the upload size.
    canvas.drawImageRectOptions(
      photo,
      Skia.XYWHRect(0, 0, photo.width(), photo.height()),
      Skia.XYWHRect(0, 0, width, height),
      FilterMode.Linear,
      MipmapMode.Linear,
      null,
    );
    photo.dispose();

    const plan = planEvidenceWatermark(makeMeasure(Skia, fonts), input.details, width, height);

    // 2. The dark band the text sits on.
    const band = Skia.Paint();
    band.setShader(
      Skia.Shader.MakeLinearGradient(
        Skia.Point(plan.band.from.x, plan.band.from.y),
        Skia.Point(plan.band.to.x, plan.band.to.y),
        plan.band.stops.map((stop) => Skia.Color(stop.color)),
        plan.band.stops.map((stop) => stop.offset),
        TileMode.Clamp,
      ),
    );
    canvas.drawRect(
      Skia.XYWHRect(plan.band.rect.x, plan.band.rect.y, plan.band.rect.width, plan.band.rect.height),
      band,
    );

    // 3. The title and every body line.
    for (const run of plan.texts) {
      drawRun(Skia, canvas, fonts, {
        color: run.color,
        shadow: { blur: run.shadowBlur, color: run.shadowColor },
        sizePx: run.sizePx,
        text: run.text,
        weight: run.weight,
        x: run.x,
        y: run.y,
      });
    }

    // 4. The mark, bottom right, with its own shadow.
    const logo = input.logo ? Skia.Image.MakeImageFromEncoded(input.logo) : null;
    if (logo) {
      const sigma = plan.logo.shadowBlur / 2;
      const logoPaint = Skia.Paint();
      logoPaint.setImageFilter(
        Skia.ImageFilter.MakeDropShadow(0, 0, sigma, sigma, Skia.Color(plan.logo.shadowColor), null),
      );
      canvas.drawImageRectOptions(
        logo,
        Skia.XYWHRect(0, 0, logo.width(), logo.height()),
        Skia.XYWHRect(plan.logo.x, plan.logo.y, plan.logo.size, plan.logo.size),
        FilterMode.Linear,
        MipmapMode.Linear,
        logoPaint,
      );
      logo.dispose();
    }

    surface.flush();
    const snapshot = surface.makeImageSnapshot();
    // The server's parser accepts base64 with no whitespace at all, so anything an encoder wraps
    // is joined back up here rather than trusted.
    const base64 = snapshot
      .encodeToBase64(ImageFormat.JPEG, Math.round(EVIDENCE_JPEG_QUALITY * 100))
      .replace(/\s+/g, "");
    snapshot.dispose();

    if (!base64) {
      throw new EvidenceBurnError("The stamped photo could not be saved as a JPEG. Take it again.");
    }

    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return { base64, byteLength: (base64.length / 4) * 3 - padding, height, width };
  } finally {
    surface.dispose();
  }
}
