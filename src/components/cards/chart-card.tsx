"use client";

import { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ChartCardProps = {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
};

export function ChartCard({ 
  title, 
  action, 
  children, 
  className,
  headerClassName 
}: ChartCardProps) {
  return (
    <Card className={cn("border-slate-100 p-6 shadow-[0_8px_30px_rgb(0,0,0,0.04)] transition-all duration-300", className)}>
      {(title || action) ? (
        <div className={cn("mb-6 flex items-center justify-between", headerClassName)}>
          {title ? (
            <h3 className="text-sm font-black uppercase tracking-widest text-slate-900">{title}</h3>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
      {children}
    </Card>
  );
}
