"use client";

import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes } from "react";

import { useDarkSurface } from "@/components/ui/surface-context";

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function Button({
  className,
  type = "button",
  variant = "primary",
  ...props
}: ButtonProps) {
  const dark = useDarkSurface();

  // On the dark admin hero, the transparent/dark-text variants would be invisible,
  // so swap them for legible-on-black equivalents. primary/destructive read fine.
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-primary text-white hover:bg-primary-hover",
    secondary: dark
      ? "border border-white/20 bg-white/10 text-slate-100 backdrop-blur hover:border-[#FDBA74] hover:bg-white/[0.16] hover:text-white"
      : "bg-transparent text-text border border-border hover:bg-bg-muted",
    ghost: dark
      ? "bg-transparent text-slate-200 hover:bg-white/10 hover:text-white"
      : "bg-transparent text-text hover:bg-bg-muted",
    destructive: "bg-danger text-white hover:opacity-90",
  };

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        className,
      )}
      type={type}
      {...props}
    />
  );
}
