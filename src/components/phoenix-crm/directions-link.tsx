import { Navigation } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Phoenix CRM — the "Directions" link to a customer's saved place (owner, 2026-10-02).
 *
 * The address is built by `directionsUrl` (src/lib/phoenix-crm/directions.ts) and is null when the
 * place has no usable point — and then this draws NOTHING, never a link to nowhere. It opens Google
 * Maps in a new tab, so a visit half-entered behind it is still there when he comes back, and
 * `noopener noreferrer` so the maps page can neither reach back into Phoenix nor learn where it came
 * from.
 *
 * Two looks, one link:
 *   - `button` — the module's own small secondary button, square, a thumb's height on a phone (the
 *     visit flow's customer card and the visit form's header);
 *   - `text` — one quiet line under a row's place and hours, for the rep's planned day on his landing
 *     page, which is a list of rows rather than a screen of buttons.
 */
export function DirectionsLink({
  className,
  customerName,
  href,
  variant = "button",
}: {
  className?: string;
  /** For the screen reader: "Directions to <customer>". */
  customerName: string;
  href: string | null;
  variant?: "button" | "text";
}) {
  if (!href) return null;
  return (
    <a
      aria-label={`Directions to ${customerName}`}
      className={cn(
        variant === "button"
          ? "inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-none border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 md:min-h-9"
          : "inline-flex min-w-0 items-center gap-1 rounded-none text-phx-xs font-semibold text-slate-600 underline underline-offset-2 transition hover:text-orange-700",
        className,
      )}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <Navigation aria-hidden="true" className={variant === "button" ? "h-3.5 w-3.5 shrink-0" : "h-3 w-3 shrink-0"} />
      Directions
    </a>
  );
}
