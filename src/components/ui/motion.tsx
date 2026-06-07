"use client";

import { motion, useReducedMotion, type HTMLMotionProps } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Shared, accessible micro-interaction primitives for the employee portal.
 *
 * All wrappers honor `prefers-reduced-motion`: when the user opts out, the
 * content renders in its final state with no transform/opacity animation.
 */

const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

type FadeInUpProps = HTMLMotionProps<"div"> & {
  children: ReactNode;
  /** Stagger delay in seconds. */
  delay?: number;
  /** Vertical travel distance in px. */
  distance?: number;
};

/** Fade + rise the element into view once, when scrolled into the viewport. */
export function FadeInUp({
  children,
  delay = 0,
  distance = 14,
  ...rest
}: FadeInUpProps) {
  const reduce = useReducedMotion();

  if (reduce) {
    // Static render (no transform/opacity animation) but keep motion.div so the
    // spread props remain type-compatible.
    return <motion.div {...rest}>{children}</motion.div>;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: distance }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.5, ease: EASE_OUT, delay }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

type StaggerGroupProps = {
  children: ReactNode;
  className?: string;
  /** Gap between each child's entrance, in seconds. */
  step?: number;
};

/** Wrap a row/grid of items to have them rise in sequence. */
export function StaggerGroup({ children, className, step = 0.06 }: StaggerGroupProps) {
  const reduce = useReducedMotion();

  if (reduce) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.15 }}
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: step } },
      }}
    >
      {children}
    </motion.div>
  );
}

/** A single item inside a <StaggerGroup>. */
export function StaggerItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();

  if (reduce) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 12 },
        show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT } },
      }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Standardized interactive card hover: subtle lift + scale + deepening shadow.
 * Use as a className on Card/clickable surfaces for portal-wide consistency.
 * (Tailwind utilities — no JS, GPU-friendly, transitions disabled under
 * prefers-reduced-motion by the portal-global stylesheet.)
 */
export const cardHoverClass =
  "transition-[transform,box-shadow,border-color] duration-200 ease-out " +
  "hover:-translate-y-0.5 hover:scale-[1.02] hover:shadow-[0_18px_40px_rgba(15,23,42,0.12)] " +
  "motion-reduce:transform-none motion-reduce:transition-none";
