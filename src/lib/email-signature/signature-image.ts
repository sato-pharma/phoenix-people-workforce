import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { createDrawnPictureCache } from "@/lib/email-signature/drawn-cache";
import type { SignatureLines } from "@/lib/email-signature/signature-content";
import {
  buildSignatureElement,
  SIGNATURE_PIXEL_HEIGHT,
  SIGNATURE_PIXEL_WIDTH,
  type SignatureAssets,
} from "@/lib/email-signature/signature-layout";

// Draws one employee's signature as a PNG. The fonts and the two logos are read from disk the way the
// business-card PDF reads its own (next.config traces `assets/business-cards/*.ttf`; `public/` is
// copied into the image whole), and held in memory after the first read — every opened email asks for
// the picture again.

let loaded: { assets: SignatureAssets; bold: Buffer; regular: Buffer } | null = null;

function dataUri(path: string): string {
  return `data:image/png;base64,${readFileSync(join(process.cwd(), path)).toString("base64")}`;
}

function resources() {
  if (!loaded) {
    loaded = {
      assets: {
        emblem: dataUri("public/brand/phoenix-login-emblem.png"),
        sato: dataUri("public/brand/sato-pharma-logo-on-light.png"),
      },
      bold: readFileSync(join(process.cwd(), "assets", "business-cards", "Montserrat-Bold.ttf")),
      regular: readFileSync(join(process.cwd(), "assets", "business-cards", "Montserrat-Regular.ttf")),
    };
  }
  return loaded;
}

function toArrayBuffer(file: Buffer): ArrayBuffer {
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}

// A drawn picture is kept for the hour under the exact lines it shows (drawn-cache.ts, REC-055).
const drawn = createDrawnPictureCache(100, 60 * 60 * 1000);

async function drawSignaturePng(lines: SignatureLines): Promise<ArrayBuffer> {
  const { assets, bold, regular } = resources();
  return new ImageResponse(buildSignatureElement(lines, assets), {
    fonts: [
      { data: toArrayBuffer(regular), name: "Montserrat", style: "normal", weight: 400 },
      { data: toArrayBuffer(bold), name: "Montserrat", style: "normal", weight: 700 },
    ],
    height: SIGNATURE_PIXEL_HEIGHT,
    width: SIGNATURE_PIXEL_WIDTH,
  }).arrayBuffer();
}

/** The picture itself. A mail app caches it, so a changed number reaches an old email within the hour. */
export async function signatureImageResponse(lines: SignatureLines): Promise<Response> {
  const png = await drawn.get(JSON.stringify(lines), () => drawSignaturePng(lines));
  return new Response(png.slice(0), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": 'inline; filename="signature.png"',
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
