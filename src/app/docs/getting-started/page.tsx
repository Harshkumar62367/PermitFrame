import type { Metadata } from "next";
import { DocsMarkdown } from "@/components/docs/docs-markdown";
import { getDocsSource } from "@/components/docs/docs-source";

export const metadata: Metadata = {
  title: "Getting started",
  description: "Set up a creator, media, consent, brand rules, and a first permission-aware PermitFrame campaign."
};

export default function GettingStartedPage() {
  return <DocsMarkdown source={getDocsSource("getting-started")} />;
}
