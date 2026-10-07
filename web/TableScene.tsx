import { memo, useId } from "react";
import type { DiningTable } from "./types";
import {
  polygon,
  project,
  rectangle,
  tableGeometry,
  type Point,
} from "./table-geometry";

function Solid({
  points,
  base,
  height,
  surface,
  className = "",
}: {
  points: Point[];
  base: number;
  height: number;
  surface?: string;
  className?: string;
}) {
  return (
    <g className={className}>
      {points.map((a, i) => {
        const b = points[(i + 1) % points.length]!;
        // Only outward-facing sides: correct occlusion without a WebGL render loop.
        if (b[1] - a[1] - (b[0] - a[0]) <= 0) return null;
        const face = [
          project(a, base),
          project(b, base),
          project(b, base + height),
          project(a, base + height),
        ];
        return (
          <polygon
            key={i}
            points={face.map((p) => p.join(",")).join(" ")}
            className={b[1] > a[1] ? "scene-side-light" : "scene-side-dark"}
          />
        );
      })}
      <polygon
        points={polygon(points, base + height)}
        className="scene-surface"
        fill={surface}
      />
    </g>
  );
}

export const TableScene = memo(function TableScene({
  table,
}: {
  table: DiningTable;
}) {
  const id = useId().replaceAll(":", "");
  const model = tableGeometry(table.shape, table.capacity);
  const chair = (c: (typeof model.chairs)[number]) => {
    const local = (x: number, y: number): Point => [
      c.center[0] + x * Math.cos(c.angle) - y * Math.sin(c.angle),
      c.center[1] + x * Math.sin(c.angle) + y * Math.cos(c.angle),
    ];
    return (
      <g key={c.id} className="scene-chair" data-chair="true">
        {[
          [-6, -6],
          [6, -6],
          [-6, 6],
          [6, 6],
        ].map(([x = 0, y = 0], i) => (
          <Solid
            key={i}
            points={rectangle(3, 3, local(x, y), c.angle)}
            base={0}
            height={25}
            className="scene-leg"
          />
        ))}
        <Solid
          points={rectangle(19, 18, c.center, c.angle)}
          base={24}
          height={5}
          className="scene-cushion"
        />
        <Solid
          points={rectangle(19, 4, local(0, 8), c.angle)}
          base={28}
          height={15}
          className="scene-cushion"
        />
      </g>
    );
  };
  return (
    <svg
      viewBox="0 0 240 190"
      className="table-drawing table-scene"
      aria-hidden="true"
      focusable="false"
      data-shape={table.shape}
    >
      <defs>
        <linearGradient id={`${id}-wood`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f4dfb6" />
          <stop offset="0.48" stopColor="#d9b77e" />
          <stop offset="1" stopColor="#bc915c" />
        </linearGradient>
        <radialGradient id={`${id}-shadow`}>
          <stop stopColor="#183d34" stopOpacity="0.23" />
          <stop offset="1" stopColor="#183d34" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${id}-top`}>
          <polygon points={polygon(model.top, 44)} />
        </clipPath>
      </defs>
      <ellipse cx="121" cy="128" rx="101" ry="42" fill={`url(#${id}-shadow)`} />
      <g className="scene-furniture">
        {model.chairs.filter((c) => c.depth <= 0).map(chair)}
        {rectangle(model.width - 20, model.depth - 20).map((p, i) => (
          <Solid
            key={i}
            points={rectangle(6, 6, p)}
            base={0}
            height={39}
            className="scene-leg"
          />
        ))}
        <Solid
          points={model.top}
          base={38}
          height={6}
          surface={`url(#${id}-wood)`}
          className="scene-table"
        />
        <g clipPath={`url(#${id}-top)`} className="scene-grain">
          {[-36, -24, -12, 0, 12, 24, 36].map((x) => (
            <polyline
              key={x}
              points={polygon(
                [
                  [x, -60],
                  [x + 2, 0],
                  [x, 60],
                ],
                44,
              )}
            />
          ))}
        </g>
        <ellipse
          cx="120"
          cy="66"
          rx="10"
          ry="5"
          fill="#fffbef"
          opacity="0.85"
        />
        <path d="M120 64v-13" stroke="#41694c" strokeWidth="2" />
        <ellipse
          cx="117"
          cy="53"
          rx="5"
          ry="2.5"
          fill="#507f56"
          transform="rotate(32 117 53)"
        />
        <ellipse
          cx="123"
          cy="49"
          rx="5"
          ry="2.5"
          fill="#709366"
          transform="rotate(-32 123 49)"
        />
        {model.chairs.filter((c) => c.depth > 0).map(chair)}
      </g>
    </svg>
  );
});
