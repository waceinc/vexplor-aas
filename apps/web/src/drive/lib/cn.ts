import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind 클래스 합치기 — 뒤에 온 것이 이긴다 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
