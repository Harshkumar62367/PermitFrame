"use client";

import { useMemo, useState } from "react";
import { Lock, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiPatch } from "@/lib/api";
import { countryName } from "@/lib/countries";
import { useWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { Campaign, PermissionPassport, ProductFacts } from "@/server/types";

const PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"];

interface BriefPanelProps {
  campaign: Campaign;
  passport: PermissionPassport | null;
  productFacts: ProductFacts | null;
  onChanged: () => Promise<void>;
}

interface Draft {
  title: string;
  objective: string;
  primaryMessage: string;
  claims: string;
  visualDirection: string;
  creativeBrief: string;
  platform: string;
  country: string;
  transformation: string;
  sourceMediaId: string;
}

function draftFrom(campaign: Campaign): Draft {
  const r = campaign.request;
  return {
    title: campaign.title,
    objective: r.objective ?? "",
    primaryMessage: r.primaryMessage ?? "",
    claims: r.requestedClaims.join(", "),
    visualDirection: r.visualDirection ?? "",
    creativeBrief: r.creativeBrief,
    platform: r.platform,
    country: r.country,
    transformation: r.transformation,
    sourceMediaId: campaign.sourceMediaId
  };
}

/**
 * Left panel: the approved brief plus editable production controls.
 * Editorial fields (title, objective, message, direction, brief) save
 * directly. Rights inputs (platform, country, claims, format) re-run the
 * rights check on save and can re-block the campaign - the studio then
 * locks generation via the existing allow-gate. Structural inputs lock
 * once production has started; platform expansion moves to variants.
 */
export function BriefPanel({ campaign, passport, productFacts, onChanged }: BriefPanelProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(campaign));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const snapshot = useWorkspaceSnapshot();
  const mediaOptions = useMemo(() => snapshot.data?.sourceMedia ?? [], [snapshot.data]);

  const locked = campaign.jobs.length > 0;
  const baseline = draftFrom(campaign);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
    setNotice(null);
  }

  function startEdit() {
    setDraft(draftFrom(campaign));
    setError(null);
    setNotice(null);
    setEditing(true);
  }

  async function save() {
    if (busy || !dirty) return;
    if (!draft.country) {
      setError("Choose a territory - only this permission's territories are listed.");
      return;
    }
    if (draft.creativeBrief.trim().length < 12) {
      setError("Give the brief a little more to work with (12+ characters).");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const j = await apiPatch<{ campaign: Campaign }>(`/api/campaigns/${campaign.id}`, {
        title: draft.title.trim(),
        creativeBrief: draft.creativeBrief.trim(),
        objective: draft.objective.trim(),
        primaryMessage: draft.primaryMessage.trim(),
        visualDirection: draft.visualDirection.trim(),
        requestedClaims: draft.claims.split(",").map((c) => c.trim()).filter(Boolean),
        platform: draft.platform,
        country: draft.country.trim().toUpperCase(),
        transformation: draft.transformation,
        sourceMediaId: draft.sourceMediaId
      });
      setEditing(false);
      const blocked = j.campaign.preflight?.decision === "block";
      setNotice(
        blocked
          ? "Saved - but the rights re-check now blocks this campaign. Generation is locked until the rights issue is fixed."
          : "Saved. Rights inputs were re-checked against current approvals."
      );
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed. Your edits are preserved.");
    } finally {
      setBusy(false);
    }
  }

  const field = "space-y-1.5";
  const label = "text-[12px] text-muted-foreground";
  const input = "rounded-xl";

  return (
    <section aria-label="Brief and production controls" className="flex h-full flex-col rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold tracking-tight">Brief & controls</h3>
        {!editing ? (
          <Button variant="outline" size="sm" onClick={startEdit} className="h-7 rounded-full px-2.5 text-[11.5px]">
            <PencilLine className="h-3 w-3" aria-hidden /> Edit
          </Button>
        ) : (
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy} className="h-7 rounded-full px-2.5 text-[11.5px]">
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={busy || !dirty}
              aria-busy={busy}
              title={!dirty ? "Change a field to enable saving" : undefined}
              className="h-7 rounded-full bg-emerald-700 px-3 text-[11.5px] font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
            >
              {busy ? "Saving…" : "Save brief"}
            </Button>
          </div>
        )}
      </div>

      {error && <p role="alert" className="mt-3 break-words text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}
      {notice && <p role="status" className="mt-3 break-words text-[12px] text-emerald-700 dark:text-emerald-300">{notice}</p>}

      {!editing ? (
        <dl className="mt-4 space-y-3.5 text-[13px]">
          <div>
            <dt className={label}>Objective</dt>
            <dd className="mt-0.5 font-medium leading-snug">{campaign.request.objective?.trim() || campaign.title}</dd>
          </div>
          <div>
            <dt className={label}>Primary message</dt>
            <dd className="mt-0.5 leading-relaxed text-foreground/85">{campaign.request.primaryMessage?.trim() || "-"}</dd>
          </div>
          <div>
            <dt className={label}>Approved claims</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {(campaign.preflight?.allowedClaims ?? []).length > 0 ? (
                (campaign.preflight?.allowedClaims ?? []).map((c) => (
                  <span key={c} className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11.5px] text-emerald-700 ring-1 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800">
                    {c}
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground">No verified claims - permission check passed on rights alone</span>
              )}
            </dd>
          </div>
          <div>
            <dt className={label}>Visual direction</dt>
            <dd className="mt-0.5 leading-relaxed text-foreground/85">{campaign.request.visualDirection?.trim() || "-"}</dd>
          </div>
          <div>
            <dt className={label}>Creative brief</dt>
            <dd className="mt-0.5 italic leading-relaxed text-muted-foreground">“{campaign.request.creativeBrief}”</dd>
          </div>
          <div className="grid grid-cols-2 gap-3 border-t border-border pt-3.5">
            <div>
              <dt className={label}>Platform</dt>
              <dd className="mt-0.5 font-mono text-[12px] capitalize">{campaign.request.platform}</dd>
            </div>
            <div>
              <dt className={label}>Territory</dt>
              <dd className="mt-0.5 font-mono text-[12px]">{campaign.request.country}</dd>
            </div>
            <div>
              <dt className={label}>Format</dt>
              <dd className="mt-0.5 font-mono text-[12px] capitalize">{campaign.request.transformation} pack</dd>
            </div>
            <div>
              <dt className={label}>Rights window</dt>
              <dd className="mt-0.5 font-mono text-[12px]">{passport ? `to ${passport.validUntil}` : "-"}</dd>
            </div>
          </div>
          {productFacts && (
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              Brand rules: {productFacts.brand} {productFacts.productName}
              {productFacts.prohibitedClaims.length > 0 && ` - never claim: ${productFacts.prohibitedClaims.join(", ")}`}
            </p>
          )}
        </dl>
      ) : (
        <div className="mt-4 space-y-3.5">
          <div className={field}>
            <Label htmlFor="studio-title" className={label}>Campaign name</Label>
            <Input id="studio-title" value={draft.title} onChange={(e) => set("title", e.target.value)} className={input} />
          </div>
          <div className={field}>
            <Label htmlFor="studio-objective" className={label}>Objective</Label>
            <Input id="studio-objective" value={draft.objective} onChange={(e) => set("objective", e.target.value)} placeholder="What should this campaign achieve?" className={input} />
          </div>
          <div className={field}>
            <Label htmlFor="studio-message" className={label}>Primary message</Label>
            <Textarea id="studio-message" value={draft.primaryMessage} onChange={(e) => set("primaryMessage", e.target.value)} rows={2} placeholder="The one thing viewers should remember" className={input} />
          </div>
          <div className={field}>
            <Label htmlFor="studio-claims" className={label}>Advertised claims (comma-separated)</Label>
            <Input id="studio-claims" value={draft.claims} onChange={(e) => set("claims", e.target.value)} placeholder="made with recycled materials" className={input} />
            <p className="text-[11px] text-muted-foreground">Claims re-run the permission check on save - unverified claims block generation.</p>
          </div>
          <div className={field}>
            <Label htmlFor="studio-direction" className={label}>Visual direction</Label>
            <Textarea id="studio-direction" value={draft.visualDirection} onChange={(e) => set("visualDirection", e.target.value)} rows={2} placeholder="Palette, mood, composition notes" className={input} />
          </div>
          <div className={field}>
            <Label htmlFor="studio-brief" className={label}>Creative brief</Label>
            <Textarea id="studio-brief" value={draft.creativeBrief} onChange={(e) => set("creativeBrief", e.target.value)} rows={3} className={input} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className={field}>
              <Label htmlFor="studio-platform" className={label}>Platform</Label>
              <Select value={draft.platform} onValueChange={(v) => set("platform", v)} disabled={locked}>
                <SelectTrigger id="studio-platform" className="w-full rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className={field}>
              <Label htmlFor="studio-country" className={label}>Territory</Label>
              <Select value={draft.country || undefined} onValueChange={(v) => set("country", v)} disabled={locked || !passport}>
                <SelectTrigger id="studio-country" className="w-full rounded-xl"><SelectValue placeholder={passport ? "Choose a permitted territory" : "No permission"} /></SelectTrigger>
                <SelectContent>
                  {(passport?.countries ?? []).map((c) => (
                    <SelectItem key={c} value={c}>{countryName(c)} · {c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className={field}>
              <Label htmlFor="studio-format" className={label}>Format</Label>
              <Select value={draft.transformation} onValueChange={(v) => set("transformation", v)} disabled={locked}>
                <SelectTrigger id="studio-format" className="w-full rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="video">Video pack</SelectItem>
                  <SelectItem value="image">Image pack</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={field}>
              <Label htmlFor="studio-source" className={label}>Source media</Label>
              <Select value={draft.sourceMediaId} onValueChange={(v) => set("sourceMediaId", v)} disabled={locked || mediaOptions.length === 0}>
                <SelectTrigger id="studio-source" className="w-full rounded-xl"><SelectValue placeholder="Select source" /></SelectTrigger>
                <SelectContent>
                  {mediaOptions.map((m) => <SelectItem key={m.id} value={m.id}>{m.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {locked && (
            <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Platform, territory, format and source lock once production starts - clone a platform variant below for other platforms.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
