"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ResponsiveContainer } from "recharts";

import { cn } from "@/lib/utils";

type SafeResponsiveContainerProps = {
  children: ReactNode;
  className?: string;
  fallback?: ReactNode;
  minHeight?: number;
  minWidth?: number;
  style?: CSSProperties;
};

export function SafeResponsiveContainer({
  children,
  className,
  fallback = null,
  minHeight = 180,
  minWidth = 1,
  style,
}: SafeResponsiveContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ height: number; width: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let animationFrame = 0;
    const measure = () => {
      const { height, width } = container.getBoundingClientRect();
      const nextWidth = Math.floor(width);
      const nextHeight = Math.floor(height);

      setSize((current) => {
        if (nextWidth < minWidth || nextHeight < 1) return null;
        if (current?.width === nextWidth && current.height === nextHeight) return current;
        return { height: Math.max(nextHeight, minHeight), width: nextWidth };
      });
    };

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(measure);
    };

    animationFrame = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    const resizeHandler = () => scheduleMeasure();
    observer.observe(container);
    window.addEventListener("orientationchange", resizeHandler);
    window.addEventListener("resize", resizeHandler);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener("orientationchange", resizeHandler);
      window.removeEventListener("resize", resizeHandler);
    };
  }, [minHeight, minWidth]);

  return (
    <div
      className={cn("min-w-0 w-full", className)}
      ref={containerRef}
      style={{ minHeight, minWidth: 0, ...style }}
    >
      {size ? (
        <ResponsiveContainer height={size.height} width={size.width}>
          {children}
        </ResponsiveContainer>
      ) : fallback}
    </div>
  );
}
