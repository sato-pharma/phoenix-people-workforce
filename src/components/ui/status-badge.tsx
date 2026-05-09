import { cn } from "@/lib/utils";

type StatusVariant = "completed" | "pending" | "failed" | "active" | "inactive" | "on_leave" | "probation";

type StatusBadgeProps = {
  status: StatusVariant | string;
  className?: string;
};

const variants: Record<string, string> = {
  completed: "bg-emerald-50 text-emerald-600",
  active: "bg-emerald-50 text-emerald-600",
  pending: "bg-orange-50 text-orange-600",
  probation: "bg-orange-50 text-orange-600",
  failed: "bg-rose-50 text-rose-600",
  inactive: "bg-rose-50 text-rose-600",
  on_leave: "bg-blue-50 text-blue-600",
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const normalizedStatus = status.toLowerCase().replace(" ", "_");
  const variantClass = variants[normalizedStatus] || "bg-slate-50 text-slate-600";

  return (
    <span className={cn(
      "inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider",
      variantClass,
      className
    )}>
      {status}
    </span>
  );
}
