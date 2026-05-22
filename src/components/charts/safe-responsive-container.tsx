"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ResponsiveContainer } from "recharts";

import { cn } from "@/lib/utils";

type SafeResponsiveContainerProps = {
  children: ReactNode;
  className?: string;
  fallback?: ReactNode;
  minHeight?: number;
  style?: CSSProperties;
};

export function SafeResponsiveContainer({
  children,
  className,
  fallback = null,
  minHeight = 180,
  style,
}: SafeResponsiveContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let animationFrame = 0;
    const measure = () => {
      const { height, width } = container.getBoundingClientRect();
      setReady(width > 0 && height > 0);
    };

    animationFrame = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(container);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      className={cn("min-w-0", className)}
      ref={containerRef}
      style={{ minHeight, ...style }}
    >
      {ready ? (
        <ResponsiveContainer height="100%" minWidth={0} width="100%">
          {children}
        </ResponsiveContainer>
      ) : fallback}
    </div>
  );
}
