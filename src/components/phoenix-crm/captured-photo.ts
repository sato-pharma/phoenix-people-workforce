import type { CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";

/**
 * Frees the memory a photo's on-phone preview holds. Called by the screen that owns the entry, once
 * the entry is saved or abandoned; the capture itself frees a preview only when the photo is retaken.
 *
 * 🔴 A LEAF MODULE ON PURPOSE (2026-10-01, "slow to transfer between page and page", Phoenix CRM
 * first). The app shell calls this, and the shell is in the one chunk EVERY Phoenix CRM page loads.
 * Imported from the camera module, it pulled the whole camera — its icons, its zoomable preview, its
 * location reads — into that chunk, so opening the List or the Plan downloaded a camera it never
 * showed. The camera module re-exports it, so every other caller is unchanged. Keep this file free
 * of imports that carry code: the type import above is erased at build.
 */
export function releaseCapturedPhoto(photo: CapturedPhoto | null | undefined) {
  if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
}
