import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Big buttons: full width on a phone, a comfortable fixed width from tablet up (never a 1000px bar). */
export const tapWidth = "w-full md:w-auto md:min-w-64 md:max-w-[360px]"
