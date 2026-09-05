import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's class combiner: clsx for conditionals, tailwind-merge so a caller's
 *  utility beats the component's default instead of both landing in the class
 *  list and the cascade picking by source order. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
