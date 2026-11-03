import { ZoomablePhoto } from "@/components/ui/zoomable-photo";

type Props = {
  customerName: string | null;
  customerPhotoUrl: string | null;
  doctorName: string | null;
  doctorPhotoUrl: string | null;
  metresApart: number | null;
  reason?: string | null;
};

function Side({ caption, name, tone, url }: { caption: string; name: string; tone: string; url: string | null }) {
  return (
    <figure className="min-w-0 border border-slate-200">
      <figcaption className={`px-2 py-1 text-phx-xs font-black text-white ${tone}`}>{caption}</figcaption>
      {url ? (
        <ZoomablePhoto alt={`${caption}: ${name}`} caption={`${caption} · ${name}`} className="h-44 w-full bg-slate-50 object-contain" src={url} />
      ) : (
        <p className="flex h-44 items-center justify-center bg-slate-50 px-2 text-center text-phx-xs text-slate-500">No photo kept</p>
      )}
      <p className="break-words border-t border-slate-200 px-2 py-1 text-phx-sm font-bold text-slate-900" dir="auto">
        {name}
      </p>
    </figure>
  );
}

/**
 * The customer's live photo beside the rep's doctor photo (owner, 2026-10-27: "in the approval window,
 * you will show the two photos"). Dark blue is the marketing request, light blue the rep's list: the
 * colours he chose for the audit sheet, so every screen of this check reads the same way.
 */
export function ListCheckTwoPhotos({ customerName, customerPhotoUrl, doctorName, doctorPhotoUrl, metresApart, reason }: Props) {
  return (
    <section className="border border-slate-200 bg-white p-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Side caption="Marketing request" name={customerName ?? "The customer"} tone="bg-[#0a527d]" url={customerPhotoUrl} />
        <Side caption="Rep's list" name={doctorName ?? "The doctor"} tone="bg-[#1482c2]" url={doctorPhotoUrl} />
      </div>
      {metresApart !== null || reason ? (
        <p className="mt-1.5 text-phx-xs text-slate-600">
          {metresApart !== null ? <span className="font-black text-slate-900">{metresApart.toLocaleString("en-US")} m apart. </span> : null}
          {reason}
        </p>
      ) : null}
    </section>
  );
}
