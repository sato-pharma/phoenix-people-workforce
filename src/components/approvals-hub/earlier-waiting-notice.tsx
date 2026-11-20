import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/**
 * "Approve the earlier request first" — shown to the person deciding a leave request when the same
 * person has an earlier request in the same balance pool still waiting (owner, 2026-11-17). It warns
 * and never blocks; the message is built by src/lib/vacation/earlier-waiting.ts.
 */
export function EarlierWaitingNotice({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    // The kit's warning: an amber rail on a white sheet, the heading in amber small capitals — never a
    // filled amber box.
    <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white px-3 py-3 sm:px-4 ${adminSoftDepthClassName}`} role="status">
      <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-500" />
      <div className="min-w-0">
        <p className="text-phx-xs font-bold uppercase tracking-[0.1em] text-amber-700">Approve the earlier request first</p>
        <p className="mt-1.5 break-words text-sm font-semibold text-slate-700">{message}</p>
      </div>
    </div>
  );
}
