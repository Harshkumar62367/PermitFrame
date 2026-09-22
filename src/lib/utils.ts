import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Normalize typographic dashes in stored/user text for UI display. */
export function displayText(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/[—–‒‒−]/g, "-");
}
