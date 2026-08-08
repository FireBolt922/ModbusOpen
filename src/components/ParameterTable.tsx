import { useMemo } from "react";
import type { DecodedRegister, MeterPoint, MeterPointGroup, MeterProfile } from "@/lib/types";
import {
  formatAddressSpan,
  formatHoldingSpan,
  formatRawHex,
  formatRegisterValue,
} from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const GROUP_ORDER: MeterPointGroup[] = [
  "instantaneous",
  "energy",
  "harmonics",
  "diagnostics",
  "other",
];

const GROUP_LABEL: Record<MeterPointGroup, string> = {
  instantaneous: "Instantaneous",
  energy: "Energy",
  harmonics: "Harmonics",
  diagnostics: "Diagnostics",
  other: "Other",
};

type Row = {
  point: MeterPoint;
  decoded: DecodedRegister | null;
};

type Props = {
  profile: MeterProfile;
  /** One decoded row per profile point, same order as profile.points (or nulls). */
  pointRows: (DecodedRegister | null)[];
  stale?: boolean;
};

export function ParameterTable({ profile, pointRows, stale = false }: Props) {
  const rows: Row[] = useMemo(
    () =>
      profile.points.map((point, i) => ({
        point,
        decoded: pointRows[i] ?? null,
      })),
    [profile.points, pointRows],
  );

  const byGroup = useMemo(() => {
    const map = new Map<MeterPointGroup, Row[]>();
    for (const g of GROUP_ORDER) map.set(g, []);
    for (const row of rows) {
      const g = row.point.group;
      const list = map.get(g) ?? [];
      list.push(row);
      map.set(g, list);
    }
    return GROUP_ORDER.filter((g) => (map.get(g)?.length ?? 0) > 0).map(
      (g) => [g, map.get(g)!] as const,
    );
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
        This meter has no parameters.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-border">
      <div className="sticky top-0 z-10 grid grid-cols-[minmax(10rem,1.4fr)_minmax(5rem,0.8fr)_4rem_minmax(6rem,0.9fr)_minmax(6rem,0.9fr)_minmax(8rem,1.2fr)] gap-x-3 border-b border-border bg-muted/40 px-3 py-1.5 text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
        <div>Parameter</div>
        <div>Value</div>
        <div>Unit</div>
        <div>Wire</div>
        <div>4x</div>
        <div>Raw (hex)</div>
      </div>

      {byGroup.map(([group, groupRows]) => (
        <div key={group}>
          <div className="bg-muted/30 px-3 py-1 text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
            {GROUP_LABEL[group]}
          </div>
          {groupRows.map(({ point, decoded }) => {
            const display = decoded
              ? formatRegisterValue(decoded)
              : "—";
            return (
              <div
                key={point.key}
                className={cn(
                  "grid grid-cols-[minmax(10rem,1.4fr)_minmax(5rem,0.8fr)_4rem_minmax(6rem,0.9fr)_minmax(6rem,0.9fr)_minmax(8rem,1.2fr)] items-center gap-x-3 border-b border-border/40 px-3 py-1.5 font-mono text-[0.8rem] tabular-nums",
                  stale && "opacity-50",
                  decoded?.decodeError && "text-destructive",
                )}
              >
                <div className="flex min-w-0 items-center gap-1.5 font-sans">
                  <span className="truncate font-medium">{point.label}</span>
                  {point.unverified && (
                    <Badge
                      variant="outline"
                      className="shrink-0 text-[0.6rem]"
                      title="Data type not confirmed against source — treat the value with caution"
                    >
                      Unverified
                    </Badge>
                  )}
                </div>
                <div className="min-w-0 truncate font-sans font-medium" title={display}>
                  {display}
                </div>
                <div className="text-muted-foreground">{point.unit || "—"}</div>
                <div>
                  {decoded
                    ? formatAddressSpan(decoded.address, decoded.span)
                    : String(point.address)}
                </div>
                <div className="text-muted-foreground">
                  {decoded
                    ? formatHoldingSpan(decoded.address, decoded.span)
                    : formatHoldingSpan(point.address, point.format.dataType.includes("64") ? 4 : point.format.dataType.includes("32") || point.format.dataType === "float32" ? 2 : 1)}
                </div>
                <div className="truncate text-muted-foreground">
                  {decoded ? formatRawHex(decoded.raw) : "—"}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
