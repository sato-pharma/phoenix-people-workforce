"use client";

import { useCallback, useState } from "react";
import { Loader2, Share2 } from "lucide-react";

import {
  SHARE_TARGETS,
  shareComposerUrl,
  shareFallbackHint,
  type ShareTargetId,
} from "@/lib/share/social-share";

/**
 * ShareCardBar — share a rendered PNG (a milestone card, a spotlight sheet) to WhatsApp, WhatsApp
 * Status, LinkedIn or Facebook.
 *
 * ON THE REPS' TABLETS (the audience) the branded buttons open the OS share sheet with the actual
 * picture attached — `navigator.share({ files })` — which is the ONLY route to WhatsApp Status and
 * the only one that carries the image. ON A DESKTOP where file sharing is unavailable, the button
 * saves the picture and opens that platform's own composer so the person attaches it, with a one-line
 * hint. Nothing posts on its own; every share is the person's own tap about his own card.
 *
 * The picture is produced lazily through `getFile`, so a heavy render only runs when a share is
 * actually pressed (and the milestone card is re-rendered fresh each time the framing changes).
 */

type ShareFile = { blob: Blob; filename: string };

type Props = {
  /** Produces the PNG to share; returns null if it could not be produced (an error is surfaced by the caller). */
  getFile: () => Promise<ShareFile | null>;
  /** The caption text the composer / share sheet is seeded with. */
  caption: string;
  /**
   * Mints the PUBLIC share link on demand (the tokenised OG page). LinkedIn and Facebook scrape it to
   * show the actual card in the post preview on any device — so when this is present they use it in
   * preference to the native sheet. Returns null if a link cannot be minted (then they fall back).
   */
  getPageUrl?: () => Promise<string | null>;
  disabled?: boolean;
  /** A short heading above the row, e.g. "Share your card". */
  heading?: string;
};

function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  );
}

function LinkedInGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function FacebookGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

function GlyphFor({ id, className }: { id: ShareTargetId; className?: string }) {
  if (id === "linkedin") return <LinkedInGlyph className={className} />;
  if (id === "facebook") return <FacebookGlyph className={className} />;
  return <WhatsAppGlyph className={className} />;
}

function canShareFiles(files: File[]): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
  try {
    return typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files });
  } catch {
    return false;
  }
}

/**
 * Whether the OS share sheet can carry a file — checked SYNCHRONOUSLY (with an empty probe file) so the
 * click handler can decide, before any await, whether it needs to open a composer window.
 */
function supportsFileShare(): boolean {
  try {
    return canShareFiles([new File([new Uint8Array()], "x.png", { type: "image/png" })]);
  } catch {
    return false;
  }
}

/**
 * A composer must be opened INSIDE the click to keep user activation — a `window.open` after the
 * mint's await is blocked as a popup. So we open a blank window synchronously and navigate it once the
 * link is minted. These helpers make that flow readable.
 */
function openBlankPopup(): Window | null {
  try {
    return window.open("", "_blank");
  } catch {
    return null;
  }
}

function navigatePopup(popup: Window | null, url: string) {
  if (popup && !popup.closed) popup.location.href = url;
  else window.open(url, "_blank", "noopener,noreferrer");
}

function closePopup(popup: Window | null) {
  try {
    if (popup && !popup.closed) popup.close();
  } catch {
    /* nothing to do */
  }
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function ShareCardBar({ getFile, caption, getPageUrl, disabled, heading = "Share" }: Props) {
  const [busy, setBusy] = useState<ShareTargetId | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const share = useCallback(
    async (target: ShareTargetId) => {
      setBusy(target);
      setHint(null);
      setError(null);

      const fileShare = supportsFileShare();
      // LinkedIn and Facebook always go through the PUBLIC link (its og:image shows the card on any
      // device); WhatsApp does too on a desktop, where there is no share sheet. Those need a composer
      // window, which MUST be opened inside the click — a window.open after the mint's await is
      // popup-blocked. WhatsApp/Status on a phone use the OS sheet instead, so no window is opened.
      const usesLink =
        getPageUrl != null &&
        (target === "linkedin" || target === "facebook" || (target === "whatsapp" && !fileShare));
      const popup = usesLink ? openBlankPopup() : null;

      try {
        if (usesLink && getPageUrl) {
          const url = await getPageUrl();
          const composer = url ? shareComposerUrl(target, caption, url) : null;
          if (composer) {
            navigatePopup(popup, composer);
            return;
          }
          // Could not mint a link — close the empty window and fall through to the picture path.
          closePopup(popup);
        }

        const produced = await getFile();
        if (!produced) {
          closePopup(popup);
          setError("The picture could not be prepared. Please try again.");
          return;
        }

        // The phone's OS share sheet carries the actual picture, and it is the only route to WhatsApp
        // Status. The person taps the app they want from the sheet.
        if (fileShare) {
          const file = new File([produced.blob], produced.filename, { type: produced.blob.type || "image/png" });
          try {
            await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({
              files: [file],
              text: caption,
            } as ShareData);
            return;
          } catch (caught) {
            // A cancelled share sheet is not an error; anything else falls through to the fallback.
            if (caught instanceof DOMException && caught.name === "AbortError") return;
          }
        }

        // Desktop last resort (WhatsApp Status, or a target with no link): save the picture and open a
        // composer where one exists, with a one-line hint to attach it.
        saveBlob(produced.blob, produced.filename);
        const composer = shareComposerUrl(target, caption, undefined);
        if (composer) window.open(composer, "_blank", "noopener,noreferrer");
        setHint(shareFallbackHint(target));
      } catch {
        closePopup(popup);
        setError("The picture could not be shared. Please try again.");
      } finally {
        setBusy(null);
      }
    },
    [caption, getFile, getPageUrl],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-phx-sm font-black uppercase tracking-[0.18em] text-slate-500">
        <Share2 aria-hidden className="size-3.5 text-orange-500" />
        {heading}
      </div>
      {/* A 2x2 GRID, not a wrap. There are exactly four targets, and `flex-wrap` sized each button to
          its own label — so on a narrow card they broke 3 + 1 and left Facebook alone on the last
          line with a ragged edge above it. Four equal cells read as one block at every width, and
          collapse to a single column only on the very narrowest phones. */}
      <div className="grid grid-cols-2 gap-2">
        {SHARE_TARGETS.map((target) => (
          <button
            key={target.id}
            type="button"
            disabled={disabled || busy !== null}
            onClick={() => share(target.id)}
            aria-label={`Share to ${target.label}`}
            title={`Share to ${target.label}`}
            className="group inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition duration-200 hover:-translate-y-px hover:shadow-[0_6px_16px_rgba(15,23,42,0.10)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ ["--brand" as string]: target.brand }}
          >
            {busy === target.id ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin text-slate-400" />
            ) : (
              <GlyphFor id={target.id} className="size-3.5 text-[var(--brand)]" />
            )}
            <span className="transition-colors group-hover:text-[var(--brand)]">{target.label}</span>
          </button>
        ))}
      </div>
      {hint ? <p className="text-phx-xs font-semibold text-slate-500">{hint}</p> : null}
      {error ? <p className="text-phx-xs font-bold text-rose-700">{error}</p> : null}
    </div>
  );
}
