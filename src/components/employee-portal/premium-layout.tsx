import type { ReactNode } from "react";

/**
 * Premium Grid Layout for dashboard cards
 * Provides responsive grid with premium spacing and alignment
 */
export function PremiumGrid({
  children,
  columns = 3,
  className = "",
}: {
  children: ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  const colsClass = {
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
  };

  return (
    <div className={`grid gap-6 lg:gap-8 ${colsClass[columns]} ${className}`}>
      {children}
    </div>
  );
}

/**
 * Premium Section with optional title and description
 */
export function PremiumSection({
  children,
  title,
  description,
  className = "",
}: {
  children: ReactNode;
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <section className={`space-y-6 lg:space-y-8 ${className}`}>
      {(title || description) && (
        <div className="space-y-2">
          {title && (
            <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
              {title}
            </h2>
          )}
          {description && (
            <p className="text-base text-slate-600 leading-relaxed">
              {description}
            </p>
          )}
          {title && (
            <div className="mt-4 flex gap-2">
              <div className="h-1 w-10 rounded-full bg-gradient-to-r from-orange-400 to-orange-300" />
              <div className="h-1 w-5 rounded-full bg-gradient-to-r from-orange-300 to-orange-200 opacity-50" />
            </div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Premium Divider with optional label
 */
export function PremiumDivider({ label }: { label?: string }) {
  if (!label) {
    return (
      <div className="my-8 h-px bg-gradient-to-r from-transparent via-slate-200/50 to-transparent lg:my-10" />
    );
  }

  return (
    <div className="relative my-8 lg:my-10">
      <div className="absolute inset-0 flex items-center">
        <div className="w-full border-t border-slate-200/50" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-white px-4 text-sm font-medium text-slate-600">
          {label}
        </span>
      </div>
    </div>
  );
}

/**
 * Premium Two Column Layout
 */
export function PremiumTwoColumn({
  left,
  right,
  gap = "6",
}: {
  left: ReactNode;
  right: ReactNode;
  gap?: "3" | "4" | "5" | "6" | "8";
}) {
  const gapClasses = {
    "3": "gap-3",
    "4": "gap-4",
    "5": "gap-5",
    "6": "gap-6",
    "8": "gap-8",
  };

  return (
    <div className={`grid grid-cols-1 lg:grid-cols-2 ${gapClasses[gap]}`}>
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}

/**
 * Premium Container with max-width constraints
 */
export function PremiumContainer({
  children,
  size = "lg",
  className = "",
}: {
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "2xl" | "full";
  className?: string;
}) {
  const sizes = {
    sm: "max-w-2xl",
    md: "max-w-4xl",
    lg: "max-w-6xl",
    xl: "max-w-7xl",
    "2xl": "max-w-full",
    full: "w-full",
  };

  return (
    <div className={`mx-auto w-full ${sizes[size]} ${className}`}>
      {children}
    </div>
  );
}
