import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ClientReviewForm } from "@/components/client-review-form";
import { PermitFrameMark } from "@/components/logo";
import { lookupShare } from "@/server/public-share";
import { displayText } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Public client-review page. Reads ONLY the whitelisted PublicShareView -
 * no session, no workspace data, no internal fields. Unknown tokens hit the
 * branded recovery state, never a 500. Works logged out by design.
 */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await lookupShare(token);
  if (!result.found) notFound();
  const view = result.view;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="flex items-center gap-2.5">
          <PermitFrameMark className="h-6 w-6 text-emerald-600" />
          <span className="text-[14px] font-semibold tracking-tight">Permit<span className="text-emerald-600">Frame</span></span>
          <Badge variant="outline" className="ml-auto rounded-full font-mono text-[10px] uppercase tracking-[0.12em]">client review</Badge>
        </div>

        <h1 className="font-display mt-8 text-3xl font-semibold tracking-tight">{displayText(view.title)}</h1>
        <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {view.brand} {view.productName} · {view.platform} · {view.country}
        </p>

        {view.allowedClaims.length > 0 && (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 dark:border-emerald-900 dark:bg-emerald-950/30">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
              Verified claims in this pack
            </p>
            <p className="mt-1.5 text-[13.5px] text-emerald-900 dark:text-emerald-200">{view.allowedClaims.join(" · ")}</p>
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              Every claim was checked against the brand&rsquo;s verified product facts before generation. Nothing unverified made it in.
            </p>
          </div>
        )}

        {view.captions.length > 0 && (
          <div className="mt-6 rounded-2xl border border-border bg-card p-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Approved captions & claims manifest</p>
            <div className="mt-3 space-y-3">
              {view.captions.map((c, i) => (
                <div key={i} className="rounded-xl bg-muted/60 p-3.5 ring-1 ring-border">
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{c.platform} · disclosure {c.disclosure}</p>
                  <p className="mt-1.5 text-[13px] leading-relaxed">{c.text}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {view.outputs.map((r) => (
            <div key={r.id} className="overflow-hidden rounded-2xl border border-border bg-card">
              {r.mediaType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.outputUrl} alt={r.label} className="aspect-[4/3] w-full object-cover" />
              ) : (
                <video src={r.outputUrl} controls className="aspect-[4/3] w-full bg-black object-contain" />
              )}
              <div className="flex items-center justify-between p-3.5">
                <div>
                  <p className="text-[13px] font-medium">{r.label}</p>
                  <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{r.format}</p>
                </div>
                {r.verifyUrl ? (
                  <Link href={r.verifyUrl} className="text-[12px] font-medium text-sky-700 hover:underline dark:text-sky-400">
                    Verify →
                  </Link>
                ) : (
                  <span className="text-[11px] text-muted-foreground" title="Approve the pack to publish its verification link">
                    Verify after approval
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-3xl border border-border bg-card p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Your review</p>
          <div className="mt-4">
            <ClientReviewForm token={token} />
          </div>
        </div>

        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          Produced by PermitFrame · proof trail attached ·
          attestations prove declarations and integrity, not legal ownership.
        </p>
      </div>
    </div>
  );
}
