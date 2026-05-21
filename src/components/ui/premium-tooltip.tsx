"use client";

import { ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

type TooltipPosition = {
  x: number;
  y: number;
};

type PremiumTooltipProps = {
  children: ReactNode;
  content: ReactNode;
  className?: string;
  triggerClassName?: string;
};

export function PremiumTooltip({ children, content, className, triggerClassName }: PremiumTooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({ x: 0, y: 0 });

  const handleMouseMove = (e: React.MouseEvent) => {
    setPosition({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      className={cn("relative inline-block", triggerClassName)}
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
      onMouseMove={handleMouseMove}
    >
      {children}
      {isVisible && (
        <div
          className={cn(
            "fixed z-50 w-72 rounded-2xl border border-[#E2E8F0] bg-white p-4 shadow-[0_8px_20px_rgba(15,23,42,0.12)] pointer-events-none",
            className
          )}
          style={{
            left: position.x + 12,
            top: position.y + 12,
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}
