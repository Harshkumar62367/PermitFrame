/**
 * Requested-format vs delivered-file aspect honesty. Pure (no imports), so
 * both the receipt funnel (server) and the review UI (client) share one
 * definition of "is it really 1:1". Small tolerance for provider rounding
 * (e.g. 1023×1024); anything beyond that is a genuine mismatch.
 */

export type AspectVerdict = "match" | "mismatch" | "unknown";

export const FORMAT_RATIOS: Record<string, number> = {
  "9:16": 9 / 16,
  "4:3": 4 / 3,
  "1:1": 1,
  "16:9": 16 / 9
};

/** Relative ratio tolerance: 2% either way still counts as the requested frame. */
export const ASPECT_TOLERANCE = 0.02;

/**
 * Compare the requested plan format against measured file dimensions.
 * "unknown" when there is nothing honest to compare (no measured size, or
 * a format outside the planned set) — never a guess.
 */
export function aspectVerdict(
  format: string,
  width: number | null | undefined,
  height: number | null | undefined
): AspectVerdict {
  const expected = FORMAT_RATIOS[format];
  if (expected === undefined) return "unknown";
  if (!Number.isFinite(width) || !Number.isFinite(height) || (width as number) <= 0 || (height as number) <= 0) {
    return "unknown";
  }
  const actual = (width as number) / (height as number);
  return Math.abs(actual - expected) / expected <= ASPECT_TOLERANCE ? "match" : "mismatch";
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

/**
 * Human label for measured dimensions, e.g. "1024×768 · 4:3". The reduced
 * ratio names what the file actually is; callers compare it with the
 * requested format label.
 */
export function describeActualSize(width: number, height: number): string {
  const divisor = gcd(width, height);
  const w = Math.round(width / divisor);
  const h = Math.round(height / divisor);
  return `${Math.round(width)}×${Math.round(height)} · ${w}:${h}`;
}
