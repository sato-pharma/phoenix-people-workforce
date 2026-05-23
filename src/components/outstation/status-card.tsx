"use client";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export type StatusSeverity = "error" | "warning" | "info" | "success";

const statusCardClassName: Record<StatusSeverity, string> = {
  error:
    "rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700",
  warning:
    "rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700",
  info:
    "rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-700",
  success:
    "rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-700",
};

export type StatusCardRole = "alert" | "status";

type StatusCardProps = {
  children: ReactNode;
  className?: string;
  severity: StatusSeverity;
  announce?: boolean;
  role?: StatusCardRole;
};

export function StatusCard({
  children,
  className,
  severity,
  announce = true,
  role: explicitRole,
}: StatusCardProps) {
  const role: StatusCardRole = explicitRole ?? (severity === "error" ? "alert" : "status");

  return (
    <Card
      aria-live={role === "status" && announce ? "polite" : undefined}
      className={cn(statusCardClassName[severity], className)}
      role={role}
    >
      {children}
    </Card>
  );
}

type InfoStatusCardProps = Omit<StatusCardProps, "severity">;

export function InfoStatusCard({ children, className, announce = true, role = "status" }: InfoStatusCardProps) {
  return (
    <StatusCard announce={announce} className={className} role={role} severity="info">
      {children}
    </StatusCard>
  );
}
