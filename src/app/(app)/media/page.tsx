"use client";

import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";
import type { SourceMedia } from "@/server/types";

export default function MediaLibraryPage() {
  const [media, setMedia] = useState<SourceMedia[] | null>(null);
  const [form, setForm] = useState({ title: "", url: "", type: "image" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/media")
      .then((r) => r.json())
      .then((d) => setMedia(d.media))
      .catch(() => setMedia([]));
  }, []);

  async function register() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form)
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "failed");
      setMsg(`Registered ${j.media.id}${j.media.ual ? ` — ${j.media.ual}` : ""}`);
      setForm({ title: "", url: "", type: "image" });
      const r2 = await fetch("/api/media");
      setMedia((await r2.json()).media);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-emerald-700">Creator assets</p>
        <h1 className="font-display mt-1.5 text-3xl font-semibold tracking-tight">Media library</h1>
        <p className="mt-1.5 max-w-2xl text-[13.5px] text-muted-foreground">
          Consented source assets registered as Knowledge Assets (reference URL + content
          hash — the bytes stay with the creator).
        </p>
      </FadeIn>

      <FadeIn delay={0.05}>
        <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="text-[14.5px] font-semibold">Register a source asset</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_2fr_140px_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label className="text-[12px] text-muted-foreground">Title</Label>
              <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Maya — rooftop vertical" className="rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12px] text-muted-foreground">Public URL (https)</Label>
              <Input value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://…" className="rounded-xl font-mono text-[12px]" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12px] text-muted-foreground">Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v }))}>
                <SelectTrigger className="w-full rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="image">image</SelectItem>
                  <SelectItem value="video">video</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={register} disabled={busy || !form.url.trim().startsWith("http")} className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600">
              <Link2 className="h-4 w-4" /> {busy ? "Registering…" : "Register"}
            </Button>
          </div>
          {msg && <p className="mt-3 font-mono text-[11px] text-muted-foreground">{msg}</p>}
        </div>
      </FadeIn>

      <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(media ?? []).map((m) => (
          <StaggerItem key={m.id}>
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              {m.type === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.url} alt={m.title} className="aspect-video w-full object-cover" />
              ) : (
                <video src={m.url} className="aspect-video w-full bg-black object-contain" />
              )}
              <div className="p-4">
                <p className="text-[13.5px] font-medium leading-snug">{m.title}</p>
                <p className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground">{m.id} · {m.type}</p>
                {m.ual && <p className="mt-0.5 truncate font-mono text-[10px] text-emerald-700 dark:text-emerald-400">{m.ual}</p>}
              </div>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </div>
  );
}
