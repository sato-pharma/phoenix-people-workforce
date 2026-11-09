import { Camera, MapPin } from "lucide-react";

import { parseOutstationDescription } from "@/lib/outstation/description-format";

/**
 * An outstation request's description as a person reads it: the employee's own words, any
 * allowance notice, and each photo stamp as a small card (Cairo time, a clean address, the brick,
 * area and region, a map link). The stored text keeps its machine audit line; this only renders it.
 *
 * Every line carries its own `dir="auto"`: a note or address can be Arabic while its neighbours are
 * English, and a direction set on the block would turn the English lines around.
 */
export function OutstationDescription({
  className = "",
  empty = "—",
  value,
}: {
  className?: string;
  empty?: string;
  value: string | null | undefined;
}) {
  const parts = parseOutstationDescription(value);
  // Blank lines INSIDE the note are kept: a rep who left a gap between two paragraphs meant it, and
  // dropping it runs their paragraphs together. Only leading and trailing blanks go, because those
  // are an artefact of how the machine audit lines were appended, not something anyone typed.
  const allLines = (parts.note ?? "").split("\n");
  let first = 0;
  let last = allLines.length - 1;
  while (first <= last && allLines[first].trim() === "") first += 1;
  while (last >= first && allLines[last].trim() === "") last -= 1;
  const noteLines = first <= last ? allLines.slice(first, last + 1) : [];

  if (noteLines.length === 0 && parts.allowanceNotices.length === 0 && parts.evidence.length === 0) {
    return <p className={`leading-relaxed text-slate-700 ${className}`}>{empty}</p>;
  }

  return (
    <div className={`space-y-2 ${className}`} data-outstation-description>
      {noteLines.length > 0 && (
        <div className="space-y-0.5">
          {noteLines.map((line, index) => (
            <p className="break-words leading-relaxed text-slate-800" dir="auto" key={index}>
              {/* An empty line still has to occupy one, or the gap the writer left disappears. */}
              {line.trim() === "" ? " " : line}
            </p>
          ))}
        </div>
      )}

      {parts.allowanceNotices.map((notice, index) => (
        <p
          className="break-words border-l-2 border-amber-400 bg-amber-50 px-2.5 py-1.5 leading-snug text-amber-900"
          key={`allowance-${index}`}
        >
          {notice}
        </p>
      ))}

      {parts.evidence.map((stamp, index) => {
        const territory = [
          stamp.brick ? { label: "Brick", value: stamp.brick } : null,
          stamp.area ? { label: "Area", value: stamp.area } : null,
          stamp.region ? { label: "Region", value: stamp.region } : null,
        ].filter((item): item is { label: string; value: string } => item !== null);

        return (
          <div className="border border-slate-200 bg-white px-3 py-2" key={`evidence-${index}`}>
            <p className="flex flex-wrap items-center gap-x-1.5 text-phx-sm font-bold uppercase tracking-wider text-slate-500">
              <Camera aria-hidden className="h-3.5 w-3.5 text-orange-500" />
              <span>{stamp.title}</span>
              {stamp.sourceLabel && <span className="font-medium normal-case tracking-normal">· {stamp.sourceLabel}</span>}
            </p>
            {stamp.capturedAtLabel && (
              <p className="mt-1 font-semibold text-slate-800">{stamp.capturedAtLabel}</p>
            )}
            {stamp.place && (
              <p className="mt-0.5 break-words leading-snug text-slate-600" dir="auto">
                {stamp.place}
              </p>
            )}
            {territory.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-phx-xs text-slate-500">
                {territory.map((item) => (
                  <span key={item.label}>
                    {item.label} <span className="font-semibold text-slate-700" dir="auto">{item.value}</span>
                  </span>
                ))}
              </p>
            )}
            {stamp.mapUrl && (
              <a
                className="mt-1.5 inline-flex items-center gap-1 text-phx-xs font-semibold text-orange-600 hover:text-orange-700 hover:underline"
                href={stamp.mapUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <MapPin aria-hidden className="h-3.5 w-3.5" />
                View on map
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
