import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatEmployeeDisplayName(
  value: string | null | undefined,
  fallback = "Employee",
  _maxParts = 2,
) {
  void _maxParts;
  const fullName = String(value ?? "").trim().replace(/\s+/g, " ");
  return fullName || fallback;
}
