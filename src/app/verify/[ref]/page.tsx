import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { lookupVerification } from "@/server/verify";
import { PermitFrameMark } from "@/components/logo";

export const dynamic = "force-dynamic";

export default async function VerifyPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const v = lookupVerification(ref);

  if (!v.found) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24 text-center">
        <PermitFrameMark className="mx-auto h-10 w-10 text-emerald-700" />
        <h1 className="font-display mt-5 text-2xl font-semibold tracking-tight">Reference not found</h1>
        <p className="mt-2 font-mono text-sm text-muted-foreground">{ref}</p>
        <Link href="/verifier" className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-emerald-700 hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to verifier
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-14">
        {/* Certificate header */}
        <div className="grain relative overflow-hidden rounded-3xl bg-[#0c110f] p-10 text-center text-white">
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: "radial-gradient(55% 55% at 50% 0%, rgba(16,185,129,0.18), transparent 70%)" }}
          />
          <div className="relative">
            <MotionCheck />
            <h1 className="font-display mt-4 text-3xl font-semibold tracking-tight">Verified PermitFrame output</h1>
            <p className="mx-auto mt-2 max-w-lg text-[13.5px] leading-relaxed text-white/55">
              {v.kind === "DerivativeReceipt"
                ? "This derivative was generated inside verified rights and claims. Its receipt is linked to its full lineage."
                : "This campaign production record exists in the PermitFrame evidence layer."}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <span className="rounded-full bg-white/[0.07] px-3.5 py-1.5 text-[12px] text-white/85 ring-1 ring-white/10">{v.label}</span>
              <span
                className={`rounded-full px-3.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] ring-1 ${
                  v.published
                    ? "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30"
                    : "bg-amber-400/10 text-amber-300 ring-amber-400/30"
                }`}
              >
                {v.published ? "published to DKG" : "local evidence store"}
              </span>
            </div>
            {v.ual && (
              <p className="mt-4 font-mono text-[11.5px] text-emerald-300/90">
                UAL:{" "}
                {v.explorerUrl ? (
                  <a href={v.explorerUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{v.ual}</a>
                ) : (
                  v.ual
                )}
              </p>
            )}
          </div>
        </div>

        {/* Media */}
        {v.media && (
          <div className="mt-6 overflow-hidden rounded-3xl border border-border bg-card">
            {v.media.type === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={v.media.url} alt={v.label ?? "generated asset"} className="max-h-[460px] w-full object-contain" />
            ) : (
              <video src={v.media.url} controls className="max-h-[460px] w-full bg-black" />
            )}
            <div className="grid gap-2 border-t border-border p-4 font-mono text-[11px] text-muted-foreground sm:grid-cols-2">
              <p>format: <span className="text-foreground">{v.media.format}</span></p>
              <p className="truncate">hash: <span className="text-foreground">{v.media.hash}</span></p>
            </div>
          </div>
        )}

        {/* Generation evidence */}
        {v.generation && (
          <div className="mt-6 rounded-3xl border border-border bg-card p-7">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-700">Generation evidence</p>
            <dl className="mt-4 grid gap-4 text-[13.5px] sm:grid-cols-2">
              <div>
                <dt className="text-[11.5px] text-muted-foreground">Livepeer capability</dt>
                <dd className="mt-0.5 font-mono text-[12.5px]">{v.generation.capability}</dd>
              </div>
              <div>
                <dt className="text-[11.5px] text-muted-foreground">Generated at</dt>
                <dd className="mt-0.5">{v.generation.generatedAt}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[11.5px] text-muted-foreground">Prompt hash (prompt stays private)</dt>
                <dd className="mt-0.5 break-all font-mono text-[11.5px]">{v.generation.promptHash}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[11.5px] text-muted-foreground">Verified claims used</dt>
                <dd className="mt-0.5 text-emerald-800">{v.claimsUsed.join("; ") || "none"}</dd>
              </div>
            </dl>
          </div>
        )}

        {/* Lineage */}
        {v.lineage && (
          <div className="mt-6 rounded-3xl border border-border bg-card p-7">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-700">Lineage</p>
            <div className="mt-4 space-y-3 text-[13.5px]">
              {v.lineage.permissionPassport && (
                <div className="rounded-2xl bg-muted/60 p-4 ring-1 ring-border">
                  <p className="font-semibold">Creator Permission Passport</p>
                  <p className="mt-1 text-[12.5px] text-muted-foreground">
                    {v.lineage.permissionPassport.creator} · {v.lineage.permissionPassport.platforms.join(", ")} ·{" "}
                    {v.lineage.permissionPassport.countries.join(", ")} · valid to {v.lineage.permissionPassport.validUntil} ·{" "}
                    <span className="capitalize">{v.lineage.permissionPassport.status}</span>
                  </p>
                  {v.lineage.permissionPassport.ual && (
                    <p className="mt-1 font-mono text-[10.5px] text-emerald-700">{v.lineage.permissionPassport.ual}</p>
                  )}
                </div>
              )}
              {v.lineage.productFacts && (
                <div className="rounded-2xl bg-muted/60 p-4 ring-1 ring-border">
                  <p className="font-semibold">Verified Product Facts — {v.lineage.productFacts.brand} {v.lineage.productFacts.productName}</p>
                  <p className="mt-1 text-[12.5px] text-muted-foreground">approved: {v.lineage.productFacts.approvedClaims.join(", ")}</p>
                  <p className="text-[12.5px] text-muted-foreground">prohibited: {v.lineage.productFacts.prohibitedClaims.join(", ")}</p>
                  {v.lineage.productFacts.ual && (
                    <p className="mt-1 font-mono text-[10.5px] text-emerald-700">{v.lineage.productFacts.ual}</p>
                  )}
                </div>
              )}
              {v.lineage.campaign && (
                <div className="rounded-2xl bg-muted/60 p-4 ring-1 ring-border">
                  <p className="font-semibold">Campaign</p>
                  <p className="mt-1 text-[12.5px] text-muted-foreground">{v.lineage.campaign.title}</p>
                  {"receipts" in v.lineage && v.lineage.receipts && (
                    <ul className="mt-2 space-y-1 text-[12.5px]">
                      {v.lineage.receipts.map((r) => (
                        <li key={r.id}>
                          <Link href={`/verify/${r.id}`} className="text-sky-700 hover:underline">
                            {r.label} receipt {r.ual ? `· ${r.ual}` : "(local)"}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <p className="mt-8 text-center text-[11px] leading-relaxed text-muted-foreground">
          This page proves what PermitFrame recorded: who attested, what was permitted, which
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
