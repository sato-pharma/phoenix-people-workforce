/**
 * Social sharing — the pure, browser-free half.
 *
 * A rep shares his OWN keepsake — a milestone card or a spotlight sheet — to WhatsApp, his WhatsApp
 * Status, LinkedIn or Facebook. On the reps' Android tablets the real mechanism is the Web Share API
 * with the rendered PNG file, which is the ONLY way to reach WhatsApp Status and the only way any of
 * them carries the actual picture; the desktop fallback saves the picture and opens the platform's
 * own composer so the person attaches it. This module holds only what can be unit-tested without a
 * browser: the caption text, the composer URLs, and the target catalogue. The DOM half (canShare,
 * navigator.share, the download-and-open fallback) lives in the client component that imports these.
 *
 * Nothing here posts anything. Every share is an action the PERSON takes about his OWN card, started
 * by his own tap — the buttons only open a composer or the OS share sheet.
 */

export type ShareTargetId = "whatsapp" | "whatsapp-status" | "linkedin" | "facebook";

export type ShareTarget = {
  id: ShareTargetId;
  /** Button label, kept short so a row of four never forces a sideways scroll. */
  label: string;
  /** Brand colour, used only for the icon and the hover ring — the button stays the portal's light chrome. */
  brand: string;
  /** Whether a desktop web composer exists. WhatsApp Status has none — it is share-sheet only. */
  hasWebComposer: boolean;
};

export const SHARE_TARGETS: readonly ShareTarget[] = [
  { id: "whatsapp", label: "WhatsApp", brand: "#25D366", hasWebComposer: true },
  { id: "whatsapp-status", label: "Status", brand: "#25D366", hasWebComposer: false },
  { id: "linkedin", label: "LinkedIn", brand: "#0A66C2", hasWebComposer: true },
  { id: "facebook", label: "Facebook", brand: "#1877F2", hasWebComposer: true },
];

/** The web composer for a target, or null when only the OS share sheet can reach it (WhatsApp Status). */
export function shareComposerUrl(
  target: ShareTargetId,
  caption: string,
  pageUrl?: string,
): string | null {
  const text = encodeURIComponent(caption);
  switch (target) {
    case "whatsapp":
      // wa.me carries text only; the picture is attached from the download the button also triggers.
      return `https://wa.me/?text=${text}`;
    case "linkedin":
      // The feed composer prefilled with the caption; the person attaches the saved picture.
      return `https://www.linkedin.com/feed/?shareActive=true&text=${text}`;
    case "facebook":
      // sharer needs a public URL; with none we open the composer so the picture can be attached.
      return pageUrl
        ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl)}`
        : `https://www.facebook.com/`;
    case "whatsapp-status":
      return null;
  }
}

/** The line the person shares — a short, warm, first-person caption. Hashtags last so they can be trimmed. */
export function milestoneShareCaption(label: string): string {
  return `Celebrating my ${label} at Sato Pharma! 🎉 #SatoPharma`;
}

export function spotlightShareCaption(rangeLabel: string): string {
  return `My Sato Pharma spotlight — ${rangeLabel}. 🏆 #SatoPharma`;
}

/** What the fallback toast says once the picture is saved and the composer is open. */
export function shareFallbackHint(target: ShareTargetId): string {
  if (target === "whatsapp-status") {
    return "Picture saved. Open WhatsApp on your phone and add it to your Status.";
  }
  return "Picture saved. Attach it to your post in the window that just opened.";
}
