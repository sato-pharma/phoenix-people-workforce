import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

type BadgeVariant = "neutral" | "success" | "warning" | "danger";

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
};

export function Badge({
  className,
  variant = "neutral",
  children,
  ...props
}: BadgeProps) {
  const variants: Record<BadgeVariant, string> = {
    neutral: "bg-gradient-to-r from-slate-100 to-slate-200 text-slate-700 ring-1 ring-slate-300 shadow-sm",
    success: "bg-gradient-to-r from-emerald-50 to-emerald-100 text-emerald-700 ring-1 ring-emerald-200 shadow-[0_2px_8px_rgba(16,185,129,0.15)]",
    warning: "bg-gradient-to-r from-orange-50 to-orange-100 text-orange-700 ring-1 ring-orange-200 shadow-[0_2px_8px_rgba(249,115,22,0.15)]",
    danger: "bg-gradient-to-r from-rose-50 to-rose-100 text-rose-700 ring-1 ring-rose-200 shadow-[0_2px_8px_rgba(244,63,94,0.15)]",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-2.5 py-1 text-phx-2xs font-bold uppercase tracking-[0.12em] transition-all duration-200",
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
