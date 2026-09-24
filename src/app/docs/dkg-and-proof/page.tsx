import type { Metadata } from "next";
import { DocsMarkdown } from "@/components/docs/docs-markdown";
import { getDocsSource } from "@/components/docs/docs-source";

export const metadata: Metadata = {
  title: "DKG and proof",
  description: "Understand PermitFrame's OriginTrail DKG knowledge, three proof states, and Base Sepolia public testnet evidence."
};

export default function DkgAndProofPage() {
  return <DocsMarkdown source={getDocsSource("dkg-and-proof")} />;
}
