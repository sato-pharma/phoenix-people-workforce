/**
 * Shared machinery for Phoenix's live evidence photos — the watermark burned into the ARRIVAL
 * photo captured in the submit wizard, and into the DEPARTURE photo captured afterwards from the
 * portal (owner request 2026-08-04).
 *
 * Extracted from mobile-outstation-wizard.tsx unchanged in behaviour, with ONE deliberate fix
 * noted on formatEvidenceDateTime below. Both captures must burn in the same stamp: the whole
 * point of the pair is that an approver can compare them, and two photos whose watermarks were
 * drawn by two different code paths are exactly the thing that drifts.
 *
 * Pure browser-canvas helpers, no React, so both a wizard step and a portal card can use them.
 */

import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";

export type EvidenceCaptureDetails = {
  capturedAt: string;
  capturedLatitude: number;
  capturedLocationLabel: string;
  capturedLongitude: number;
};

export const EVIDENCE_LOGO_SRC = "/brand/phoenix-camera-watermark.png";

/**
 * The timestamp burned into the photo.
 *
 * This used to call `toLocaleString()` with no timeZone, so the stamp read in whatever zone the
 * employee's phone happened to be set to — and it is EVIDENCE, permanently baked into a JPEG that
 * an approver later compares against a trip date. A device set to the wrong zone produced a photo
 * that looked like it was taken on another day, unfixably. Pinned to Africa/Cairo, which is the
 * business timezone every other Phoenix report already uses.
 */
export function formatEvidenceDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: true,
    minute: "2-digit",
    month: "short",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  }).format(date);
}

/** Best-effort human place name for the capture. Falls back to a stated "unavailable". */
export async function resolveReadableLocation(latitude: number, longitude: number) {
  try {
    const response = await fetch("/api/outstation/reverse-geocode", {
      body: JSON.stringify({ latitude, longitude }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = await response.json();
    if (response.ok && typeof payload.label === "string" && payload.label.trim()) {
      return payload.label.trim();
    }
  } catch {
    // Human-readable location is best-effort; GPS metadata remains attached.
  }

  return "Location unavailable";
}

export function loadWatermarkLogo() {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = EVIDENCE_LOGO_SRC;
  });
}

export function drawWatermarkText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(/\s+/g).filter(Boolean);
  let line = "";
  let currentY = y;

  for (const word of words) {
    const nextLine = line ? `${line} ${word}` : word;
    if (context.measureText(nextLine).width > maxWidth && line) {
      context.fillText(line, x, currentY);
      line = word;
      currentY += lineHeight;
    } else {
      line = nextLine;
    }
  }

  if (line) {
    context.fillText(line, x, currentY);
  }

  return currentY + lineHeight;
}

/**
 * Accepts a live camera frame OR an uploaded image, because both routes now feed the same
 * arrival-photo slot. The two elements report their intrinsic size under different property
 * names — reading `videoWidth` off an image yields `undefined` and would silently fall through
 * to the 1280x720 default, stretching every uploaded photo to 16:9.
 */
export function getCompressedEvidenceCanvasSize(source: HTMLVideoElement | HTMLImageElement) {
  const sourceWidth = ("videoWidth" in source ? source.videoWidth : source.naturalWidth) || 1280;
  const sourceHeight =
    ("videoHeight" in source ? source.videoHeight : source.naturalHeight) || 720;
  const maxDimension = 1280;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));

  return {
    height: Math.max(1, Math.round(sourceHeight * scale)),
    width: Math.max(1, Math.round(sourceWidth * scale)),
  };
}

/**
 * Burn the evidence panel into the bottom of the frame.
 *
 * `label` names which capture this is ("Arrival photo" / "Departure photo") so the two are
 * distinguishable from the image alone, without trusting the filename or the database row.
 */
export async function drawEvidenceWatermark(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  details: EvidenceCaptureDetails & { employeeHrId: string; label: string; reference: string },
) {
  const width = canvas.width;
  const height = canvas.height;
  const padding = Math.max(24, Math.round(width * 0.025));
  const panelHeight = Math.max(150, Math.round(height * 0.22));
  const logoSize = Math.max(112, Math.round(width * 0.13));
  const titleFont = Math.max(18, Math.round(width * 0.018));
  const bodyFont = Math.max(15, Math.round(width * 0.014));
  const lineHeight = Math.round(bodyFont * 1.45);

  const gradient = context.createLinearGradient(0, height - panelHeight, 0, height);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.35, "rgba(0,0,0,0.48)");
  gradient.addColorStop(1, "rgba(0,0,0,0.72)");
  context.fillStyle = gradient;
  context.fillRect(0, height - panelHeight, width, panelHeight);

  context.shadowColor = "rgba(0,0,0,0.65)";
  context.shadowBlur = 8;
  context.fillStyle = "#fff";
  context.font = `800 ${titleFont}px sans-serif`;
  context.fillText(`Phoenix Workforce — ${details.label}`, padding, height - panelHeight + padding + titleFont);

  context.font = `700 ${bodyFont}px sans-serif`;
  context.shadowBlur = 6;
  const textWidth = width - logoSize - padding * 3;
  let y = height - panelHeight + padding + titleFont + lineHeight;
  y = drawWatermarkText(context, `Time: ${formatEvidenceDateTime(details.capturedAt)}`, padding, y, textWidth, lineHeight);
  y = drawWatermarkText(context, `Location: ${details.capturedLocationLabel}`, padding, y, textWidth, lineHeight);
  drawWatermarkText(context, `HR ID: ${details.employeeHrId} | ${details.reference}`, padding, y, textWidth, lineHeight);

  const logo = await loadWatermarkLogo();
  if (logo) {
    context.shadowBlur = 10;
    context.drawImage(logo, width - padding - logoSize, height - padding - logoSize, logoSize, logoSize);
  }
  context.shadowBlur = 0;
}
