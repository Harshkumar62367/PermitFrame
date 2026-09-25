import Image from "next/image";
import Link from "next/link";
import { Children, isValidElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

function resolveDocsHref(href: string): string {
  if (href.startsWith("../public/docs/")) {
    return href.replace("../public/docs/", "/docs/");
  }
  if (href.startsWith("./") && href.endsWith(".md")) {
    return `/docs/${href.slice(2, -3)}`;
  }
  return href;
}

function DocsImage({ src, alt }: { src?: string; alt?: string }) {
  if (typeof src !== "string") return null;
  const resolved = resolveDocsHref(src);
  const description = alt?.trim() || "PermitFrame documentation screenshot";
  return (
    <figure className="my-8 overflow-hidden rounded-2xl border border-border bg-card shadow-sm shadow-black/[0.03] dark:bg-[#141816] dark:shadow-none">
      <Image src={resolved} alt={description} width={1440} height={900} sizes="(min-width: 1024px) 720px, 100vw" className="h-auto w-full" />
      <figcaption className="border-t border-border px-4 py-3 text-xs leading-5 text-muted-foreground">
        {description}
      </figcaption>
    </figure>
  );
}

function DocsInlineImage({ src, alt }: { src?: string; alt?: string }) {
  if (typeof src !== "string") return null;
  return (
    <Image
      src={resolveDocsHref(src)}
      alt={alt?.trim() || "PermitFrame documentation screenshot"}
      width={1440}
      height={900}
      sizes="100vw"
      className="inline-block h-auto max-w-full align-middle"
    />
  );
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-balance text-3xl font-semibold leading-tight tracking-[-0.035em] sm:text-4xl">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-12 border-t border-border pt-8 text-xl font-semibold tracking-[-0.02em] sm:text-2xl">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-8 text-base font-semibold tracking-[-0.01em] sm:text-lg">
      {children}
    </h3>
  ),
  h4: ({ children }) => <h4 className="mt-6 text-sm font-semibold">{children}</h4>,
  p: ({ children }) => {
    const nodes = Children.toArray(children);
    if (nodes.length === 1 && isValidElement<{ src?: string; alt?: string }>(nodes[0]) && nodes[0].type === "img") {
      return <DocsImage src={nodes[0].props.src} alt={nodes[0].props.alt} />;
    }
    return <p className="mt-4 text-[15px] leading-7 text-foreground/85">{children}</p>;
  },
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic text-foreground/90">{children}</em>,
  ul: ({ children }) => <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] leading-7 text-foreground/85 marker:text-emerald-500">{children}</ul>,
  ol: ({ children }) => <ol className="mt-4 list-decimal space-y-2 pl-5 text-[15px] leading-7 text-foreground/85 marker:font-mono marker:text-xs marker:text-emerald-600 dark:marker:text-emerald-400">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mt-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.07] px-5 py-4 text-[14px] leading-6 text-foreground/85 [&>p]:mt-0">
      {children}
    </blockquote>
  ),
  a: ({ href, children, ...props }) => {
    if (!href) return <span {...props}>{children}</span>;
    const resolved = resolveDocsHref(href);
    if (resolved.startsWith("/")) {
      return (
        <Link href={resolved} className="font-medium text-emerald-700 underline decoration-emerald-500/35 underline-offset-4 transition hover:decoration-emerald-500 dark:text-emerald-300">
          {children}
        </Link>
      );
    }
    return (
      <a href={resolved} className="font-medium text-emerald-700 underline decoration-emerald-500/35 underline-offset-4 transition hover:decoration-emerald-500 dark:text-emerald-300" {...props}>
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => <DocsInlineImage src={typeof src === "string" ? src : undefined} alt={alt} />,
  table: ({ children }) => (
    <div className="my-7 overflow-x-auto rounded-2xl border border-border">
      <table className="w-full min-w-[620px] border-collapse text-left text-[13px] leading-6">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/70 text-foreground">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-border bg-card text-foreground/80">{children}</tbody>,
  tr: ({ children }) => <tr className="align-top">{children}</tr>,
  th: ({ children }) => <th className="px-4 py-3 font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-4 py-3">{children}</td>,
  code: ({ children, className }) => (
    <code className={className ? className : "rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.88em] text-foreground"}>
      {children}
    </code>
  ),
  pre: ({ children }) => <pre className="my-6 overflow-x-auto rounded-2xl border border-border bg-[#0c110f] p-4 text-sm text-emerald-100">{children}</pre>,
  hr: () => <hr className="my-10 border-border" />
};

type DocsSection =
  | { kind: "markdown"; source: string }
  | { kind: "details"; summary: string; source: string };

/**
 * Split a deliberately small docs-only disclosure syntax without enabling
 * raw HTML in Markdown. Native <details> is accessible without client JS.
 *
 * :::details A concise summary
 * Markdown body
 * :::
 */
function splitDocsSections(source: string): DocsSection[] {
  const sections: DocsSection[] = [];
  const plain: string[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^:::details\s+(.+?)\s*$/.exec(lines[index]);
    if (!match) {
      plain.push(lines[index]);
      continue;
    }
    const end = lines.findIndex((line, offset) => offset > index && /^:::\s*$/.test(line));
    if (end < 0) {
      plain.push(lines[index]);
      continue;
    }
    if (plain.join("\n").trim()) sections.push({ kind: "markdown", source: plain.join("\n") });
    plain.length = 0;
    sections.push({ kind: "details", summary: match[1], source: lines.slice(index + 1, end).join("\n") });
    index = end;
  }
  if (plain.join("\n").trim()) sections.push({ kind: "markdown", source: plain.join("\n") });
  return sections;
}

function MarkdownBody({ source }: { source: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{source}</ReactMarkdown>;
}

export function DocsMarkdown({ source }: { source: string }) {
  return splitDocsSections(source).map((section, index) => {
    if (section.kind === "markdown") return <MarkdownBody key={index} source={section.source} />;
    return (
      <details key={index} className="group mt-6 rounded-2xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15px] font-semibold text-foreground marker:content-none">
          {section.summary}
          <span aria-hidden className="text-emerald-600 transition-transform group-open:rotate-45 dark:text-emerald-400">+</span>
        </summary>
        <div className="border-t border-border px-5 pb-5 [&>p]:mt-4 [&>ul]:mt-4">
          <MarkdownBody source={section.source} />
        </div>
      </details>
    );
  });
}
