import Link from "next/link";
import { ArrowLeft, BookOpen } from "lucide-react";

export default function DocsNotFound() {
  return (
    <div className="mx-auto max-w-2xl rounded-3xl border border-border bg-card px-6 py-14 text-center shadow-sm shadow-black/[0.03] dark:bg-[#141816] dark:shadow-none sm:px-10">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-400">
        <BookOpen className="h-5 w-5" aria-hidden />
      </span>
      <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Page not found</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">This guide page does not exist.</h1>
      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">Return to the documentation overview and choose one of the five guide pages.</p>
      <Link href="/docs" className="mt-6 inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-500">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to documentation
      </Link>
    </div>
  );
}
