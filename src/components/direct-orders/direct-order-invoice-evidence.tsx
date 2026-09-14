"use client";

import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { cn } from "@/lib/utils";

/**
 * The distributor invoice as a reviewer sees it — on the validation desk and on the order's approval
 * detail. Same rendering decision as `PharmacyLicenseEvidence`, for the same reason: a PDF inside an
 * `<img>` is a broken icon, and a reviewer reads a broken icon as "no invoice".
 */
export function DirectOrderInvoiceEvidence({
  className,
  contentType,
  label,
  url,
}: {
  className?: string;
  /** `application/pdf` is the one that changes the rendering. Null is treated as an image. */
  contentType: string | null;
  /** Whose invoice this is, for the alt text and the caption. */
  label: string;
  /** Short-lived signed URL. Null when the file could not be signed. */
  url: string | null;
}) {
  return (
    <div>
      <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">Distributor invoice</p>
      {!url ? (
        // Said out loud: a blank space here would read as "nothing was attached", and every invoice
        // claim has a file — the row is removed if the upload fails.
        <p className="mt-1 border border-amber-200 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-800">
          The invoice file could not be opened just now. Reload the page to try again.
        </p>
      ) : contentType === "application/pdf" ? (
        // A new tab, not an iframe: the signed link expires, and an embedded one fails silently.
        <a
          className="mt-1 inline-block border border-slate-300 px-3 py-1.5 text-phx-sm font-bold text-slate-700 hover:bg-slate-50"
          href={url}
          rel="noreferrer"
          target="_blank"
        >
          Open the invoice (PDF)
        </a>
      ) : (
        <ZoomablePhoto
          alt={`Distributor invoice for ${label}`}
          caption={`Distributor invoice · ${label}`}
          className={cn("mt-1 w-full border border-slate-200 bg-slate-50 object-contain", className)}
          src={url}
        />
      )}
    </div>
  );
}
