import { AlertCircle, Check, Circle } from "lucide-react";

interface StatusMarkProps {
  status: "ok" | "error" | "unset";
  count?: number;
  subtle?: boolean;
}

/** Run / span status glyph: red alert (+ count) for errors, a quiet muted dot or check otherwise. */
export function StatusMark({ status, count, subtle = false }: StatusMarkProps) {
  if (status === "error") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[12px] text-[#d14d7a] dark:text-[#eb6b93]"
        aria-label={`${count ?? 1} error${count === 1 ? "" : "s"}`}
      >
        <AlertCircle className="size-3" />
        {count !== undefined && <span className="tabular-nums">{count}</span>}
      </span>
    );
  }
  if (subtle)
    return (
      <Circle className="size-1.5 shrink-0 fill-muted-foreground/40 text-muted-foreground/40" aria-label="Success" />
    );
  return <Check className="size-3 text-muted-foreground" aria-label="Success" />;
}
