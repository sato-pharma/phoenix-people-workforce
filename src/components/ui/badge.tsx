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
    neutral: "bg-bg-muted text-text-secondary",
    success: "bg-green-50 text-success dark:bg-green-950/30",
    warning: "bg-orange-50 text-warning dark:bg-orange-950/30",
    danger: "bg-red-50 text-danger dark:bg-red-950/30",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
