type ClassValue = string | false | null | undefined;

/** Tiny classnames helper — keeps conditional Tailwind readable. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
