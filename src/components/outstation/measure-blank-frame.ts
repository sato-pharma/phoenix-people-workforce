"use client";

import { FRAME_SAMPLE_SIZE, FRAME_TOP_SHARE, greyFromRgba, readFrame, type FrameReading } from "@/lib/outstation/blank-frame";

/**
 * Measures a camera frame already drawn on `canvas`, BEFORE the stamp is drawn over it (blank-frame.ts).
 * Null when the browser will not read the pixels back — and null refuses nothing: the server measures
 * the stored photo again.
 */
export function measureCanvasFrame(canvas: HTMLCanvasElement): FrameReading | null {
  try {
    const sample = document.createElement("canvas");
    sample.width = FRAME_SAMPLE_SIZE;
    sample.height = FRAME_SAMPLE_SIZE;
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context || canvas.width < 2 || canvas.height < 2) return null;
    const top = Math.max(1, Math.floor(canvas.height * FRAME_TOP_SHARE));
    context.drawImage(canvas, 0, 0, canvas.width, top, 0, 0, FRAME_SAMPLE_SIZE, FRAME_SAMPLE_SIZE);
    const pixels = context.getImageData(0, 0, FRAME_SAMPLE_SIZE, FRAME_SAMPLE_SIZE).data;
    return readFrame(greyFromRgba(pixels), FRAME_SAMPLE_SIZE, FRAME_SAMPLE_SIZE);
  } catch {
    return null;
  }
}
