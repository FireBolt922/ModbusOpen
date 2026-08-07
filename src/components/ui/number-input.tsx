import * as React from "react";

import { cn } from "@/lib/utils";

// Why not <Input type="number">? Two reasons, both of which bit us:
//
// 1. Editing was impossible. Every call site did `onChange={Number(e.target.value) || 1}`,
//    so clearing the box snapped it straight back to the fallback and you could never
//    delete the last digit to retype the number. A numeric field has to tolerate the
//    *intermediate* states a human types through — "", "-", "1." — and only reject them
//    when the user leaves the field.
// 2. type="number" draws native spinners, which WebKitGTK on Linux paints with the GTK
//    theme (unreadable against our dark UI, same root cause as the <select> problem).
//
// So: a text input with inputMode, a string draft while focused, and our own arrow-key
// stepping. The committed value is always a valid, in-range number.

type Props = Omit<
  React.ComponentProps<"input">,
  "value" | "onChange" | "type" | "min" | "max" | "step"
> & {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Arrow-key step. Shift multiplies by 10. Defaults to 1. */
  step?: number;
  /** Allow a decimal point and a leading minus. Defaults to integer-only. */
  allowDecimal?: boolean;
  /** Emitted when a blur leaves an out-of-range value that we clamped. */
  onClamp?: (clamped: number, typed: number) => void;
};

function clamp(n: number, min?: number, max?: number): number {
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** Characters a user legitimately passes through while typing a number. */
function isDraftShape(text: string, allowDecimal: boolean): boolean {
  if (text === "" || text === "-") return true;
  const pattern = allowDecimal ? /^-?\d*\.?\d*(e-?\d*)?$/i : /^-?\d*$/;
  return pattern.test(text);
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  allowDecimal = false,
  onClamp,
  className,
  onBlur,
  onFocus,
  onKeyDown,
  ...props
}: Props) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const focused = React.useRef(false);

  // Outside updates (store resets, config pushes) win — but never while the user
  // is mid-edit, or we'd yank the text out from under them.
  React.useEffect(() => {
    if (!focused.current) setDraft(null);
  }, [value]);

  const text = draft ?? String(value);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    if (!isDraftShape(next, allowDecimal)) return;
    setDraft(next);

    // Commit as soon as the text is a real number, so polling retunes live.
    // "" / "-" / "1." are held as draft only; blur resolves them.
    const parsed = Number(next);
    if (next !== "" && next !== "-" && Number.isFinite(parsed)) {
      const bounded = clamp(parsed, min, max);
      // Don't clamp mid-typing: "1" on the way to "100" would stick at min.
      if (bounded === parsed) onChange(parsed);
    }
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    focused.current = false;
    const typed = Number(text);
    if (text === "" || text === "-" || !Number.isFinite(typed)) {
      setDraft(null); // revert to the last good value
    } else {
      const bounded = clamp(typed, min, max);
      if (bounded !== typed) onClamp?.(bounded, typed);
      onChange(bounded);
      setDraft(null);
    }
    onBlur?.(e);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const delta = (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1);
      const base = Number.isFinite(Number(text)) && text !== "" ? Number(text) : value;
      const next = clamp(base + delta, min, max);
      setDraft(String(next));
      onChange(next);
    }
    onKeyDown?.(e);
  }

  return (
    <input
      {...props}
      type="text"
      inputMode={allowDecimal ? "decimal" : "numeric"}
      autoComplete="off"
      spellCheck={false}
      data-slot="input"
      value={text}
      onChange={handleChange}
      onFocus={(e) => {
        focused.current = true;
        e.currentTarget.select();
        onFocus?.(e);
      }}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm tabular-nums shadow-xs transition-colors outline-none",
        "placeholder:text-muted-foreground",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    />
  );
}

export { NumberInput };
