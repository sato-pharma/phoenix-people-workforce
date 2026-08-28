"use client";

import { ReactNode, useRef, useState } from "react";
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
  const triggerRef = useRef<HTMLDivElement>(null);

  const placeAtCursor = (clientX: number, clientY: number) => {
    const pad = 12;
    const estWidth = Math.min(288, window.innerWidth - pad * 2);
    const estHeight = 200;
    const x = Math.min(clientX + pad, window.innerWidth - estWidth - pad);
    const y = Math.min(clientY + pad, window.innerHeight - estHeight - pad);
    setPosition({ x: Math.max(pad, x), y: Math.max(pad, y) });
  };

  const showTooltip = (event?: React.MouseEvent | React.FocusEvent) => {
    setIsVisible(true);
    if (placement !== "cursor") return;
    // Seed the position immediately on show so the tooltip never flashes at the
    // viewport corner before the first mousemove (hover-enter, keyboard focus, tap).
    if (event && "clientX" in event && event.clientX) {
      placeAtCursor(event.clientX, event.clientY);
    } else if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      placeAtCursor(rect.left + rect.width / 2, rect.top);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (placement === "cursor") {
      placeAtCursor(e.clientX, e.clientY);
    }
  };

  return (
    <div
      ref={triggerRef}
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
            "z-50 w-[min(18rem,calc(100vw-1.5rem))] rounded-2xl border border-phx-line bg-white p-4 shadow-[0_8px_20px_rgba(15,23,42,0.12)] pointer-events-none",
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
