import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type StatusCardProps = {
  title: string;
  value: string | number;
  subtitle: string;
  percent: number;
  colorClass?: string;
  className?: string;
};

export function StatusCard({ 
  title, 
  value, 
  subtitle, 
  percent, 
  colorClass = "stroke-emerald-500", 
  className 
}: StatusCardProps) {
  return (
    <Card className={cn("flex items-center justify-between border-slate-100 p-5 shadow-[0_8px_30px_rgb(0,0,0,0.04)]", className)}>
      <div className="space-y-1">
        <p className="text-xs font-bold text-slate-500">{title}</p>
        <h3 className="text-2xl font-black text-slate-900">{value}</h3>
        <p className="text-[11px] font-bold text-slate-400">{subtitle}</p>
      </div>
      <div className="relative h-16 w-16">
        <svg className="h-full w-full" viewBox="0 0 36 36">
          <circle className="stroke-slate-100" strokeWidth="3" fill="none" cx="18" cy="18" r="16" />
          <circle
            className={cn("transition-all duration-1000", colorClass)}
            strokeWidth="3"
            strokeDasharray={`${percent}, 100`}
            strokeLinecap="round"
            fill="none"
            cx="18"
            cy="18"
            r="16"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs font-black text-slate-900">{percent}%</span>
        </div>
      </div>
    </Card>
  );
}
