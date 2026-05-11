import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

interface PremiumCardProps {
  children: ReactNode;
  className?: string;
  variant?: "default" | "elevated" | "glass";
}

export function PremiumCard({
  children,
  className = "",
  variant = "default",
}: PremiumCardProps) {
  const baseClasses =
    "relative overflow-hidden rounded-2xl border transition-all duration-300 shadow-lg";

  const variants = {
    default:
      "border-white/40 bg-gradient-to-br from-white/90 via-slate-50/80 to-white/80 shadow-[0_20px_50px_rgba(15,23,42,0.08)] backdrop-blur-lg hover:shadow-[0_30px_70px_rgba(15,23,42,0.12)]",
    elevated:
      "border-orange-200/30 bg-gradient-to-br from-white to-orange-50/40 shadow-[0_25px_60px_rgba(249,115,22,0.12)] backdrop-blur-xl hover:shadow-[0_35px_80px_rgba(249,115,22,0.16)]",
    glass:
      "border-white/30 bg-white/40 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur-2xl hover:shadow-[0_30px_80px_rgba(15,23,42,0.12)]",
  };

  return (
    <Card
      className={`${baseClasses} ${variants[variant]} ${className}`}
    >
      {/* Premium shine effect */}
      <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-b from-white/30 via-transparent to-transparent opacity-30" />

      {/* Content */}
      <div className="relative">{children}</div>
    </Card>
  );
}

export function PremiumCardHeader({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-2 border-b border-white/20 px-6 py-5 sm:px-8 ${className}`}>
      {children}
    </div>
  );
}

export function PremiumCardContent({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`px-6 py-5 sm:px-8 ${className}`}>
      {children}
    </div>
  );
}

export function PremiumCardFooter({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`border-t border-white/20 px-6 py-4 sm:px-8 ${className}`}>
      {children}
    </div>
  );
}

export function PremiumStatCard({
  icon: Icon,
  label,
  value,
  change,
  trend,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  change?: string;
  trend?: "up" | "down" | "neutral";
}) {
  const trendColor = {
    up: "text-green-600",
    down: "text-red-600",
    neutral: "text-slate-600",
  };

  return (
    <PremiumCard variant="elevated" className="p-6 sm:p-8">
      <div className="space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-100 to-orange-50 text-orange-600 shadow-[0_8px_20px_rgba(249,115,22,0.15)]">
            <Icon className="h-6 w-6" />
          </div>
          {change && trend && (
            <span className={`text-sm font-semibold ${trendColor[trend]}`}>
              {change}
            </span>
          )}
        </div>

        <div>
          <p className="text-sm font-medium text-slate-600">{label}</p>
          <p className="mt-2 text-3xl font-bold text-slate-900">{value}</p>
        </div>
      </div>
    </PremiumCard>
  );
}
