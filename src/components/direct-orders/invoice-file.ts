import { DIRECT_ORDER_INVOICE_MAX_BYTES } from "@/lib/direct-orders/invoice-evidence";

/**
 * A distributor invoice, ready to send with a direct order (owner, 2026-09-14).
 *
 * Browser-only. The server accepts a JPEG, a PNG or a PDF under 5 MB, and a phone hands over whatever
 * its camera makes — a HEIC, a WebP, an 8 MB JPEG. Refusing those would send the rep back to find a
 * converter while standing in the pharmacy, so an image the server would refuse is redrawn here as a
 * JPEG, small enough to send and still sharp enough for an approver to read every line of.
 */
export type PreparedDirectOrderInvoice = {
  dataUrl: string;
  fileName: string;
  isPdf: boolean;
};

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That file could not be read. Try attaching it again."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(blob);
  });
}

async function redrawAsJpeg(file: File, longestSide: number, quality: number): Promise<Blob | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("decode failed"));
      element.src = objectUrl;
    });
    const scale = Math.min(1, longestSide / Math.max(image.naturalWidth, image.naturalHeight, 1));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    // White under a transparent PNG, or the invoice turns black where the paper was.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function prepareDirectOrderInvoiceFile(file: File): Promise<PreparedDirectOrderInvoice> {
  const fileName = file.name || "distributor-invoice";
  const type = file.type.toLowerCase();

  if (type === "application/pdf") {
    if (file.size > DIRECT_ORDER_INVOICE_MAX_BYTES) {
      throw new Error("The invoice PDF is too large. Attach a file under 5 MB.");
    }
    return { dataUrl: await readAsDataUrl(file), fileName, isPdf: true };
  }
  // An empty type is what some phones report for a HEIC — try to draw it rather than refuse it.
  if (type && !type.startsWith("image/")) {
    throw new Error("The distributor invoice must be a photo or a PDF.");
  }
  if ((type === "image/jpeg" || type === "image/png") && file.size <= DIRECT_ORDER_INVOICE_MAX_BYTES) {
    return { dataUrl: await readAsDataUrl(file), fileName, isPdf: false };
  }
  for (const [longestSide, quality] of [
    [2400, 0.85],
    [1600, 0.8],
  ] as const) {
    const redrawn = await redrawAsJpeg(file, longestSide, quality).catch(() => null);
    if (redrawn && redrawn.size > 0 && redrawn.size <= DIRECT_ORDER_INVOICE_MAX_BYTES) {
      return { dataUrl: await readAsDataUrl(redrawn), fileName, isPdf: false };
    }
  }
  throw new Error("That invoice photo could not be prepared. Take it again, or choose a JPEG, PNG or PDF under 5 MB.");
}
