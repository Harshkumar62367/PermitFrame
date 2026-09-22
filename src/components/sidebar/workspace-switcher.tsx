"use client";

import { useRef, useState } from "react";
import { Check, ChevronDown, Copy, FlaskConical } from "lucide-react";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { SidebarPopover } from "./sidebar-popover";
import { cn } from "@/lib/utils";

/**
 * Compact workspace row (~56px): icon, truncated name, chevron, wallet
 * secondary line. Opens a functional popover with membership detail,
 * full wallet address and copy - never a dead control.
 */
export function WorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { workspace, account } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const wallet = account?.walletAddress ?? null;
  const shortWallet = wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : null;

  async function copyWallet() {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  const tooltip = `${workspace.name}${shortWallet ? ` · ${wallet}` : ""}`;

  if (collapsed) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`Workspace: ${workspace.name}. Open workspace details.`}
          title={tooltip}
          className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-emerald-600/10 text-emerald-700 ring-1 ring-emerald-600/20 transition hover:bg-emerald-600/15 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/20"
        >
          <FlaskConical className="h-4 w-4" aria-hidden />
        </button>
        <WorkspaceDetailsPopover
          open={open}
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          rail
          wallet={wallet}
          copied={copied}
          onCopyWallet={() => void copyWallet()}
        />
      </>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Workspace: ${workspace.name}. Open workspace details.`}
        title={tooltip}
        className="flex min-h-[52px] w-full min-w-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition hover:bg-accent"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-600/10 text-emerald-700 ring-1 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/20">
          <FlaskConical className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-tight text-foreground dark:text-white">
              {workspace.name}
            </span>
            <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition", open && "rotate-180")} aria-hidden />
          </span>
          <span className="block truncate font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground dark:text-white/40">
            {shortWallet ?? workspace.detail ?? "Member workspace"}
          </span>
        </span>
      </button>
      <WorkspaceDetailsPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        wallet={wallet}
        copied={copied}
        onCopyWallet={() => void copyWallet()}
      />
    </>
  );
}

function WorkspaceDetailsPopover({
  open,
  onClose,
  triggerRef,
  rail = false,
  wallet,
  copied,
  onCopyWallet
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  rail?: boolean;
  wallet: string | null;
  copied: boolean;
  onCopyWallet: () => void;
}) {
  const { workspace, account } = useWorkspace();
  return (
    <SidebarPopover
      open={open}
      onClose={onClose}
      label="Workspace details"
      triggerRef={triggerRef}
      className={rail ? "left-[88px] top-16" : "left-[264px] top-32"}
    >
      <div className="px-3.5 pb-2 pt-3">
        <p className="break-words text-[14px] font-semibold tracking-tight text-foreground dark:text-white">
          {workspace.name}
        </p>
        <p className="mt-0.5 text-[12px] text-muted-foreground dark:text-white/55">
          {workspace.detail ?? "Member workspace"}
        </p>
      </div>
      <div className="mx-2 mb-1 mt-2 border-t border-border dark:border-white/10" aria-hidden />
      <div className="px-3.5 py-2">
        <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground dark:text-white/40">Member</p>
        <p className="mt-1 truncate text-[12.5px] text-foreground dark:text-white" title={account?.fullLabel ?? account?.label}>
          {account?.label ?? "Signed-in member"}
        </p>
      </div>
      <div className="flex items-center justify-between gap-2 px-3.5 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground dark:text-white/55" title={wallet ?? "No account ID linked"}>
          {wallet ?? "No account ID linked"}
        </span>
        {wallet && (
          <button
            type="button"
            onClick={onCopyWallet}
            aria-label={`Copy account ID ${wallet}`}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground dark:hover:text-white"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </SidebarPopover>
  );
}
