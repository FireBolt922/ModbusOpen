import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { searchPresets, type ParameterPreset } from "@/lib/meterPresets";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  /** null means "custom parameter" — a blank row to fill in by hand. */
  onPick: (preset: ParameterPreset | null) => void;
};

/**
 * Pick what a parameter measures rather than describing it.
 *
 * Choosing "Voltage L-N" fills the name, unit, group, data type and a
 * believable simulation range, leaving exactly one thing for the user to
 * supply: the address printed on their datasheet.
 */
export function PresetPicker({ open, onClose, onPick }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      // Focus after the dialog paints, or the keystroke lands nowhere.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const grouped = useMemo(() => {
    const matches = searchPresets(query);
    const map = new Map<string, ParameterPreset[]>();
    for (const p of matches) {
      const list = map.get(p.category) ?? [];
      list.push(p);
      map.set(p.category, list);
    }
    return [...map.entries()];
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Add parameter"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border p-3">
          <Input
            ref={inputRef}
            placeholder="Search — voltage, current, energy…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {grouped.map(([category, list]) => (
            <div key={category} className="mb-2">
              <div className="px-2 py-1 text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
                {category}
              </div>
              {list.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm",
                    "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                  )}
                  onClick={() => onPick(preset)}
                >
                  <span className="truncate">{preset.label}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {preset.unit || "—"}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {grouped.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              Nothing matches “{query}”. Add it as a custom parameter below.
            </p>
          )}
        </div>

        <div className="border-t border-border p-2">
          <button
            type="button"
            className="w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
            onClick={() => onPick(null)}
          >
            Custom parameter…
            <span className="block text-xs text-muted-foreground">
              Name it and pick how it reads yourself
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
