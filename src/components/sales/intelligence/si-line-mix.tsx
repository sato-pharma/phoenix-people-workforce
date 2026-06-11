"use client";

import { Layers } from "lucide-react";
import { useMemo, useState } from "react";

import { ChartCard } from "@/components/cards/chart-card";
import { SectionHeader } from "@/components/ui/section-header";
import { compactEGP, shareText } from "@/components/sales/intelligence/si-format";
import { formatCurrency } from "@/lib/sales/format";
import { cn } from "@/lib/utils";

type LineSlice = { name: string; value: number; color: string; share: number };

const SIZE = 260;
const C = SIZE / 2;
const R_OUT = 116;
const R_IN = 74;

function arc(startDeg: number, endDeg: number) {
  const large = endDeg - startDeg > 180 ? 1 : 0;
  const p = (deg: number, r: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [C + r * Math.cos(a), C + r * Math.sin(a)];
  };
  const [x0, y0] = p(startDeg, R_OUT);
  const [x1, y1] = p(endDeg, R_OUT);
  const [x2, y2] = p(endDeg, R_IN);
  const [x3, y3] = p(startDeg, R_IN);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${R_OUT} ${R_OUT} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} A${R_IN} ${R_IN} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
}

// Big, centered line-mix donut with a legend below. Light theme, interactive hover.
export function SiLineMix({ lines, totalValue }: { lines: LineSlice[]; totalValue: number }) {
  const [hover, setHover] = useState<string | null>(null);

  const segments = useMemo(() => {
    const offsets = lines.reduce<number[]>((acc, line) => [...acc, (acc[acc.length - 1] ?? 0) + line.share], [0]);
    return lines.map((line, index) => {
      const start = offsets[index] * 360;
      const end = offsets[index + 1] * 360;
      return { ...line, d: arc(start, Math.max(end, start + 0.5)) };
    });
  }, [lines]);

  return (
    <ChartCard className="p-5">
      <SectionHeader icon={Layers} subtitle="Share of net sales value by line." title="Line Mix" />
      <div className="mt-4 flex flex-col items-center gap-6">
        <div className="relative" style={{ width: SIZE, height: SIZE }}>
          <svg height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE}>
            {segments.map((seg) => (
              <path
                d={seg.d}
                fill={seg.color}
                key={seg.name}
                onMouseEnter={() => setHover(seg.name)}
                onMouseLeave={() => setHover(null)}
                style={{ opacity: hover && hover !== seg.name ? 0.3 : 1, transition: "opacity .2s", cursor: "pointer" }}
              />
            ))}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#94A3B8]">EGP</p>
            <p className="text-3xl font-black tracking-tight text-[#0F172A]">{compactEGP(totalValue)}</p>
            <p className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-[#94A3B8]">across {lines.length} lines</p>
          </div>
        </div>

        <div className="grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
          {lines.map((line) => (
            <div
              className={cn(
                "flex items-center justify-between gap-3 border border-[#E2E8F0] bg-white px-3.5 py-2.5 transition",
                hover && hover !== line.name ? "opacity-50" : "opacity-100",
              )}
              key={line.name}
              onMouseEnter={() => setHover(line.name)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: line.color }} />
                <span className="truncate text-sm font-bold text-[#0F172A]">{line.name}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="text-sm font-black tabular-nums text-[#0F172A]">{formatCurrency(line.value)}</span>
                <span className="text-xs font-black text-[#1E3A5F]">{shareText(line.share)}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </ChartCard>
  );
}
