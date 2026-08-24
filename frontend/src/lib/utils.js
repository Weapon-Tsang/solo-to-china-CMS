import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function label(value) {
  return String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatDuration(milliseconds) {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 100) / 10} sec`;
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)} min`;
  return `${Math.round(milliseconds / 360_000) / 10} hr`;
}
