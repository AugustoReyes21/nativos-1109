import { describe, expect, it } from "vitest";
import {
  polygon,
  project,
  rectangle,
  tableGeometry,
} from "../web/table-geometry.js";

describe("isometric table geometry", () => {
  it("projects height upwards and keeps polygon coordinates deterministic", () => {
    expect(project([0, 0])).toEqual([120, 111]);
    expect(project([0, 0], 44)).toEqual([120, 67]);
    expect(
      polygon(
        [
          [0, 0],
          [10, 0],
        ],
        44,
      ),
    ).toBe("120.00,67.00 128.60,71.30");
    expect(rectangle(10, 20, [5, 10])).toEqual([
      [0, 0],
      [10, 0],
      [10, 20],
      [0, 20],
    ]);
  });
  for (const shape of ["square", "round", "rectangle"] as const) {
    it(`${shape}: renders the actual 1–12 seats in back-to-front order`, () => {
      for (let capacity = 1; capacity <= 12; capacity++) {
        const model = tableGeometry(shape, capacity);
        expect(model.top).toHaveLength(shape === "round" ? 40 : 4);
        expect(model.chairs).toHaveLength(capacity);
        expect(new Set(model.chairs.map((c) => c.id)).size).toBe(capacity);
        expect(model.chairs.map((c) => c.depth)).toEqual(
          model.chairs.map((c) => c.depth).sort((a, b) => a - b),
        );
        for (const chair of model.chairs) {
          const [x, y] = project(chair.center);
          expect(x).toBeGreaterThan(0);
          expect(x).toBeLessThan(240);
          expect(y).toBeGreaterThan(0);
          expect(y).toBeLessThan(190);
        }
      }
    });
  }
  it("bounds unexpected capacities without NaN SVG coordinates", () => {
    for (const capacity of [0, -2, 100, NaN, Infinity]) {
      const model = tableGeometry("round", capacity);
      expect(model.chairs.length).toBeGreaterThanOrEqual(1);
      expect(model.chairs.length).toBeLessThanOrEqual(12);
      expect(model.chairs.every((c) => c.center.every(Number.isFinite))).toBe(
        true,
      );
    }
  });
});
