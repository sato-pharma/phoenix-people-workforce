import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

type InsightItem = {
  l: string;
  s: string;
  c: string;
};

type InsightCardProps = {
  title: string;
  insights: InsightItem[];
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
};

export function InsightCard({ title, insights, actionLabel, onAction, className }: InsightCardProps) {
  return (
    <Card className={cn("border-slate-100 p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)]", className)}>
      <h3 className="mb-6 text-sm font-black text-slate-900">{title}</h3>
      <div className="space-y-6">
        {insights.map((n, i) => (
          <div key={i} className="flex gap-4 group cursor-pointer">
            <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-transform group-hover:scale-110", n.c)}>
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="space-y-1">
              <p className="text-phx-xs font-black text-slate-900 leading-tight group-hover:text-orange-600 transition-colors">{n.l}</p>
              <p className="text-phx-2xs font-bold text-slate-400">{n.s}</p>
            </div>
          </div>
        ))}
      </div>
      {actionLabel && (
        <button 
          onClick={onAction}
          className="mt-10 flex w-full items-center justify-center text-phx-2xs font-black text-orange-600 uppercase tracking-widest hover:underline"
        >
          {actionLabel}
        </button>
      )}
    </Card>
  );
}
