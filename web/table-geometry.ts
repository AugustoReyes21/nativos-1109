export type Point = readonly [number, number];
export const project = ([x, y]: Point, z = 0): Point => [
  120 + (x - y) * 0.86,
  111 + (x + y) * 0.43 - z,
];
export const polygon = (points: readonly Point[], z = 0) =>
  points
    .map((p) =>
      project(p, z)
        .map((n) => n.toFixed(2))
        .join(","),
    )
    .join(" ");
export function rectangle(
  width: number,
  depth: number,
  center: Point = [0, 0],
  angle = 0,
): Point[] {
  return [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ].map(([x = 0, y = 0]) => [
    center[0] + x * Math.cos(angle) - y * Math.sin(angle),
    center[1] + x * Math.sin(angle) + y * Math.cos(angle),
  ]);
}
export function tableGeometry(
  shape: "square" | "round" | "rectangle",
  capacity: number,
) {
  const seats = Number.isFinite(capacity)
    ? Math.max(1, Math.min(12, Math.floor(capacity)))
    : 1;
  const width = shape === "rectangle" ? 106 : 78;
  const depth = shape === "rectangle" ? 64 : 78;
  const top =
    shape === "round"
      ? Array.from({ length: 40 }, (_, i): Point => [
          Math.cos((i * Math.PI) / 20) * 43,
          Math.sin((i * Math.PI) / 20) * 43,
        ])
      : rectangle(width, depth);
  const chairs = Array.from({ length: seats }, (_, i) => {
    const angle = (i / seats) * Math.PI * 2 - Math.PI / 2;
    const center: Point = [
      Math.cos(angle) * (width / 2 + 22),
      Math.sin(angle) * (depth / 2 + 22),
    ];
    return {
      id: i,
      center,
      angle: angle - Math.PI / 2,
      depth: center[0] + center[1],
    };
  }).sort((a, b) => a.depth - b.depth);
  return { width, depth, top, chairs };
}
