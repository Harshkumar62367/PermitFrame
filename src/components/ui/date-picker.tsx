"use client";

import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface DatePickerProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  className?: string;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : null;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function firstOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function monthCells(month: Date): Date[] {
  const first = firstOfMonth(month);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
}

/** A product-owned, keyboard-operable calendar that stores ISO date strings. */
export function DatePicker({ id, value, onValueChange, min, max, disabled, className, ...aria }: DatePickerProps) {
  const selected = parseIsoDate(value);
  const today = useMemo(() => new Date(), []);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => firstOfMonth(selected ?? parseIsoDate(min ?? "") ?? today));

  const cells = monthCells(month);
  const monthText = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(month);
  const selectedText = selected
    ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(selected)
    : "Choose date";
  const previousMonthDisabled = min ? isoDate(addMonths(month, -1)) < min.slice(0, 7) + "-01" : false;
  const nextMonthDisabled = max ? isoDate(addMonths(month, 1)) > max.slice(0, 7) + "-01" : false;

  function unavailable(date: Date): boolean {
    const value = isoDate(date);
    return (min !== undefined && value < min) || (max !== undefined && value > max);
  }

  function choose(date: Date) {
    if (unavailable(date)) return;
    onValueChange(isoDate(date));
    setOpen(false);
  }

  return (
    <div className={cn("relative", className)}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...aria}
        onClick={() => {
          if (!open) setMonth(firstOfMonth(selected ?? parseIsoDate(min ?? "") ?? today));
          setOpen((current) => !current);
        }}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-md border border-border bg-card px-3 text-left text-[13px] transition hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-emerald-600/30 disabled:pointer-events-none disabled:opacity-50",
          selected ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <span>{selectedText}</span>
        <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <div role="dialog" aria-label="Choose a date" className="absolute left-0 z-50 mt-2 w-[19rem] rounded-xl border border-border bg-card p-3 shadow-2xl shadow-black/25">
          <div className="mb-3 flex items-center justify-between gap-2">
            <button type="button" onClick={() => setMonth((current) => addMonths(current, -1))} disabled={previousMonthDisabled} aria-label="Previous month" className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-35"><ChevronLeft className="h-4 w-4" /></button>
            <p className="text-[13px] font-semibold">{monthText}</p>
            <button type="button" onClick={() => setMonth((current) => addMonths(current, 1))} disabled={nextMonthDisabled} aria-label="Next month" className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-35"><ChevronRight className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center">
            {DAYS.map((day) => <span key={day} className="py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{day.slice(0, 1)}</span>)}
            {cells.map((date) => {
              const dateValue = isoDate(date);
              const otherMonth = date.getMonth() !== month.getMonth();
              const isSelected = value === dateValue;
              const isToday = isoDate(today) === dateValue;
              return <button key={dateValue} type="button" disabled={unavailable(date)} onClick={() => choose(date)} aria-label={new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(date)} aria-pressed={isSelected} className={cn("grid h-8 place-items-center rounded-lg text-[12px] transition", isSelected ? "bg-emerald-600 font-semibold text-white" : isToday ? "font-semibold text-emerald-600 ring-1 ring-emerald-600/50" : otherMonth ? "text-muted-foreground/45 hover:bg-muted" : "hover:bg-muted", unavailable(date) && "cursor-not-allowed opacity-25 hover:bg-transparent")}>{date.getDate()}</button>;
            })}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <button type="button" onClick={() => { onValueChange(""); setOpen(false); }} disabled={!value} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"><X className="h-3 w-3" /> Clear</button>
            <button type="button" onClick={() => choose(today)} disabled={unavailable(today)} className="text-[11px] font-medium text-emerald-600 hover:text-emerald-500 disabled:opacity-40">Today</button>
          </div>
        </div>
      )}
    </div>
  );
}
