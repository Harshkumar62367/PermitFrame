import { Check } from "lucide-react";
import { notFound } from "next/navigation";
import { lookupVerification } from "@/server/verify";
import { baseSepoliaTransactionUrl, blockExplorerNftUrl } from "@/lib/proof-links";
import { displayText } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Public verification page. Reads ONLY the immutable public snapshot -
 * no session, no workspace data. Unknown refs hit Next's 404, never a 500.
 * Raw record identifiers appear solely inside Technical details, and only
 * when the snapshot genuinely carries an anchored record.
 */
export default async function VerifyPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const v = await lookupVerification(ref);

  if (!v.found) notFound();
  const s = v.snapshot;
  const anchored = s.publicationStatus === "anchored" && !!s.ual;
  const nftLink = anchored && s.ual ? blockExplorerNftUrl(s.ual) : null;
  const transactionLink = anchored ? baseSepoliaTransactionUrl(s.ual, s.txHash) : null;

  return (
    <div className="pf-page min-h-screen bg-background">
      <div className="mx-auto w-full max-w-3xl px-4 py-14 sm:px-6">
        {/* Certificate header - explicitly scoped dark surface */}
        <div className="pf-dark-scope grain relative overflow-hidden rounded-3xl bg-[#0c110f] p-6 text-center text-white sm:p-10">
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: "radial-gradient(55% 55% at 50% 0%, rgba(16,185,129,0.18), transparent 70%)" }}
          />
          <div className="relative">
            <MotionCheck />
            <h1 className="font-display mt-4 text-3xl font-semibold tracking-tight">{displayText(s.title)}</h1>
            <p className="mx-auto mt-2 max-w-lg text-[13.5px] leading-relaxed text-white/55">
              Approved campaign pack - {s.brand} {s.productName} · {s.platform} · {s.country}.
              Every claim below was verified before production.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <span className="rounded-full bg-white/[0.07] px-3.5 py-1.5 text-[12px] text-white/85 ring-1 ring-white/10">
                {anchored ? "Public verification ready" : "Campaign record saved"}
              </span>
              <span className="rounded-full bg-white/[0.07] px-3.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-white/60 ring-1 ring-white/10">
                approved {new Date(s.approvedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </span>
            </div>
          </div>
        </div>

        {/* Outputs */}
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {s.outputs.map((o) => (
            <div key={o.id} id={`output-${o.id}`} className="scroll-mt-24 overflow-hidden rounded-3xl border border-border bg-card">
              {o.mediaType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={o.outputUrl} alt={o.label} className="max-h-[380px] w-full object-contain" />
              ) : (
                <video src={o.outputUrl} controls className="max-h-[380px] w-full bg-black" preload="metadata" />
              )}
              <div className="space-y-1 border-t border-border p-4">
                <p className="text-[13px] font-medium leading-snug">{o.label}</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{o.format} · {o.capability}</p>
                {o.claimsUsed.length > 0 && (
                  <p className="text-[12px] text-emerald-700 dark:text-emerald-300">{o.claimsUsed.join("; ")}</p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Verified claims */}
        {s.verifiedClaims.length > 0 && (
          <div className="mt-6 rounded-3xl border border-emerald-200 bg-emerald-50/60 p-7 dark:border-emerald-900 dark:bg-emerald-950/30">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">Verified claims in this pack</p>
            <p className="mt-2 text-[13.5px] text-emerald-900 dark:text-emerald-200">{s.verifiedClaims.join(" · ")}</p>
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              Every claim was checked against the brand&rsquo;s approved rules before generation. Nothing unverified made it in.
            </p>
          </div>
        )}

        {/* Rights summary */}
        <div className="mt-6 rounded-3xl border border-border bg-card p-7">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">Creator permission behind this pack</p>
          <p className="mt-2 text-[13.5px]">
            {s.creatorName} · {s.rightsSummary.platforms.join(", ")} · {s.rightsSummary.countries.join(", ")}
            {s.rightsSummary.validUntil ? ` · valid to ${s.rightsSummary.validUntil}` : ""}
          </p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {s.brandRules.brand} {s.brandRules.productName}
            {s.brandRules.approvedClaims.length > 0 && ` - approved language: ${s.brandRules.approvedClaims.join("; ")}`}
          </p>
        </div>

        {/* Captions */}
        {s.captions.length > 0 && (
          <div className="mt-6 rounded-3xl border border-border bg-card p-7">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Approved captions</p>
            <div className="mt-3 space-y-3">
              {s.captions.map((c, i) => (
                <div key={i} className="rounded-xl bg-muted/60 p-3.5 ring-1 ring-border">
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{c.platform} · disclosure {c.disclosure}</p>
                  <p className="mt-1.5 text-[13px] leading-relaxed">{c.text}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Technical record identifiers - only when genuinely anchored. */}
        {anchored && (
          <details className="mt-6 rounded-3xl border border-border bg-card p-7">
            <summary className="cursor-pointer text-[13px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              Technical details for verification
            </summary>
            <div className="mt-3 space-y-2">
              <p className="break-all font-mono text-[11px] text-muted-foreground" title={s.ual ?? undefined}>
                Record ·{" "}
                {s.explorerUrl ? (
                  <a href={s.explorerUrl} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline dark:text-sky-300">OriginTrail explorer</a>
                ) : (
                  s.ual
                )}
                {s.ual && nftLink && (
                  <>
                    {" · "}
                    <a href={nftLink.href} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline dark:text-sky-300">
                      {nftLink.label}
                    </a>
                  </>
                )}
                {transactionLink && (
                  <>
                    {" · "}
                    <a href={transactionLink.href} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline dark:text-sky-300">
                      {transactionLink.label}
                    </a>
                  </>
                )}
              </p>
              <p className="break-all font-mono text-[11px] text-muted-foreground" title={s.ual ?? undefined}>{s.ual}</p>
              <p className="text-[11.5px] text-muted-foreground">Verification reference {s.ref}</p>
            </div>
          </details>
        )}

        <p className="mt-8 text-center text-[11px] leading-relaxed text-muted-foreground">
          This page proves what PermitFrame recorded: what was approved, what was permitted, which
          evidence supported the claims, and how the media was produced. It does not constitute
          a legal ownership certificate.
        </p>
      </div>
    </div>
  );
}

function MotionCheck() {
  return (
    <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-400/15 ring-1 ring-emerald-400/40">
      <Check className="h-6 w-6 text-emerald-300" />
    </span>
  );
}
