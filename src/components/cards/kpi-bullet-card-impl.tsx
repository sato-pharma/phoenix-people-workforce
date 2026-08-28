"use client";

import { LucideIcon, TrendingUp, TrendingDown } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type KPIBulletCardProps = {
  title: string;
  value: string | number;
  trend: string;
  trendDir: "up" | "down";
  icon: LucideIcon;
  color: string;
  data: { val: number }[];
  isActive?: boolean;
  onClick?: () => void;
  className?: string;
};

export function KPIBulletCard({
  title,
  value,
  trend,
  trendDir,
  icon: Icon,
  color,
  data,
  isActive,
  onClick,
  className
}: KPIBulletCardProps) {
  return (
    <Card 
      onClick={onClick}
      className={cn(
        "relative cursor-pointer overflow-hidden border-slate-100 p-5 shadow-[0_8px_30px_rgb(0,0,0,0.04)] transition-all duration-300",
        isActive ? "ring-2 ring-orange-500 scale-[1.02]" : "hover:scale-[1.01] hover:shadow-md",
        className
      )}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-xs font-bold text-slate-500">{title}</p>
          <h3 className="text-2xl font-black text-slate-900">{value}</h3>
          <div className="flex items-center gap-1.5 pt-1">
            {trendDir === "up" ? (
              <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-rose-500" />
            )}
            <span className={cn("text-xs font-black", trendDir === "up" ? "text-emerald-500" : "text-rose-500")}>
              {trend}
            </span>
            <span className="text-phx-2xs font-bold text-slate-400">vs last month</span>
          </div>
        </div>
        <div className={cn(
          "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
          isActive ? "bg-orange-500 text-white" : "bg-orange-50 text-orange-500"
        )}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-10 w-full opacity-30">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <Area type="monotone" dataKey="val" stroke={color} fill={color} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
