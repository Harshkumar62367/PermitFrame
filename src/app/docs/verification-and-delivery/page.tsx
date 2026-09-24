import type { Metadata } from "next";
import { DocsMarkdown } from "@/components/docs/docs-markdown";
import { getDocsSource } from "@/components/docs/docs-source";

export const metadata: Metadata = {
  title: "Verification and delivery",
  description: "Review PermitFrame outputs, understand owner approval and advisory client feedback, and prepare public proof."
};

export default function VerificationAndDeliveryPage() {
  return <DocsMarkdown source={getDocsSource("verification-and-delivery")} />;
}
