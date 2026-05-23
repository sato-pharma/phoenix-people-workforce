import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatEmployeeDisplayName(
  value: string | null | undefined,
  fallback = "Employee",
) {
  const fullName = String(value ?? "").trim().replace(/\s+/g, " ");
  return fullName || fallback;
}
