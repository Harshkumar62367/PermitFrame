"use client";

import { ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
}

/**
 * First-class campaign imagery: source media when registered, else the latest
 * generated output. Monogram fallback when neither exists - never an empty box.
 */
export function CampaignThumbnail({
  src,
  title,
  brand,
  aspect = "16:9",
  className
}: {
  src: string | null;
  title: string;
  brand?: string;
  aspect?: "16:9" | "4:3";
  className?: string;
}) {
  if (!src) {
    return (
      <div
        aria-hidden
        className={cn(
          "grid w-full place-items-center bg-muted/60",
          aspect === "16:9" ? "aspect-video" : "aspect-[4/3]",
          className
        )}
      >
        <span className="grid h-10 w-10 place-items-center rounded-full bg-muted font-display text-lg font-semibold text-muted-foreground">
          {(brand ?? title).trim().charAt(0).toUpperCase() || <ImageIcon className="h-5 w-5" aria-hidden />}
        </span>
      </div>
    );
  }
  if (isVideoUrl(src)) {
    return (
      <video
        src={src}
        muted
        playsInline
        preload="metadata"
        aria-label={`Generated preview for ${title}`}
        className={cn("w-full bg-black object-cover", aspect === "16:9" ? "aspect-video" : "aspect-[4/3]", className)}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={`Source imagery for ${title}`}
      loading="lazy"
      className={cn("w-full object-cover", aspect === "16:9" ? "aspect-video" : "aspect-[4/3]", className)}
    />
  );
}
