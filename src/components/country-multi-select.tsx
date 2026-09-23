"use client";

import { useId, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { COUNTRIES, countryName } from "@/lib/countries";
import { cn } from "@/lib/utils";

interface CountryMultiSelectProps {
  label: string;
  hint?: string;
  selected: string[];
  /** Optional server-provided subset, used when narrowing an offered scope. */
  allowedCodes?: string[];
  onToggle: (code: string) => void;
  onClear?: () => void;
  error?: string;
  className?: string;
}

/** Search-first territory picker; country codes remain the stored contract. */
export function CountryMultiSelect({ label, hint, selected, allowedCodes, onToggle, onClear, error, className }: CountryMultiSelectProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const allowed = useMemo(() => allowedCodes ? new Set(allowedCodes.map((code) => code.toUpperCase())) : null, [allowedCodes]);
  const matches = useMemo(() => {
    // Search-first: nothing is listed until the user types, so the picker
    // never crowds the form with an unfiltered country wall.
    if (!normalizedQuery) return [];
    return COUNTRIES.filter((country) =>
      (!allowed || allowed.has(country.code)) &&
      (country.name.toLocaleLowerCase().includes(normalizedQuery) || country.code.toLocaleLowerCase().includes(normalizedQuery))
    ).slice(0, 8);
  }, [allowed, normalizedQuery]);

  function chooseCountry(code: string) {
    onToggle(code);
    // A selection is immediately represented by its chip. Resetting search
    // avoids leaving stale results below it and makes the next country search
    // deliberate.
    setQuery("");
  }

  return (
    <fieldset className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <legend className="text-[12px] text-muted-foreground">{label}{selected.length > 0 && ` (${selected.length} selected)`}</legend>
        {selected.length > 0 && onClear && <button type="button" onClick={onClear} className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Clear all</button>}
      </div>
      {hint && <p id={`${id}-hint`} className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</p>}
      <div className="relative mt-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by country or code" aria-label={`Search ${label.toLowerCase()}`} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-[12.5px] outline-none transition placeholder:text-muted-foreground/70 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20" />
      </div>
      {selected.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`${label}: selected`}>
          {selected.map((code) => (
            <button key={code} type="button" onClick={() => chooseCountry(code)} aria-label={`Remove ${countryName(code)}`} className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-2.5 py-1 text-[11.5px] font-medium text-emerald-50 transition hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400">
              {countryName(code)} <span aria-hidden className="font-mono text-[10px] opacity-70">{code}</span><X className="h-3 w-3" aria-hidden />
            </button>
          ))}
        </div>
      )}
      {matches.length > 0 && (
        <div className="mt-1.5 grid gap-1 sm:grid-cols-2" role="group" aria-label={`Available ${label.toLowerCase()}`}>
          {matches.map((country) => {
            const active = selected.includes(country.code);
            return <button key={country.code} type="button" onClick={() => chooseCountry(country.code)} aria-pressed={active} className={cn("flex min-w-0 items-center justify-between rounded-md px-3 py-2 text-left text-[12px] ring-1 transition", active ? "bg-emerald-700 text-emerald-50 ring-emerald-700 dark:bg-emerald-500 dark:text-emerald-950 dark:ring-emerald-500" : "bg-card text-foreground ring-border hover:bg-muted")}><span className="truncate">{country.name}</span><span className="ml-3 shrink-0 font-mono text-[10.5px] opacity-70">{country.code}</span></button>;
          })}
        </div>
      )}
      {normalizedQuery && matches.length === 0 && <p className="mt-1.5 rounded-md border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground">No country matches “{query.trim()}”. Try a country name or ISO code.</p>}
      {!normalizedQuery && <p className="mt-1.5 text-[11px] text-muted-foreground">Search to see a country; the first 8 matches are shown.</p>}
      {error && <p id={`${id}-error`} role="alert" className="mt-1.5 text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}
    </fieldset>
  );
}
