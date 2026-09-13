"use client";

import { useId, useState } from "react";
import silhouettes from "@/lib/froggy-muscle-silhouettes.json";
import regions from "@/lib/froggy-muscle-regions.json";
import {
  directSetColor,
  muscleLabel,
  type MuscleCoverage,
} from "@/lib/muscle-coverage";
import styles from "./muscle-map.module.css";

/** Shared artwork/interaction surface. Pass one day's aggregate for a day-only view. */
export function FroggyMuscleMap({
  coverage,
  selected = new Set<string>(),
  onToggle,
  compact = false,
}: {
  compact?: boolean;
  coverage: Record<string, MuscleCoverage>;
  selected?: ReadonlySet<string>;
  onToggle?: (muscle: string) => void;
}) {
  const id = useId();
  const [hover, setHover] = useState<string | null>(null);
  function toggle(muscle: string) {
    // A click also focuses the SVG path. Clear the temporary preview so it
    // cannot masquerade as selection after a second click or keyboard toggle.
    setHover(null);
    onToggle?.(muscle);
  }
  return (
    <div className={compact ? styles.compactFigures : styles.figures}>
      {(["front", "back"] as const).map((view) => {
        const x = view === "front" ? 40 : 1380;
        const shapes = regions[view].flatMap((region) =>
          (region.path.match(/M[^M]+/g) ?? []).map((path) => ({
            ...region,
            path,
          })),
        );
        return (
          <figure key={view}>
            <svg
              viewBox={`${x} 65 345 725`}
              aria-label={`${view === "front" ? "Front" : "Back"} muscle map`}
              role="group"
            >
              <defs>
                <radialGradient id={`${id}-${view}-ground`}>
                  <stop offset="0" stopColor="#233646" stopOpacity="0.22" />
                  <stop offset="0.5" stopColor="#233646" stopOpacity="0.1" />
                  <stop offset="1" stopColor="#233646" stopOpacity="0" />
                </radialGradient>
                <clipPath id={`${id}-${view}`}>
                  <path d={silhouettes[view]} />
                </clipPath>
              </defs>
              {!compact && (
                <ellipse
                  cx={x + 172}
                  cy={769}
                  rx={148}
                  ry={17}
                  fill={`url(#${id}-${view}-ground)`}
                  aria-hidden="true"
                  pointerEvents="none"
                />
              )}
              <g clipPath={`url(#${id}-${view})`}>
                <image
                  href="/muscle-map/froggy-mannequin-v1.jpg"
                  width={1774}
                  height={887}
                  aria-hidden="true"
                />
                {regions[view].map((region) => {
                  const count = coverage[region.muscle]?.direct ?? 0;
                  return (
                    <path
                      key={region.muscle}
                      d={region.path}
                      className={onToggle ? styles.region : undefined}
                      data-muscle={region.muscle}
                      data-direct-sets={count}
                      role={onToggle ? "button" : undefined}
                      tabIndex={onToggle ? 0 : undefined}
                      aria-label={`${muscleLabel(region.muscle)}, ${count} planned direct sets, ${view}`}
                      aria-pressed={
                        onToggle ? selected.has(region.muscle) : undefined
                      }
                      onClick={
                        onToggle ? () => toggle(region.muscle) : undefined
                      }
                      onKeyDown={
                        onToggle
                          ? (e) => {
                              if (e.key === " " || e.key === "Enter") {
                                e.preventDefault();
                                toggle(region.muscle);
                              }
                            }
                          : undefined
                      }
                      onPointerEnter={(e) => {
                        if (onToggle && e.pointerType === "mouse")
                          setHover(region.muscle);
                      }}
                      onPointerLeave={() => setHover(null)}
                      onFocus={() => onToggle && setHover(region.muscle)}
                      onBlur={() => setHover(null)}
                      fill={
                        count > 0
                          ? directSetColor(count)
                          : selected.has(region.muscle) ||
                              hover === region.muscle
                            ? "#008da8"
                            : "transparent"
                      }
                      fillOpacity={count > 0 ? 0.68 : 0.3}
                      style={{ mixBlendMode: "multiply" }}
                    />
                  );
                })}
                <g
                  aria-hidden="true"
                  pointerEvents="none"
                  fill="none"
                  strokeLinejoin="round"
                >
                  {shapes
                    .filter((s) => selected.has(s.muscle) || hover === s.muscle)
                    .map((s, index) => (
                      <g key={index}>
                        <path
                          d={s.path}
                          stroke="white"
                          strokeWidth={6}
                          vectorEffect="non-scaling-stroke"
                        />
                        <path
                          d={s.path}
                          stroke="#008da8"
                          strokeWidth={3}
                          vectorEffect="non-scaling-stroke"
                        />
                      </g>
                    ))}
                </g>
              </g>
              <g
                aria-hidden="true"
                pointerEvents="none"
                className={styles.setNumbers}
              >
                {regions[view].map((region) => {
                  const count = coverage[region.muscle]?.direct ?? 0;
                  if (compact || count <= 0) return null;
                  return (
                    <text
                      key={region.muscle}
                      x={region.label[0]}
                      y={region.label[1]}
                      data-set-number={region.muscle}
                      textAnchor="middle"
                      dominantBaseline="central"
                    >
                      {count}
                    </text>
                  );
                })}
              </g>
            </svg>
          </figure>
        );
      })}
    </div>
  );
}
