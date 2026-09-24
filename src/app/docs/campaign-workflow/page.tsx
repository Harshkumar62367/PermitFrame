import type { Metadata } from "next";
import { DocsMarkdown } from "@/components/docs/docs-markdown";
import { getDocsSource } from "@/components/docs/docs-source";

export const metadata: Metadata = {
  title: "Campaign workflow",
  description: "Learn how PermitFrame checks rights and brand rules, builds a production plan, generates through Livepeer, and reviews outputs."
};

export default function CampaignWorkflowPage() {
  return <DocsMarkdown source={getDocsSource("campaign-workflow")} />;
}
