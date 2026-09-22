import Link from "next/link";
import { PermitFrameMark } from "@/components/logo";

/**
 * Branded recovery state for unknown or legacy verification links. Static
 * copy only - no campaign or workspace data is ever read here, so a
 * guessable legacy receipt/campaign ID reveals nothing.
 */
export default function VerifyNotFound() {
  return (
    <div className="pf-page min-h-screen bg-background">
      <div className="mx-auto w-full max-w-xl px-4 py-14 sm:px-6">
        <div className="flex items-center gap-2.5">
          <PermitFrameMark className="h-6 w-6 text-emerald-600" />
          <span className="text-[14px] font-semibold tracking-tight">Permit<span className="text-emerald-600">Frame</span></span>
        </div>
        <div className="mt-8 rounded-3xl border border-border bg-card p-7 sm:p-9">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Verification link</p>
          <h1 className="font-display mt-2 text-2xl font-semibold tracking-tight">This verification link isn&apos;t available</h1>
          <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
            This older verification link has been replaced. Ask the campaign owner for a refreshed verification link.
          </p>
          <Link
            href="/"
            className="mt-5 inline-flex items-center rounded-full bg-emerald-700 px-4 py-2 text-[13px] font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          >
            Back to PermitFrame
          </Link>
        </div>
      </div>
    </div>
  );
}
