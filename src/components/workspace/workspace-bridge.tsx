"use client";

import { usePrivy } from "@privy-io/react-auth";
import { usePermitFrameSession } from "@/components/privy-provider";
import { WorkspaceProvider } from "./workspace-context";

/**
 * Boundary bridge: reads real Privy + server-session state once and injects
 * it as plain props/context. Sidebar and drawers never import Privy themselves.
 * The workspace identity is the real server workspace.
 */
export function WorkspaceBridge({ children }: { children: React.ReactNode }) {
  const { authenticated, user } = usePrivy();
  const { status, workspaceName } = usePermitFrameSession();

  const identity = user?.email?.address ?? user?.google?.name ?? user?.wallet?.address ?? null;
  const live = status === "ready";
  return (
    <WorkspaceProvider
      workspace={{
        id: workspaceName ?? "workspace",
        name: workspaceName ?? "Workspace",
        mode: live ? "live" : "loading",
        detail: live ? (identity ? `Member · ${identity}` : "Member workspace") : "Sign in to open your workspace"
      }}
      account={
        authenticated && identity
          ? {
              label: identity.length > 22 ? `${identity.slice(0, 22)}…` : identity,
              fullLabel: identity,
              walletAddress: user?.wallet?.address
            }
          : null
      }
    >
      {children}
    </WorkspaceProvider>
  );
}
