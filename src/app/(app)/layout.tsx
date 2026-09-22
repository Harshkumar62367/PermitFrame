import { redirect } from "next/navigation";
import { getCurrentSession } from "@/server/auth";
import { AppAccessGate } from "@/components/app-access-gate";
import { WorkspaceBridge } from "@/components/workspace/workspace-bridge";
import { AppShell } from "@/components/app-shell";

/**
 * Protected route group: the existing HttpOnly PermitFrame session is
 * checked on the server, so returning users get the app shell rendered
 * immediately - no full-screen client authentication waterfall.
 * Unauthenticated requests redirect safely to the landing page.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect("/");

  return (
    <AppAccessGate>
      <WorkspaceBridge>
        <AppShell>{children}</AppShell>
      </WorkspaceBridge>
    </AppAccessGate>
  );
}
