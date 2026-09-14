"use client";

import { FlaskConical } from "lucide-react";
import { useWorkspace, type WorkspaceIdentity } from "./workspace-context";
import { cn } from "@/lib/utils";

/**
 * Presentational workspace switcher seam. Today there is one workspace;
 * tomorrow the menu items inject via props without rewriting the sidebar.
 * In demo mode the identity is honest — never a fake login button.
 */
export function WorkspaceSwitcher({
  workspace,
  className
}: {
  workspace?: WorkspaceIdentity;
  className?: string;
}) {
  const ctx = useWorkspace();
  const ws = workspace ?? ctx.workspace;
  return (
    <div className={cn("min-w-0", className)} aria-label="Workspace">
      <div className="flex min-w-0 items-center gap-2.5 rounded-xl px-1 py-1">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/20">
          <FlaskConical className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold leading-tight text-white">{ws.name}</span>
          <span className="block truncate font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/40">
            {ws.mode === "demo" ? "Demo · " : ""}
            {ws.detail ?? (ws.mode === "demo" ? "Seeded demo data" : "Member workspace")}
          </span>
        </span>
      </div>
    </div>
  );
}
