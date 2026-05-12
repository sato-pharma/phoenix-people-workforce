import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatEmployeeDisplayName(
  value: string | null | undefined,
  fallback = "Employee",
  maxParts = 2,
) {
  const parts = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  return parts.slice(0, Math.max(1, maxParts)).join(" ");
}
