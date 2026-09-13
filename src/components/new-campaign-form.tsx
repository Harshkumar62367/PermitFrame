"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

const PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"];

export function NewCampaignForm({ onCreated }: { onCreated?: (id: string) => void }) {
  const router = useRouter();
  const [form, setForm] = useState({
    title: "",
    platform: "instagram",
    country: "",
    claims: "",
    transformation: "video",
    creativeBrief: ""
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (form.country.trim().length !== 2) return setError("Country must be a 2-letter code (e.g. GR).");
    if (!form.creativeBrief.trim()) return setError("A creative brief is required.");
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim() || `${form.platform} campaign — ${form.country.toUpperCase()}`,
          platform: form.platform,
          country: form.country.trim().toUpperCase(),
          requestedClaims: form.claims.split(",").map((c) => c.trim()).filter(Boolean),
          transformation: form.transformation,
          creativeBrief: form.creativeBrief.trim()
        })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to create campaign");
      if (onCreated) onCreated(json.campaign.id);
      else router.push(`/campaigns/${json.campaign.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <h3 className="text-[15px] font-semibold tracking-tight">New campaign request</h3>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        It runs through DKG preflight the moment you create it — allowed or blocked, with reasons.
      </p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[12px] text-muted-foreground">Title (optional)</Label>
          <Input
            placeholder="Summer launch — reels"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            className="rounded-xl"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[12px] text-muted-foreground">Platform</Label>
          <Select value={form.platform} onValueChange={(v) => setForm((f) => ({ ...f, platform: v }))}>
            <SelectTrigger className="w-full rounded-xl"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PLATFORMS.map((p) => (
                <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[12px] text-muted-foreground">Country (2-letter)</Label>
          <Input
            placeholder="GR"
            maxLength={2}
            value={form.country}
            onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))}
            className="rounded-xl"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[12px] text-muted-foreground">Claims to advertise (comma-separated)</Label>
          <Input
            placeholder="made with recycled materials"
            value={form.claims}
            onChange={(e) => setForm((f) => ({ ...f, claims: e.target.value }))}
            className="rounded-xl"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[12px] text-muted-foreground">Output</Label>
          <Select value={form.transformation} onValueChange={(v) => setForm((f) => ({ ...f, transformation: v }))}>
            <SelectTrigger className="w-full rounded-xl"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="video">Video pack (9:16 + 1:1 + 16:9 + motion)</SelectItem>
              <SelectItem value="image">Image pack (9:16 + 1:1 + 16:9)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-[12px] text-muted-foreground">Creative brief</Label>
          <Textarea
            placeholder="Golden-hour rooftop shot of the TerraRunner with the Athens skyline behind…"
            rows={3}
            value={form.creativeBrief}
            onChange={(e) => setForm((f) => ({ ...f, creativeBrief: e.target.value }))}
            className="rounded-xl"
          />
        </div>
      </div>
      {error && <p className="mt-3 text-[12.5px] text-rose-600">{error}</p>}
      <Button
        onClick={submit}
        disabled={busy}
        className="mt-5 rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600"
      >
        {busy ? "Running preflight…" : "Create & run policy check"}
      </Button>
    </div>
  );
}
