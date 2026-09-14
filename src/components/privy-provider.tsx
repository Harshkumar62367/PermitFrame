"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

type SessionStatus = "loading" | "ready" | "signed-out" | "error";
type PermitFrameSession = { status: SessionStatus; error: string | null; signOut: () => Promise<void> };
const SessionContext = createContext<PermitFrameSession | null>(null);

function SessionBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!ready || !authenticated) return;
    void (async () => {
      setStatus("loading");
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Privy did not return an access token.");
      const response = await fetch("/api/auth/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ email: user?.email?.address, displayName: user?.google?.name })
      });
      if (!response.ok) throw new Error("PermitFrame could not establish a secure workspace session.");
      if (active) { setError(null); setStatus("ready"); }
    })().catch((cause) => {
      if (active) { setError(cause instanceof Error ? cause.message : "Sign-in failed."); setStatus("error"); }
    });
    return () => { active = false; };
  }, [authenticated, getAccessToken, ready, user?.email?.address, user?.google?.name]);

  const effectiveStatus: SessionStatus = !ready ? "loading" : !authenticated ? "signed-out" : status;
  const effectiveError = authenticated ? error : null;
  const value = useMemo<PermitFrameSession>(() => ({
    status: effectiveStatus,
    error: effectiveError,
    signOut: async () => {
      await fetch("/api/auth/session", { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
      await logout();
      setStatus("signed-out");
    }
  }), [effectiveError, effectiveStatus, logout]);

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
      <SessionContext.Provider value={{ status: "signed-out", error: "Privy is not configured.", signOut: async () => undefined }}>
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
