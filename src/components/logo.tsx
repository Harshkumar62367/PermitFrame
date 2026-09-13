/**
 * PermitFrame mark — a verification frame: camera-viewfinder corners
 * (the production frame) closing around a check (the permit).
 * Uses currentColor so it adapts to both themes.
 */
export function PermitFrameMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <path d="M5 11.5V8a3 3 0 0 1 3-3h3.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M20.5 5H24a3 3 0 0 1 3 3v3.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M27 20.5V24a3 3 0 0 1-3 3h-3.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M11.5 27H8a3 3 0 0 1-3-3v-3.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M10.5 16.75l4.5 4.5L22 12" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
