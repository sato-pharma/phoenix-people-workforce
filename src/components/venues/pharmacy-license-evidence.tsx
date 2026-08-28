"use client";

import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// The pharmacy trade licence (رخصة الصيدلية) as a reviewer sees it.
//
// WHY ONE COMPONENT. The licence is attached in two modules and read on four screens — the Direct
// Orders validation desk, the Direct Orders approval detail, the Marketing approver detail, and the
// Marketing decision confirmation. Every one of them has to make the same call: a JPEG or PNG is an
// image and belongs in the zoomable viewer, a PDF is not and must be offered as a link, because an
// `<img src="….pdf">` renders as a broken icon and the approver simply concludes there is no
// licence. Written four times, that decision gets made three ways.
//
// IT ALSO SAYS THE SAME SENTENCE EVERYWHERE. The licence exists to answer one question — does the
// trade name on this document match the name on the shop sign in the storefront photo — and the two
// ends of that check drifting apart is exactly how a check stops being one. The heading and the
// Arabic name are fixed here for the same reason `pharmacyLicensePrompt` fixes the prompt wording.
// ─────────────────────────────────────────────────────────────────────────────

export function PharmacyLicenseEvidence({
  className,
  contentType,
  label,
  url,
}: {
  /** Thumbnail sizing for the host screen. The PDF link ignores it — a link has no thumbnail. */
  className?: string;
  /** `application/pdf` is the one that changes the rendering. Null is treated as an image. */
  contentType: string | null;
  /** Whose licence this is, for the alt text and the caption. */
  label: string;
  /** Short-lived signed URL, or null when no licence was attached. */
  url: string | null;
}) {
  if (!url) return null;

  return (
    <div className="mt-2">
      <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">
        Pharmacy licence · رخصة الصيدلية
      </p>
      {contentType === "application/pdf" ? (
        // Opened in a new tab rather than embedded: the URL is a short-lived signed link into a
        // private bucket, and an <iframe> of one fails silently the moment it expires.
        <a
          className="mt-1 inline-block border border-slate-300 px-3 py-1.5 text-phx-sm font-bold text-slate-700 hover:bg-slate-50"
          href={url}
          rel="noreferrer"
          target="_blank"
        >
          Open the licence (PDF)
        </a>
      ) : (
        <ZoomablePhoto
          alt={`Pharmacy licence for ${label}`}
          caption={`Pharmacy licence · ${label}`}
          className={cn("mt-1 w-full border border-slate-200 bg-slate-50 object-contain", className)}
          src={url}
        />
      )}
    </div>
  );
}
