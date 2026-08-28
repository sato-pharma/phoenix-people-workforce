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
      border: "border-amber-200 border-t-amber-500 hover:border-amber-300",
      icon: "bg-amber-50 text-amber-600 ring-amber-100",
      line: "bg-amber-500",
      soft: "bg-amber-100/70 text-amber-800",
    },
    blue: {
      border: "border-sky-200 border-t-sky-500 hover:border-sky-300",
      icon: "bg-sky-50 text-sky-600 ring-sky-100",
      line: "bg-sky-500",
      soft: "bg-sky-100/70 text-sky-800",
    },
    green: {
      border: "border-emerald-200 border-t-emerald-500 hover:border-emerald-300",
      icon: "bg-emerald-50 text-emerald-600 ring-emerald-100",
      line: "bg-emerald-500",
      soft: "bg-emerald-100/70 text-emerald-800",
    },
    orange: {
      border: "border-orange-200 border-t-orange-500 hover:border-orange-300",
      icon: "bg-orange-50 text-orange-600 ring-orange-100",
      line: "bg-orange-500",
      soft: "bg-orange-100/70 text-orange-800",
    },
    purple: {
      border: "border-violet-200 border-t-violet-500 hover:border-violet-300",
      icon: "bg-violet-50 text-violet-600 ring-violet-100",
      line: "bg-violet-500",
      soft: "bg-violet-100/70 text-violet-800",
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
    <Card className="group relative min-h-[152px] overflow-hidden rounded border border-white/80 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-5 shadow-[0_12px_30px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-1 hover:ring-slate-300 hover:shadow-[0_20px_42px_rgba(15,23,42,0.09)]">
      <div className={`absolute inset-x-0 top-0 h-1 ${tone.line} opacity-90 transition-all duration-300 group-hover:h-1.5`} />
      <div className="relative flex h-full min-h-[120px] flex-col justify-between gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${tone.line} shadow-[0_0_0_3px_rgba(15,23,42,0.03)]`} />
              <p
                className={[
                  "whitespace-nowrap font-bold uppercase text-slate-400",
                  isLongLabel ? "text-phx-3xs tracking-[0.08em]" : "text-phx-2xs tracking-[0.15em]",
                ].join(" ")}
              >
                {label}
              </p>
            </div>
            <p
              className={[
                "mt-2.5 max-w-full whitespace-nowrap font-black leading-none tracking-tight text-slate-950",
                isCurrencyValue
                  ? "text-xl tabular-nums"
                  : isLongText
                    ? "text-lg"
                    : "text-2xl",
              ].join(" ")}
              title={value}
            >
              {value}
            </p>
          </div>
        </div>

        <div className="relative">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              {note ? (
                <p className="whitespace-nowrap text-phx-xs font-semibold leading-snug text-slate-500" title={note}>
                  {note}
                </p>
              ) : null}
            </div>
          </div>
          <div className={`mt-3 h-1.5 w-16 rounded-sm ${tone.line} opacity-70`} />
        </div>
      </div>
    </Card>
  );
}

export function OverviewKpiCards({ cards }: { cards: OverviewKeyCard[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:gap-4 xl:grid-cols-4">
      {cards.map((card) => (
        <OverviewStatCard
          key={card.label}
          accent={card.accent}
          label={card.label}
          note={card.note}
          value={card.value}
        />
      ))}
    </div>
  );
}
