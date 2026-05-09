"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";

type PageContainerProps = {
  children: ReactNode;
  className?: string;
};

export function PageContainer({ children, className }: PageContainerProps) {
  return (
    <div className={cn("min-w-0 space-y-4 sm:space-y-5", className)}>
      {children}
    </div>
  );
}
