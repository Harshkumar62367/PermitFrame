import type { Metadata } from "next";
import { DocsMarkdown } from "@/components/docs/docs-markdown";
import { getDocsSource } from "@/components/docs/docs-source";

export const metadata: Metadata = {
  title: "Film and finishing",
  description: "Choose between a PermitFrame short clip and Campaign Film, then review narration, burned captions, and current limitations."
};

export default function FilmAndFinishingPage() {
  return <DocsMarkdown source={getDocsSource("film-and-finishing")} />;
}
