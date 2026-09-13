"use client";

import { useEffect, useState } from "react";
import { Plus, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";
import type { ProductFacts } from "@/server/types";

export default function ProductsPage() {
  const [factsList, setFactsList] = useState<ProductFacts[] | null>(null);
  const [editing, setEditing] = useState<ProductFacts | null>(null);
  const [form, setForm] = useState({ brand: "", productName: "", approved: "", prohibited: "", guidelines: "", evidence: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/facts")
      .then((r) => r.json())
      .then((d) => setFactsList(d.facts))
      .catch(() => setFactsList([]));
  }, []);

  function startEdit(f: ProductFacts) {
    setEditing(f);
    setForm({
      brand: f.brand,
      productName: f.productName,
      approved: f.approvedClaims.join(", "),
      prohibited: f.prohibitedClaims.join(", "),
      guidelines: f.guidelines.join("\n"),
      evidence: f.evidenceNotes
    });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/facts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: editing?.id,
          brand: form.brand,
          productName: form.productName,
          approvedClaims: form.approved.split(",").map((c) => c.trim()).filter(Boolean),
          prohibitedClaims: form.prohibited.split(",").map((c) => c.trim()).filter(Boolean),
          guidelines: form.guidelines.split("\n").map((g) => g.trim()).filter(Boolean),
          evidenceNotes: form.evidence
        })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "save failed");
      setMsg(`Published to the DKG: ${j.facts.ual ?? "local evidence"}`);
      setEditing(null);
      setForm({ brand: "", productName: "", approved: "", prohibited: "", guidelines: "", evidence: "" });
      const r2 = await fetch("/api/facts");
      setFactsList((await r2.json()).facts);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-emerald-700">Brand governance</p>
        <h1 className="font-display mt-1.5 text-3xl font-semibold tracking-tight">Products & verified facts</h1>
        <p className="mt-1.5 max-w-2xl text-[13.5px] text-muted-foreground">
          Approved and prohibited advertising claims live here as Knowledge Assets. The
          preflight engine refuses campaigns that state anything unverified.
        </p>
      </FadeIn>

      <FadeIn delay={0.05}>
        <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="text-[14.5px] font-semibold">{editing ? `Editing ${editing.brand} ${editing.productName}` : "Publish new product facts"}</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[12px] text-muted-foreground">Brand</Label>
              <Input value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} placeholder="Verdi Steps" className="rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12px] text-muted-foreground">Product</Label>
              <Input value={form.productName} onChange={(e) => setForm((f) => ({ ...f, productName: e.target.value }))} placeholder="TerraRunner" className="rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12px] text-muted-foreground">Approved claims (comma-separated)</Label>
              <Input value={form.approved} onChange={(e) => setForm((f) => ({ ...f, approved: e.target.value }))} placeholder="made with recycled materials" className="rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12px] text-muted-foreground">Prohibited claims (comma-separated)</Label>
              <Input value={form.prohibited} onChange={(e) => setForm((f) => ({ ...f, prohibited: e.target.value }))} placeholder="waterproof" className="rounded-xl" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-[12px] text-muted-foreground">Brand guidelines (one per line)</Label>
              <Textarea value={form.guidelines} onChange={(e) => setForm((f) => ({ ...f, guidelines: e.target.value }))} rows={3} placeholder={"Earthy, natural palette.\nNo aggressive superlatives."} className="rounded-xl" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-[12px] text-muted-foreground">Evidence notes (where the facts come from)</Label>
              <Input value={form.evidence} onChange={(e) => setForm((f) => ({ ...f, evidence: e.target.value }))} placeholder="Product spec sheet v3.2; certification FR-0921" className="rounded-xl" />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={save} disabled={busy || !form.brand.trim() || !form.productName.trim()} className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600">
              <ShieldCheck className="h-4 w-4" /> {busy ? "Publishing…" : "Publish to DKG"}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={() => { setEditing(null); setForm({ brand: "", productName: "", approved: "", prohibited: "", guidelines: "", evidence: "" }); }} className="rounded-full">
                Cancel
              </Button>
            )}
            {msg && <p className="font-mono text-[11px] text-muted-foreground">{msg}</p>}
          </div>
        </div>
      </FadeIn>

      <Stagger className="grid gap-4 md:grid-cols-2">
        {(factsList ?? []).map((f) => (
          <StaggerItem key={f.id}>
            <div className="h-full rounded-2xl border border-border bg-card p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[14.5px] font-semibold">{f.brand} {f.productName}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">{f.id}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => startEdit(f)} className="h-7 rounded-full px-2.5 text-[11.5px]">
                  <Plus className="h-3 w-3" /> Edit
                </Button>
              </div>
              <div className="mt-3 space-y-2 text-[12.5px]">
                <p><span className="text-emerald-700 dark:text-emerald-400">approved:</span> {f.approvedClaims.join(", ") || "—"}</p>
                <p><span className="text-rose-600 dark:text-rose-400">prohibited:</span> {f.prohibitedClaims.join(", ") || "—"}</p>
                {f.guidelines.length > 0 && <p className="text-muted-foreground">guidelines: {f.guidelines.join(" · ")}</p>}
                {f.ual && <p className="truncate font-mono text-[10px] text-muted-foreground">{f.ual}</p>}
              </div>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
      {factsList && factsList.length === 0 && (
        <Badge variant="outline" className="rounded-full">No product facts yet — publish the first set above.</Badge>
      )}
    </div>
  );
}
