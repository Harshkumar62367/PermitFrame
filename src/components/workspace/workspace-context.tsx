"use client";

import { createContext, useContext } from "react";

/** Future Privy data injects through here - sidebar never imports Privy directly. */
export interface WorkspaceIdentity {
  id: string;
  name: string;
  mode: "loading" | "live";
  detail?: string;
}

export interface AccountIdentity {
  label: string;
  fullLabel?: string;
  walletAddress?: string;
}

interface WorkspaceContextValue {
  workspace: WorkspaceIdentity;
  account: AccountIdentity | null;
}

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspace: { id: "workspace", name: "Workspace", mode: "loading", detail: "Loading workspace" },
  account: null
});

export function WorkspaceProvider({
  workspace,
  account,
  children
}: {
  workspace?: WorkspaceIdentity;
  account?: AccountIdentity | null;
  children: React.ReactNode;
}) {
  return (
    <WorkspaceContext.Provider
      value={{
        workspace: workspace ?? { id: "workspace", name: "Workspace", mode: "loading", detail: "Loading workspace" },
        account: account ?? null
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  return useContext(WorkspaceContext);
}
