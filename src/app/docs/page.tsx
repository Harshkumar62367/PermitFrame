import type { Metadata } from "next";
import { DocsMarkdown } from "@/components/docs/docs-markdown";
import { getDocsSource } from "@/components/docs/docs-source";

export const metadata: Metadata = {
  title: "Guide",
  description: "Understand PermitFrame and choose the right first-run guide."
};

export default function DocsIndexPage() {
  return <DocsMarkdown source={getDocsSource("index")} />;
}
