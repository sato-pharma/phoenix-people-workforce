import { cn } from "@/lib/utils";

import { composeForecastMessage, forecastWhatsAppShareUrl, type ForecastMessageLine } from "@/lib/phoenix-crm/forecast-whatsapp";

/**
 * WhatsApp mark. Drawn inline because lucide-react ships no brand icons, and a generic chat bubble
 * would not read as "this opens WhatsApp". Same path as the organogram's button.
 */
function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  );
}

/**
 * Hand the agreed forecast to WhatsApp with the message already written.
 *
 * The owner's ask (2026-10-01) was that the rep send the agreed forecast to the CNS group "without
 * writing at all". He types nothing: the message is composed from the boxes he just sent. What this
 * cannot do is skip the group picker — **no WhatsApp product can address a group**, so the rep chooses
 * the CNS group in WhatsApp's own sheet. `forecast-whatsapp.ts` carries why at length.
 *
 * 🔴 A REAL ANCHOR, NOT A SCRIPTED `window.open`. The organogram's button learned this first: an
 * anchor cannot be swallowed by a popup blocker, and on a phone it hands straight to the WhatsApp app.
 *
 * 🔴 SQUARE, like every other control here — `rounded-none`, the square-edge golden rule. The
 * organogram's own WhatsApp button still carries `rounded-md`; it is not the model for the corners.
 * The classes otherwise mirror CrmButton's `success` variant so this reads as one of the family rather
 * than a one-off, and `min-h-11` keeps it a thumb's target.
 *
 * Rendered ONLY once the forecast is actually recorded — see the caller. Offering it before the figures
 * are sent would put a number in the line's group that Phoenix does not have.
 */
export function ForecastWhatsAppButton({
  className,
  day,
  lines,
  territoryName,
}: {
  className?: string;
  day: string;
  lines: readonly ForecastMessageLine[];
  territoryName: string;
}) {
  const message = composeForecastMessage({ day, lines, territoryName });

  return (
    <a
      aria-label="Send today's forecast to the CNS group on WhatsApp"
      className={cn(
        "inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-none border border-emerald-600 bg-emerald-600 px-4 py-2 text-center text-sm font-black text-white transition hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
        className,
      )}
      href={forecastWhatsAppShareUrl(message)}
      rel="noreferrer"
      target="_blank"
    >
      <WhatsAppGlyph className="h-4 w-4 shrink-0" />
      Send on WhatsApp
    </a>
  );
}
