import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ImageResponse } from "next/og";

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

/** The picture itself. A mail app caches it, so a changed number reaches an old email within the hour. */
export function signatureImageResponse(lines: SignatureLines): ImageResponse {
  const { assets, bold, regular } = resources();
  return new ImageResponse(buildSignatureElement(lines, assets), {
    fonts: [
      { data: toArrayBuffer(regular), name: "Montserrat", style: "normal", weight: 400 },
      { data: toArrayBuffer(bold), name: "Montserrat", style: "normal", weight: 700 },
    ],
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": 'inline; filename="signature.png"',
      "X-Content-Type-Options": "nosniff",
    },
    height: SIGNATURE_PIXEL_HEIGHT,
    width: SIGNATURE_PIXEL_WIDTH,
  });
}
