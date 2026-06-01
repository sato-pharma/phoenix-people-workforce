"use client";

import { cn } from "@/lib/utils";

export type ChoiceGroupOption<TValue extends string> = {
  label: string;
  value: TValue;
};

type ChoiceGroupProps<TValue extends string> = {
  "aria-label": string;
  className?: string;
  disabled?: boolean;
  onChange: (value: TValue) => void;
  optionClassName?: string;
  options: ReadonlyArray<ChoiceGroupOption<TValue>>;
  value: TValue;
};

export function ChoiceGroup<TValue extends string>({
  "aria-label": ariaLabel,
  className,
  disabled = false,
  onChange,
  optionClassName,
  options,
  value,
}: ChoiceGroupProps<TValue>) {
  return (
    <div
      aria-label={ariaLabel}
      className={cn("grid gap-1 rounded-sm border border-slate-200 bg-slate-50 p-0.5", className)}
      role="radiogroup"
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            aria-checked={active}
            className={cn(
              "min-h-10 rounded-sm px-2 py-1.5 text-[12px] font-bold transition focus:outline-none focus:ring-2 focus:ring-orange-200 disabled:cursor-not-allowed disabled:opacity-60 sm:text-[13px]",
              active ? "bg-white text-orange-600 shadow-sm" : "text-slate-500 hover:bg-white/70 hover:text-slate-700",
              optionClassName,
            )}
            disabled={disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;
              event.preventDefault();

              const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
              const nextIndex = (index + direction + options.length) % options.length;
              onChange(options[nextIndex].value);
              const optionButtons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
              optionButtons?.[nextIndex]?.focus();
            }}
            role="radio"
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
