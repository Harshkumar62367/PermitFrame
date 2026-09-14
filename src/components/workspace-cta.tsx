"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { usePrivy } from "@privy-io/react-auth";
import { Button } from "@/components/ui/button";
import { usePermitFrameSession } from "@/components/privy-provider";

type WorkspaceCtaProps = {
  size?: "sm" | "lg";
  className?: string;
  label?: string;
};

/**
 * One clear landing-page action: enter the workspace. Authentication is an
 * implementation detail, not a competing top-level CTA.
 */
export function WorkspaceCta({ size = "sm", className, label = "Open workspace" }: WorkspaceCtaProps) {
  const { ready, authenticated, login } = usePrivy();
  const { status } = usePermitFrameSession();
  const router = useRouter();
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    if (requested && status === "ready") router.push("/workspace");
  }, [requested, router, status]);

  async function enterWorkspace() {
    setRequested(true);
    if (!ready || status === "loading") return;
    if (status === "ready") {
      router.push("/workspace");
      return;
    }
    if (!authenticated) await login();
  }

  const loading = requested && status === "loading";
  return (
    <Button onClick={() => void enterWorkspace()} disabled={!ready || loading} size={size} className={className}>
      {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
      {loading ? "Opening workspace…" : label}
    </Button>
  );
}
