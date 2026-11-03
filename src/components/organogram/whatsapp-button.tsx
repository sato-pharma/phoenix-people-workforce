import { cn } from "@/lib/utils";

/**
 * WhatsApp mark. Drawn inline because lucide-react ships no brand icons, and a generic
 * chat bubble would not read as "this opens WhatsApp" at 14px.
 */
export function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" focusable="false" viewBox="0 0 24 24">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  );
}

/**
 * One-press WhatsApp for a person on the organogram.
 *
 * A plain link, deliberately — pressing it navigates straight to
 * /api/reports/organogram/whatsapp/[hrId], which resolves the number server-side and
 * 302s to wa.me. Nothing is fetched into the page, so the chart never holds anybody's
 * mobile, and because it is a real anchor rather than a scripted window.open after an
 * await, no popup blocker gets a chance to swallow it.
 *
 * Callers must render this ONLY when the row's `hasWhatsApp` flag is true, so the ~16%
 * of people with no usable number never get a button that leads to an error page.
 *
 * Never nest this inside the node's own press target — it must be a DOM sibling of that
 * button, or the markup is an anchor inside a button and the browser resolves the click
 * unpredictably. See PersonNode for the shape.
 */
export function OrganogramWhatsAppButton({
  hrId,
  name,
  tone = "light",
}: {
  hrId: string;
  name: string;
  tone?: "light" | "dark";
}) {
  return (
    <a
      aria-label={`Message ${name} on WhatsApp`}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center self-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#25D366]/50",
        tone === "dark"
          ? "border-white/20 bg-white/10 text-[#4AE68A] hover:bg-[#25D366] hover:text-white"
          : "border-slate-200 bg-white text-[#25D366] shadow-sm hover:border-[#25D366] hover:bg-[#25D366] hover:text-white",
      )}
      href={`/api/reports/organogram/whatsapp/${encodeURIComponent(hrId)}`}
      rel="noopener noreferrer"
      target="_blank"
      title={`Message ${name} on WhatsApp`}
    >
      <WhatsAppGlyph className="h-3.5 w-3.5" />
    </a>
  );
}
