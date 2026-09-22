"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { establishSnapshotOwner, getQueryClient, purgePersistedWorkspaceSnapshot } from "@/components/query-provider";

type SessionStatus = "loading" | "ready" | "signed-out" | "error";
type PermitFrameSession = {
  status: SessionStatus;
  error: string | null;
  /** Real workspace name from the server session; null when signed out. */
  workspaceName: string | null;
  signOut: () => Promise<void>;
};
const SessionContext = createContext<PermitFrameSession | null>(null);

function SessionBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  // Server-confirmed authorization. Once the HttpOnly session cookie checks
  // out, it wins over Privy client state (which may lag or be signed out
  // while the server session is still valid).
  const [serverOk, setServerOk] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      // Fast path: a valid HttpOnly PermitFrame session cookie authorizes
      // immediately - no Privy wait, no session POST, no new database row.
      try {
        const check = await fetch("/api/auth/session", { credentials: "same-origin" });
        if (check.ok) {
          const data = (await check.json().catch(() => ({}))) as { workspace?: unknown };
          if (active) {
            setError(null);
            const owner = typeof data.workspace === "string" ? data.workspace.trim() : "";
            if (owner) {
              setWorkspaceName(owner);
            }
            setServerOk(true);
            setStatus("ready");
            // Session proved the workspace owner: restore that workspace's
            // persisted snapshot (or purge a previous owner's bytes).
            if (owner) establishSnapshotOwner(getQueryClient(), owner);
          }
          return;
        }
      } catch {
        // fall through to the Privy flow below
      }
      if (!ready) return;
      if (!authenticated) {
        if (active) {
          setStatus("signed-out");
          // No signed-in owner: drop any persisted bytes from a previous user.
          purgePersistedWorkspaceSnapshot(getQueryClient());
        }
        return;
      }
      // Slow path (first login, expired or missing cookie): establish the
      // server session once from the Privy access token.
      if (active) setStatus("loading");
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error("Privy did not return an access token.");
        const response = await fetch("/api/auth/session", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ email: user?.email?.address, displayName: user?.google?.name })
        });
        if (!response.ok) throw new Error("PermitFrame could not establish a secure workspace session.");
        const created = (await response.json().catch(() => ({}))) as { workspace?: unknown };
        if (active) {
          setError(null);
          const owner = typeof created.workspace === "string" ? created.workspace.trim() : "";
          if (owner) {
            setWorkspaceName(owner);
          }
          setServerOk(true);
          setStatus("ready");
          // Session proved the workspace owner: restore that workspace's
          // persisted snapshot (or purge a previous owner's bytes).
          if (owner) establishSnapshotOwner(getQueryClient(), owner);
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Sign-in failed.");
          setStatus("error");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [authenticated, getAccessToken, ready, user?.email?.address, user?.google?.name]);

  const effectiveStatus: SessionStatus = serverOk
    ? "ready"
    : !ready
      ? "loading"
      : !authenticated
        ? "signed-out"
        : status;
  const effectiveError = serverOk || authenticated ? error : null;
  const value = useMemo<PermitFrameSession>(() => ({
    status: effectiveStatus,
    error: effectiveError,
    workspaceName,
    signOut: async () => {
      // Drop every cached workspace row (memory + persisted) first: a new
      // signed-in user must never see the previous user's cached workspace.
      purgePersistedWorkspaceSnapshot(getQueryClient());
      await fetch("/api/auth/session", { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
      await logout();
      setServerOk(false);
      setWorkspaceName(null);
      setStatus("signed-out");
    }
  }), [effectiveError, effectiveStatus, logout, workspaceName]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function usePermitFrameSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("usePermitFrameSession must be used inside PermitFramePrivyProvider.");
  return session;
}

/**
 * Keeps Privy at the application boundary. The App ID is intentionally public;
 * the Privy app secret is never imported into browser code.
 */
export function PermitFramePrivyProvider({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    return (
      <SessionContext.Provider value={{ status: "signed-out", error: "Privy is not configured.", workspaceName: null, signOut: async () => undefined }}>
        {children}
      </SessionContext.Provider>
    );
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#10b981",
          landingHeader: "Welcome to PermitFrame",
          loginMessage: "Sign in to manage verified campaign production."
        }
      }}
    >
      <SessionBridge>{children}</SessionBridge>
    </PrivyProvider>
  );
}
