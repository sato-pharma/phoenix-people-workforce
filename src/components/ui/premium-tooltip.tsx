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
  placement?: "cursor" | "top";
  triggerClassName?: string;
};

export function PremiumTooltip({
  children,
  content,
  className,
  placement = "cursor",
  triggerClassName,
}: PremiumTooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({ x: 0, y: 0 });

  const showTooltip = () => {
    setIsVisible(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (placement === "cursor") {
      setPosition({ x: e.clientX, y: e.clientY });
    }
  };

  return (
    <div
      className={cn("relative inline-block", triggerClassName)}
      onFocus={showTooltip}
      onBlur={() => setIsVisible(false)}
      onMouseEnter={showTooltip}
      onMouseLeave={() => setIsVisible(false)}
      onMouseMove={handleMouseMove}
    >
      {children}
      {isVisible && (
        <div
          className={cn(
            "z-50 w-72 rounded-2xl border border-[#E2E8F0] bg-white p-4 shadow-[0_8px_20px_rgba(15,23,42,0.12)] pointer-events-none",
            placement === "top"
              ? "absolute bottom-full left-1/2 mb-2 -translate-x-1/2"
              : "fixed",
            className
          )}
          style={placement === "cursor" ? { left: position.x + 12, top: position.y + 12 } : undefined}
        >
          {content}
        </div>
      )}
    </div>
  );
}
