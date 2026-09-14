import { AppAccessGate } from "@/components/app-access-gate";
import { WorkspaceBridge } from "@/components/workspace/workspace-bridge";
import { BootstrapProvider } from "@/lib/bootstrap";
import { AppShell } from "@/components/app-shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppAccessGate>
      <WorkspaceBridge>
        <BootstrapProvider>
          <AppShell>{children}</AppShell>
        </BootstrapProvider>
      </WorkspaceBridge>
    </AppAccessGate>
  );
}
