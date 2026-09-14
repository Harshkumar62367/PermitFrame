"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { usePermitFrameSession } from "@/components/privy-provider";

export function AppAccessGate({ children }: { children: React.ReactNode }) {
  const { status, error } = usePermitFrameSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "signed-out") router.replace("/");
  }, [router, status]);

  if (status === "ready") return <>{children}</>;
  return (
    <div className="grid min-h-screen place-items-center bg-background px-6 text-center">
      <div>
        <LoaderCircle className="mx-auto h-6 w-6 animate-spin text-emerald-500" />
        <p className="mt-4 text-sm text-muted-foreground">{error ?? (status === "signed-out" ? "Returning to sign in…" : "Preparing your secure workspace…")}</p>
      </div>
    </div>
  );
}
