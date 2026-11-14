"use client";

import { useCallback, useEffect, useRef, type ChangeEvent, type KeyboardEvent, type TextareaHTMLAttributes } from "react";

import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "rows" | "value" | "onChange"> & {
  value: string;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
};

/**
 * A one-line text field that WRAPS and grows instead of hiding what does not fit (owner, 2026-11-14:
 * "fix the Non-employees inputs that hide long bank and Arabic names"). A plain `<input>` is one line by
 * definition, so a long bank name or a long Arabic name sat cut off inside its box until it was clicked and
 * scrolled. This is a `<textarea>` that starts one line tall, is as tall as its text, re-measures when its
 * column changes width, and refuses a line break — a name or a bank is one line of text, wrapped only to be
 * seen whole.
 */
export function WrappingTextField({ value, onChange, onKeyDown, className, ...props }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const fit = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    const border = element.offsetHeight - element.clientHeight;
    element.style.height = `${element.scrollHeight + border}px`;
  }, []);

  useEffect(fit, [fit, value]);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let lastWidth = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === lastWidth) return;
      lastWidth = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(event) => {
        if (/[\r\n]/.test(event.target.value)) event.target.value = event.target.value.replace(/[\r\n]+/g, " ");
        onChange(event);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Enter") event.preventDefault();
        onKeyDown?.(event);
      }}
      className={cn(phxTextareaClassName, "block min-h-9 resize-none overflow-hidden py-[7px] leading-5", className)}
      {...props}
    />
  );
}
