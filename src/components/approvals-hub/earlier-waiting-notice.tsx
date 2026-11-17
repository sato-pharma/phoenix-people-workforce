/**
 * "Approve the earlier request first" — shown to the person deciding a leave request when the same
 * person has an earlier request in the same balance pool still waiting (owner, 2026-11-17). It warns
 * and never blocks; the message is built by src/lib/vacation/earlier-waiting.ts.
 */
export function EarlierWaitingNotice({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div className="border border-amber-300 bg-amber-50 p-3" role="status">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-amber-800">Approve the earlier request first</p>
      <p className="mt-1.5 text-sm font-semibold text-amber-900">{message}</p>
    </div>
  );
}
