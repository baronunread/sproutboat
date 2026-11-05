/**
 * Number formatting shared by every component. Defaults to `en` so a machine whose
 * locale groups with dots never shows "860.000 of 1.000.000" next to "1.28M". Pass a
 * `locale` (or set it once with `LocaleProvider`) to change it.
 */
export const DEFAULT_LOCALE = "en";

const cache = new Map<string, Intl.NumberFormat>();

function formatter(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, options);
    cache.set(key, f);
  }
  return f;
}

export interface FormatOptions {
  locale?: string;
  /** Most fraction digits shown. Defaults: 3 for `formatNumber`, 2 for `formatCompact`. */
  maximumFractionDigits?: number;
}

/** Full number with grouping: 860000 becomes "860,000". */
export function formatNumber(
  n: number,
  { locale = DEFAULT_LOCALE, maximumFractionDigits = 3 }: FormatOptions = {},
): string {
  return formatter(locale, { maximumFractionDigits }).format(n);
}

/** Compact units for large values: 860000 becomes "860K", 1280000 becomes "1.28M". Under 1,000 it is the plain number. */
export function formatCompact(
  n: number,
  { locale = DEFAULT_LOCALE, maximumFractionDigits = 2 }: FormatOptions = {},
): string {
  return formatter(locale, { notation: "compact", maximumFractionDigits }).format(n);
}

const byteUnits = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Decimal (1000-based) byte sizes: 1536 becomes "1.5 KB", 12 becomes "12 B". */
export function formatBytes(
  bytes: number,
  { locale = DEFAULT_LOCALE, maximumFractionDigits = 1 }: FormatOptions = {},
): string {
  if (!Number.isFinite(bytes)) return String(bytes);
  const abs = Math.abs(bytes);
  const exp = abs < 1000 ? 0 : Math.min(byteUnits.length - 1, Math.floor(Math.log10(abs) / 3));
  const value = bytes / 1000 ** exp;
  return `${formatter(locale, { maximumFractionDigits: exp === 0 ? 0 : maximumFractionDigits }).format(value)} ${byteUnits[exp]}`;
}
