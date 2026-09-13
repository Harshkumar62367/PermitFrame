import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ClientReviewForm } from "@/components/client-review-form";
import { PermitFrameMark } from "@/components/logo";
import { resolveShare } from "@/server/platform";

export const dynamic = "force-dynamic";

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const campaign = resolveShare(token);
  if (!campaign) notFound();

  const claims = campaign.preflight?.allowedClaims ?? [];
  const receipts = campaign.receipts.map((r) => ({ ...r, verifyUrl: `/verify/${r.id}` }));

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="flex items-center gap-2.5">
          <PermitFrameMark className="h-6 w-6 text-emerald-600" />
          <span className="text-[14px] font-semibold tracking-tight">Permit<span className="text-emerald-600">Frame</span></span>
          <Badge variant="outline" className="ml-auto rounded-full font-mono text-[10px] uppercase tracking-[0.12em]">client review</Badge>
        </div>

        <h1 className="font-display mt-8 text-3xl font-semibold tracking-tight">{campaign.title}</h1>
        <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {campaign.brand} {campaign.productName} · {campaign.request.platform} · {campaign.request.country}
        </p>

        {claims.length > 0 && (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 dark:border-emerald-900 dark:bg-emerald-950/30">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
              Verified claims in this pack
            </p>
            <p className="mt-1.5 text-[13.5px] text-emerald-900 dark:text-emerald-200">{claims.join(" · ")}</p>
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              Every claim was checked against the brand&rsquo;s verified product facts before generation. Nothing unverified made it in.
            </p>
          </div>
        )}

        {(campaign.captions ?? []).length > 0 && (
          <div className="mt-6 rounded-2xl border border-border bg-card p-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Approved captions & claims manifest</p>
            <div className="mt-3 space-y-3">
              {campaign.captions.map((c, i) => (
                <div key={i} className="rounded-xl bg-muted/60 p-3.5 ring-1 ring-border">
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{c.platform} · disclosure {c.disclosure}</p>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed">{c.text}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {receipts.map((r) => (
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
                <Link href={r.verifyUrl} className="text-[12px] font-medium text-sky-700 hover:underline dark:text-sky-400">
                  Verify →
                </Link>
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
          Generated through the Livepeer Agent · provenance recorded on the OriginTrail DKG ·
          attestations prove declarations and integrity, not legal ownership.
        </p>
      </div>
    </div>
  );
}
