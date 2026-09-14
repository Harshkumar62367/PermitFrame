"use client";

import { usePrivy } from "@privy-io/react-auth";
import { usePermitFrameSession } from "@/components/privy-provider";
import { WorkspaceProvider } from "./workspace-context";

/**
 * Boundary bridge: reads real Privy state once and injects it as plain
 * props/context. Sidebar and drawers never import Privy themselves.
 */
export function WorkspaceBridge({ children }: { children: React.ReactNode }) {
  const { authenticated, user } = usePrivy();
  const { status } = usePermitFrameSession();

  const identity = user?.email?.address ?? user?.google?.name ?? user?.wallet?.address ?? null;
  return (
    <WorkspaceProvider
      workspace={{
        id: "demo",
        name: "Demo workspace",
        mode: "demo",
        detail: authenticated && status === "ready" ? `Member${identity ? ` · ${identity}` : ""}` : "Verdi Steps × Maya Chen"
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
