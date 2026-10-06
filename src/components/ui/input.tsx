import { cn } from "@/lib/utils";
import type { InputHTMLAttributes } from "react";
import { phxFieldClassName } from "./form-tokens";

// 🔒 THE ONE FORM DESIGN (owner, 2026-10-06). 55 files import this primitive,
// and until the sweep it carried a look of its own — `rounded-lg`, the legacy
// `border-border`/`bg-card` pair and an outline focus ring — so a form built on
// it read as a different system from the one beside it. It now wears the shared
// field token like everything else. `className` still wins, so a caller that
// needs a shorter box can pass `h-8` and a wider one `max-w-xs`.

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, type = "text", ...props }: InputProps) {
  return <input className={cn(phxFieldClassName, className)} type={type} {...props} />;
}
