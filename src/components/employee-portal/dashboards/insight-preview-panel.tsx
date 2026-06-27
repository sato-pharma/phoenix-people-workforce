import { Sparkles } from "lucide-react";

/**
 * Static placeholder for future AI-driven recommendations. Renders fixed copy only —
 * no AI service call, no recommendation engine. Reused across every role dashboard so
 * the future intelligence feature has one wiring point instead of five.
 */
export function InsightPreviewPanel({ note }: { note?: string }) {
  return (
    <div className="relative overflow-hidden border border-dashed border-slate-300 bg-slate-50 px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-[#f47b20]/30 bg-[#f47b20]/10">
          <Sparkles className="h-4 w-4 text-[#f47b20]" />
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Insights</p>
          <p className="mt-1 text-sm text-slate-600">
            {note ?? "Personalized recommendations are coming to this space soon."}
          </p>
        </div>
      </div>
    </div>
  );
}
