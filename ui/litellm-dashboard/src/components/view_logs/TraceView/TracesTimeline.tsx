"use client";

import moment from "moment";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/cva.config";

import type { TraceSummary } from "./traceTypes";

const BUCKETS = 60;
const TICKS = 6;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const EDGE_FORMAT = "MMM DD, HH:mm";

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

export interface Bucket {
  startMs: number;
  endMs: number;
  runs: number;
  failed: number;
}

/** Run counts per equal-width time bucket across the window; runs outside it are dropped. */
export function bucketRuns(runs: readonly TraceSummary[], range: TimeWindow, buckets = BUCKETS): Bucket[] {
  const width = (range.endMs - range.startMs) / buckets;
  const placed = runs.map((run) => ({
    index: Math.floor((moment(run.start_time).valueOf() - range.startMs) / width),
    failed: run.error_count > 0,
  }));
  return Array.from({ length: buckets }, (_, i) => {
    const hits = placed.filter((p) => p.index === i);
    return {
      startMs: range.startMs + i * width,
      endMs: range.startMs + (i + 1) * width,
      runs: hits.length,
      failed: hits.filter((p) => p.failed).length,
    };
  });
}

/** Compact window length, Logfire-style: "45m", "6h 12m", "7d", "152d 23h". */
export function formatSpan(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / MINUTE_MS));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

const tickFormat = (range: TimeWindow): string => (range.endMs - range.startMs > 2 * DAY_MS ? EDGE_FORMAT : "HH:mm");

const pct = (value: number): string => `${value * 100}%`;

/** Keep the first / last tick label inside the strip; center the rest on their tick. */
const tickShift = (t: number): string => {
  if (t === 0) return "translateX(0)";
  if (t === 1) return "translateX(-100%)";
  return "translateX(-50%)";
};

interface TracesTimelineProps {
  runs: readonly TraceSummary[];
  range: TimeWindow;
  selection: TimeWindow | null;
  onSelect: (selection: TimeWindow | null) => void;
}

const DOT_ROWS = 7;

/** Lit dots for a bucket: at least one when it has runs, failures stacked on top in the accent color. */
export function bucketDots(bucket: Bucket, max: number, rows = DOT_ROWS): { lit: number; failed: number } {
  if (bucket.runs === 0) return { lit: 0, failed: 0 };
  const lit = Math.max(1, Math.round((bucket.runs / max) * rows));
  const failed = bucket.failed === 0 ? 0 : Math.min(lit, Math.max(1, Math.round((bucket.failed / bucket.runs) * lit)));
  return { lit, failed };
}

function dotClass(row: number, lit: number, failed: number, dimmed: boolean): string {
  if (row >= lit) return "size-[3px] bg-muted-foreground/15";
  if (dimmed) return "size-[5px] bg-muted-foreground/30";
  return row >= lit - failed ? "size-[5px] bg-[#eb6b93]" : "size-[5px] bg-[#0011b3] dark:bg-[#8b9bff]";
}

function BucketBar({
  bucket,
  max,
  dimmed,
  hovered,
}: {
  bucket: Bucket;
  max: number;
  dimmed: boolean;
  hovered: boolean;
}) {
  const { lit, failed } = bucketDots(bucket, max);
  return (
    <div
      className={cn(
        "pointer-events-none flex h-full flex-1 flex-col-reverse items-center justify-between py-0.5 transition-transform duration-150",
        hovered && "scale-125",
      )}
      data-testid="timeline-bucket"
      data-runs={bucket.runs}
    >
      {Array.from({ length: DOT_ROWS }, (_, row) => (
        <span key={row} className={cn("rounded-full", dotClass(row, lit, failed, dimmed))} />
      ))}
    </div>
  );
}

function BucketTooltip({ bucket, index }: { bucket: Bucket; index: number }) {
  return (
    <div
      className="pointer-events-none absolute top-full z-floating mt-1 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[11px] tabular-nums text-popover-foreground shadow-md"
      style={{ left: pct(Math.min(0.8, index / BUCKETS)) }}
      role="tooltip"
    >
      <div>
        {moment(bucket.startMs).format(EDGE_FORMAT)} to {moment(bucket.endMs).format("HH:mm")}
      </div>
      <div>
        {bucket.runs} {bucket.runs === 1 ? "run" : "runs"}
        {bucket.failed > 0 && `, ${bucket.failed} failed`}
      </div>
      <div className="text-muted-foreground">drag to zoom</div>
    </div>
  );
}

const MIN_DURATION_LABEL_PX = 120;

/** Bucket-index band [lo, hi], inclusive. */
export interface Band {
  lo: number;
  hi: number;
}

export type DragMode = "select" | "move" | "resize-lo" | "resize-hi";

export interface DragState {
  mode: DragMode;
  origin: number;
  band: Band;
}

/** The band a drag produces when the pointer is over bucket `at`; always within [0, buckets - 1]. */
export function dragUpdate(drag: DragState, at: number, buckets = BUCKETS): Band {
  const last = buckets - 1;
  const clamp = (i: number) => Math.min(last, Math.max(0, i));
  const { band, origin } = drag;
  if (drag.mode === "select") return { lo: Math.min(origin, clamp(at)), hi: Math.max(origin, clamp(at)) };
  if (drag.mode === "resize-lo") return { lo: Math.min(clamp(at), band.hi), hi: band.hi };
  if (drag.mode === "resize-hi") return { lo: band.lo, hi: Math.max(clamp(at), band.lo) };
  const width = band.hi - band.lo;
  const lo = Math.min(last - width, Math.max(0, band.lo + (at - origin)));
  return { lo, hi: lo + width };
}

/** Bucket band covered by a selected window, or null when nothing is selected. */
export function bandForWindow(buckets: readonly Bucket[], selection: TimeWindow | null): Band | null {
  if (selection === null) return null;
  const inside = buckets.flatMap((b, i) => (b.startMs >= selection.startMs && b.endMs <= selection.endMs ? [i] : []));
  return inside.length > 0 ? { lo: inside[0], hi: inside[inside.length - 1] } : null;
}

const edgeFormat = (range: TimeWindow): string => (range.endMs - range.startMs < DAY_MS ? "HH:mm" : EDGE_FORMAT);

/** The selected window drawn as a flat bracket: resize handles on each edge, times outside, span centered. */
function SelectionBracket({
  band,
  window,
  format,
  stripWidth,
  onHandleDown,
}: {
  band: Band;
  window: TimeWindow;
  format: string;
  stripWidth: number;
  onHandleDown: (mode: DragMode) => (e: React.PointerEvent) => void;
}) {
  const leftFrac = band.lo / BUCKETS;
  const rightFrac = (band.hi + 1) / BUCKETS;
  const widthPx = (rightFrac - leftFrac) * stripWidth;
  const handle = "absolute inset-y-0 w-[3px] cursor-ew-resize rounded-full bg-foreground";
  const edgeLabel = "pointer-events-none absolute -top-4 text-[10px] whitespace-nowrap text-foreground tabular-nums";
  return (
    <>
      <div
        className="absolute inset-y-0 cursor-grab rounded-md bg-foreground/5 ring-[1.5px] ring-foreground ring-inset active:cursor-grabbing"
        style={{ left: pct(leftFrac), width: pct(rightFrac - leftFrac) }}
        data-testid="timeline-selection"
        onPointerDown={onHandleDown("move")}
      >
        <span
          className={cn(handle, "-left-px")}
          data-testid="timeline-handle-lo"
          onPointerDown={onHandleDown("resize-lo")}
        />
        <span
          className={cn(handle, "-right-px")}
          data-testid="timeline-handle-hi"
          onPointerDown={onHandleDown("resize-hi")}
        />
        {widthPx >= MIN_DURATION_LABEL_PX && (
          <span className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[11px] font-medium text-foreground tabular-nums">
            {formatSpan(window.endMs - window.startMs)}
          </span>
        )}
      </div>
      <span className={cn(edgeLabel, leftFrac < 0.12 ? "" : "-translate-x-full pr-1")} style={{ left: pct(leftFrac) }}>
        {moment(window.startMs).format(format)}
      </span>
      <span className={cn(edgeLabel, rightFrac > 0.88 ? "-translate-x-full" : "pl-1")} style={{ left: pct(rightFrac) }}>
        {moment(window.endMs).format(format)}
      </span>
    </>
  );
}

function TickAxis({ range }: { range: TimeWindow }) {
  const format = tickFormat(range);
  const ticks = Array.from({ length: TICKS }, (_, i) => i / (TICKS - 1));
  return (
    <div className="relative mt-0.5 h-5">
      {ticks.map((t) => (
        <div
          key={t}
          className={cn(
            "absolute top-0 flex flex-col",
            t === 0 && "items-start",
            t === 1 && "items-end",
            t > 0 && t < 1 && "items-center",
          )}
          style={{ left: pct(t), transform: tickShift(t) }}
        >
          <span className="h-1 w-px bg-border" />
          <span className="text-[10px] whitespace-nowrap text-muted-foreground tabular-nums">
            {moment(range.startMs + (range.endMs - range.startMs) * t).format(format)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Histogram of runs over the window. Drag to select; drag the bracket or its edges to adjust; Esc clears. */
export function TracesTimeline({ runs, range, selection, onSelect }: TracesTimelineProps) {
  const buckets = useMemo(() => bucketRuns(runs, range), [runs, range]);
  const max = Math.max(1, ...buckets.map((b) => b.runs));
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [draft, setDraft] = useState<Band | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [stripWidth, setStripWidth] = useState(0);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setStripWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const committed = bandForWindow(buckets, selection);
  const band = drag ? draft : committed;
  const windowOf = (b: Band): TimeWindow => ({ startMs: buckets[b.lo].startMs, endMs: buckets[b.hi].endMs });

  const indexAt = (clientX: number): number => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(BUCKETS - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * BUCKETS)));
  };
  const begin = (mode: DragMode, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    areaRef.current?.setPointerCapture?.(e.pointerId);
    const at = indexAt(e.clientX);
    const start = mode === "select" || committed === null ? { lo: at, hi: at } : committed;
    setDrag({ mode: committed === null ? "select" : mode, origin: at, band: start });
    setDraft(start);
  };
  const onHandleDown = (mode: DragMode) => (e: React.PointerEvent) => begin(mode, e);
  const onMove = (e: React.PointerEvent) => {
    const at = indexAt(e.clientX);
    setHover(at);
    if (drag) setDraft(dragUpdate(drag, at));
  };
  const onUp = (e: React.PointerEvent) => {
    areaRef.current?.releasePointerCapture?.(e.pointerId);
    if (!drag || !draft) return;
    const finished = draft;
    const wasSelect = drag.mode === "select";
    setDrag(null);
    setDraft(null);
    if (wasSelect && finished.lo === finished.hi) {
      onSelect(null);
      return;
    }
    onSelect(windowOf(finished));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || selection === null) return;
    e.preventDefault();
    onSelect(null);
  };

  const isDimmed = (i: number): boolean => band !== null && (i < band.lo || i > band.hi);
  const labelFormat = edgeFormat(range);

  return (
    <div
      className="relative shrink-0 border-b border-border bg-card px-3 pt-2 pb-1 outline-none select-none"
      data-testid="traces-timeline"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="mb-4 flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>Total {formatSpan(range.endMs - range.startMs)}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="size-[5px] rounded-full bg-[#0011b3] dark:bg-[#8b9bff]" />
            runs
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-[5px] rounded-full bg-[#eb6b93]" />
            failed
          </span>
        </span>
      </div>
      <div
        ref={areaRef}
        role="presentation"
        data-testid="timeline-area"
        className="relative flex h-14 cursor-crosshair touch-none items-end"
        onPointerDown={(e) => begin("select", e)}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={() => onSelect(null)}
      >
        {hover !== null && !drag && (
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40"
            style={{ left: pct((hover + 0.5) / BUCKETS) }}
            data-testid="timeline-cursor"
          />
        )}
        {buckets.map((b, i) => (
          <BucketBar key={b.startMs} bucket={b} max={max} dimmed={isDimmed(i)} hovered={hover === i} />
        ))}
        {band && (
          <SelectionBracket
            band={band}
            window={windowOf(band)}
            format={labelFormat}
            stripWidth={stripWidth}
            onHandleDown={onHandleDown}
          />
        )}
      </div>
      <TickAxis range={range} />
      {hover !== null && !drag && <BucketTooltip bucket={buckets[hover]} index={hover} />}
    </div>
  );
}
