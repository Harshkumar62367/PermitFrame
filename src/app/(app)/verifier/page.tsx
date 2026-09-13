"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FadeIn } from "@/components/motion-primitives";

export default function VerifierPage() {
  const router = useRouter();
  const [ref, setRef] = useState("");

  return (
    <div className="space-y-6">
      <FadeIn>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-emerald-700">Trust & proof</p>
        <h1 className="font-display mt-1.5 text-3xl font-semibold tracking-tight">Verifier</h1>
        <p className="mt-1.5 max-w-2xl text-[13.5px] text-muted-foreground">
          Resolve any receipt id, campaign id, or UAL to its public verification page — the same
          view your clients see.
        </p>
      </FadeIn>
      <FadeIn delay={0.05}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ref.trim()) router.push(`/verify/${encodeURIComponent(ref.trim())}`);
          }}
          className="flex max-w-xl gap-2"
        >
          <div className="relative flex-1">
            <SearchCheck className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="rcpt_… · campaign_… · did:dkg:…"
              className="rounded-xl pl-9 font-mono text-[13px]"
            />
          </div>
          <Button type="submit" className="rounded-xl bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600">
            Verify
          </Button>
        </form>
      </FadeIn>
    </div>
  );
}
