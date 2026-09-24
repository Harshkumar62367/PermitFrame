/**
 * PermitFrame mark - mirrored permission brackets aligned inside a creative
 * boundary. Uses currentColor so it adapts to both themes.
 */
export function PermitFrameMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <g stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 5h16" />
        <path d="M5 8v6" />
        <path d="M5 18v6" />
        <path d="M27 8v6" />
        <path d="M27 18v6" />
        <path d="M8 27h16" />
        <path d="M14 11h-2a3 3 0 0 0-3 3v4a3 3 0 0 0 3 3h2" />
        <path d="M18 11h2a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3h-2" />
      </g>
    </svg>
  );
}
