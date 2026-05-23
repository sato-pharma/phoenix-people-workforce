import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";

type MetricAccent = "amber" | "blue" | "green" | "orange" | "purple";

export type OverviewKeyCard = {
  accent?: MetricAccent;
  icon?: LucideIcon;
  label: string;
  note?: string;
  progress?: number | null;
  value: string;
};

function metricTone(accent: MetricAccent = "orange") {
  const tones = {
    amber: {
      border: "border-amber-100 border-t-amber-500",
      icon: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/60",
      line: "bg-amber-500",
      soft: "bg-amber-50 text-amber-900",
      label: "text-amber-600",
    },
    blue: {
      border: "border-sky-100 border-t-sky-500",
      icon: "bg-sky-50 text-sky-700 ring-1 ring-sky-200/60",
      line: "bg-sky-500",
      soft: "bg-sky-50 text-sky-900",
      label: "text-sky-600",
    },
    green: {
      border: "border-emerald-100 border-t-emerald-500",
      icon: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60",
      line: "bg-emerald-500",
      soft: "bg-emerald-50 text-emerald-900",
      label: "text-emerald-600",
    },
    orange: {
      border: "border-orange-100 border-t-orange-500",
      icon: "bg-orange-50 text-orange-700 ring-1 ring-orange-200/60",
      line: "bg-orange-500",
      soft: "bg-orange-50 text-orange-900",
      label: "text-orange-600",
    },
    purple: {
      border: "border-violet-100 border-t-violet-500",
      icon: "bg-violet-50 text-violet-700 ring-1 ring-violet-200/60",
      line: "bg-violet-500",
      soft: "bg-violet-50 text-violet-900",
      label: "text-violet-600",
    },
  } satisfies Record<MetricAccent, Record<string, string>>;

  return tones[accent];
}

function OverviewStatCard({
  accent,
  label,
  note,
  value,
}: {
  accent?: MetricAccent;
  label: string;
  note?: string;
  value: string;
}) {
  const tone = metricTone(accent);
  const isCurrencyValue = value.startsWith("EGP");
  const isLongText = value.length > 18 && !isCurrencyValue;
  const isLongLabel = label.length > 18;

  return (
    <Card className={`group relative min-h-[160px] overflow-hidden rounded-2xl border-2 ${tone.border} bg-white/95 backdrop-blur-sm p-6 shadow-[0_2px_12px_rgba(15,23,42,0.04)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)]`}>
      <div className={`absolute inset-x-0 top-0 h-1.5 ${tone.line} transition-all duration-300 group-hover:h-2`} />
      
      <div className="relative flex h-full min-h-[132px] flex-col justify-between gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className={`text-[10px] font-bold uppercase tracking-[0.12em] ${tone.label} transition-colors group-hover:opacity-80`}>{label}</p>
            <p
              className={[
                "mt-2.5 max-w-full font-black leading-tight tracking-tight text-slate-950",
                isCurrencyValue
                  ? "text-lg tabular-nums"
                  : isLongText
                    ? "text-xl"
                    : "text-3xl",
              ].join(" ")}
              title={value}
            >
              {value}
            </p>
          </div>
        </div>

        <div className="relative space-y-3 pt-1">
          {note && (
            <p className="line-clamp-2 text-[11px] font-medium leading-snug text-slate-600" title={note}>
              {note}
            </p>
          )}
          <div className={`h-1 w-12 rounded-full ${tone.line} opacity-75 transition-all duration-300 group-hover:w-16 group-hover:opacity-90`} />
        </div>
      </div>
    </Card>
  );
}

export function OverviewKpiCards({ cards }: { cards: OverviewKeyCard[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:gap-5 xl:grid-cols-4">
      {cards.map((card, index) => (
        <div key={card.label} style={{ animationDelay: `${index * 40}ms` }} className="ep-fade-in-up">
          <OverviewStatCard
            accent={card.accent}
            label={card.label}
            note={card.note}
            value={card.value}
          />
        </div>
      ))}
    </div>
  );
}
