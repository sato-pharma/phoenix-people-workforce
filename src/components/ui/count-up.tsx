"use client";

import { useEffect, useRef } from "react";
import { CountUp } from "countup.js";

type CountUpNumberProps = {
  /** The final numeric value to animate to. */
  value: number;
  /** Optional formatter applied to every interpolated frame (e.g. currency). */
  format?: (value: number) => string;
  /** Decimal places to animate with (ignored when `format` is provided). */
  decimals?: number;
  /** Animation duration in seconds. Defaults to 0.6s (brief: 600ms). */
  durationSeconds?: number;
  /** Text rendered before the number (not animated). */
  prefix?: string;
  /** Text rendered after the number (not animated). */
  suffix?: string;
  className?: string;
};

/**
 * Animated count-up number.
 *
 * - Uses countup.js for smooth, accessible numeric easing.
 * - Honors `prefers-reduced-motion`: renders the final value instantly.
 * - Re-animates from the previous value whenever `value` changes.
 */
export function CountUpNumber({
  value,
  format,
  decimals = 0,
  durationSeconds = 0.6,
  prefix = "",
  suffix = "",
  className,
}: CountUpNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef<number>(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const finite = Number.isFinite(value) ? value : 0;

    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced) {
      node.textContent = `${prefix}${format ? format(finite) : finite.toFixed(decimals)}${suffix}`;
      previous.current = finite;
      return;
    }

    const counter = new CountUp(node, finite, {
      startVal: previous.current,
      decimalPlaces: decimals,
      duration: durationSeconds,
      useEasing: true,
      prefix,
      suffix,
      formattingFn: format
        ? (n: number) => `${prefix}${format(n)}${suffix}`
        : undefined,
    });

    if (!counter.error) {
      counter.start();
    } else {
      node.textContent = `${prefix}${format ? format(finite) : finite.toFixed(decimals)}${suffix}`;
    }

    previous.current = finite;
  }, [value, decimals, durationSeconds, prefix, suffix, format]);

  return (
    <span
      ref={ref}
      className={className}
      // Server-render the final value so there is no layout shift / empty flash
      suppressHydrationWarning
    >
      {`${prefix}${format ? format(Number.isFinite(value) ? value : 0) : (Number.isFinite(value) ? value : 0).toFixed(decimals)}${suffix}`}
    </span>
  );
}
