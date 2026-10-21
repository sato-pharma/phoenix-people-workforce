import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import type { DirectOrderVenueValidationPhoto } from "@/lib/direct-orders/types";

/**
 * Every validation photo of the venue an order stands on, with every captured detail beside it
 * (owner, 2026-10-21: the SFE and managerial approvers must see the validation photo of the pharmacy
 * AND the customer with 100% of its data — "never hide a picture if available").
 *
 * One card per photo, the photo first, the details as a fixed two-column table that WRAPS — an Arabic
 * address or a long note wraps inside its cell rather than scrolling (the fits-the-screen rule), and
 * nothing is cut with an ellipsis. A photo recorded but not signable keeps its card and says so, so an
 * approver is never left believing no picture exists.
 */
export function DirectOrderVenueValidationPhotos({ photos }: { photos: DirectOrderVenueValidationPhoto[] }) {
  if (photos.length === 0) {
    return (
      <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-800">
        No validation photo of this venue is on file — not from Direct Orders and not from a Marketing
        customer validation.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {photos.map((photo) => (
        <article key={photo.key} className="border border-slate-200">
          <header className="border-b border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-600">{photo.title}</p>
            <p className="mt-0.5 break-words text-sm font-black text-slate-900" dir="auto">
              {photo.subject}
            </p>
          </header>
          <div className="grid grid-cols-1 gap-4 p-3 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
            <div className="min-w-0">
              {photo.photoUrl ? (
                <ZoomablePhoto
                  alt={`${photo.title}: ${photo.subject}`}
                  caption={`${photo.title} — ${photo.subject}`}
                  className="w-full border border-slate-200"
                  src={photo.photoUrl}
                />
              ) : (
                <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-800">
                  {photo.details.some((row) => row.label === "Photo")
                    ? "No live photo on file."
                    : "A photo is on file but could not be opened right now — reload the page."}
                </p>
              )}
              {photo.photoLatitude !== null && photo.photoLongitude !== null ? (
                <a
                  className="mt-1 block text-phx-xs font-bold text-orange-600 underline"
                  href={`https://www.google.com/maps?q=${photo.photoLatitude},${photo.photoLongitude}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open where the photo was taken on the map
                </a>
              ) : null}
            </div>
            <table className="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col className="w-[38%] sm:w-[30%]" />
                <col />
              </colgroup>
              <tbody>
                {photo.details.map((row, index) => (
                  <tr key={`${row.label}-${index}`} className={index % 2 ? "bg-slate-50/60" : "bg-white"}>
                    <th
                      scope="row"
                      className="break-words border-b border-slate-100 px-2 py-1.5 text-left align-top text-phx-2xs font-black uppercase tracking-wider text-slate-400"
                    >
                      {row.label}
                    </th>
                    <td className="break-words border-b border-slate-100 px-2 py-1.5 align-top font-semibold text-slate-900" dir="auto">
                      {row.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      ))}
    </div>
  );
}
