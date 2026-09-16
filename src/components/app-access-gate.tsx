"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePermitFrameSession } from "@/components/privy-provider";

/**
 * Backstop redirect only — never a loading screen. The (app) server layout
 * already authorized this render from the HttpOnly session cookie, so
 * children mount immediately. This handles the single edge case the server
 * cannot see: the cookie disappearing mid-session on the client.
 */
export function AppAccessGate({ children }: { children: React.ReactNode }) {
  const { status } = usePermitFrameSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "signed-out") router.replace("/");
  }, [router, status]);

  return <>{children}</>;
}
