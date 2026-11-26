import { HeightTile } from "./height-tile";
import {
  chaikinDoublePixels,
  convexHullHoldsNoLevel,
  demByClosures,
  demPixelsUnderGrid,
  demTilesRead,
  demTilesUnderNeighbors,
  gatherDemPixels,
  gridByChaikinDoubling,
  gridByClosureChain,
  gridByQuadraticBSpline,
  gridLayout,
  heightGrid,
  heightGridUnlessEmpty,
  meanOfFourPixelsAtCorners,
  pixelsChaikinDoublingReads,
  upsamplingFactor,
} from "./height-grid";
import type { DemWindow, GridLayout, HeightBlock, Span } from "./height-grid";
import generateIsolines from "./isolines";
import type { DemTile } from "./types";

type Pixels = (x: number, y: number) => number;

const HOLE = -32768;
const WIDTH = 4;
const FEET = 3.28084;
const FACTORS = [2, 4, 8, 16, 32];

const rough: Pixels = (x, y) =>
  Math.imul((x * 73856093) ^ (y * 19349663), 2654435761) >>> 22;
const fractional: Pixels = (x, y) => rough(x, y) + rough(y, x) / 1024 + 0.1;
const withHoles =
  (pixels: Pixels): Pixels =>
  (x, y) =>
    rough(x + 100, y - 100) < 150 ? HOLE : pixels(x, y);

const TERRAINS: [string, Pixels, number[]][] = [
  ["whole meters", rough, []],
  ["fractional meters", fractional, []],
  ["whole meters with holes", withHoles(rough), []],
  ["fractional meters with holes", withHoles(fractional), []],
  ["a missing east DEM tile", rough, [5]],
  ["only the center DEM tile", fractional, [0, 1, 2, 3, 5, 6, 7, 8]],
];

const WINDOWS: [string, number, number, number][] = [
  ["the whole DEM tile", 0, 0, 0],
  ["the northeast quarter of the DEM tile", 1, 1, 0],
];

function windowAround(
  pixels: Pixels,
  missingTiles: number[] = [],
  depth: number = 0,
  column: number = 0,
  row: number = 0,
  width: number = WIDTH,
): DemWindow {
  const tiles: (DemTile | undefined)[] = [];
  for (let i = 0; i < 9; i++) {
    const left = ((i % 3) - 1) * width;
    const top = (Math.floor(i / 3) - 1) * width;
    const data = new Float32Array(width * width);
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        data[y * width + x] = pixels(left + x, top + y);
      }
    }
    tiles.push(
      missingTiles.includes(i) ? undefined : { width, height: width, data },
    );
  }
  return { tiles, depth, column, row };
}

function without(pixels: Pixels, missingTiles: number[]): Pixels {
  return (x, y) =>
    missingTiles.includes(
      (Math.floor(y / WIDTH) + 1) * 3 + Math.floor(x / WIDTH) + 1,
    )
      ? HOLE
      : pixels(x, y);
}

function around(first: number, count: number, border: number): Span {
  return { first: first - border, count: count + 2 * border };
}

function valuesOf(tile: HeightTile, border: number): Float32Array {
  const values: number[] = [];
  for (let y = -border; y < tile.height + border; y++) {
    for (let x = -border; x < tile.width + border; x++) {
      values.push(tile.get(x, y));
    }
  }
  return Float32Array.from(values);
}

function expectSameAsTile(
  heights: HeightBlock,
  tile: HeightTile,
  border: number,
) {
  expect(heights.columns.count).toBe(tile.width + 2 * border);
  expect(heights.rows.count).toBe(tile.height + 2 * border);
  expect(heights.data).toEqual(valuesOf(tile, border));
}

function mean(...values: number[]): number {
  return Math.fround(values.reduce((a, b) => a + b) / values.length);
}

function basis(t: number): number {
  const a = Math.abs(t);
  return a <= 0.5 ? 0.75 - a * a : a <= 1.5 ? (1.5 - a) ** 2 / 2 : 0;
}

function validPixel(pixels: Pixels, x: number, y: number): number {
  const value = Math.fround(pixels(x, y));
  return value >= -12000 && value <= 9000 ? value : NaN;
}

function spline(pixels: Pixels, x: number, y: number): number {
  let sum = 0;
  for (let j = Math.floor(y) - 2; j <= Math.floor(y) + 1; j++) {
    for (let i = Math.floor(x) - 2; i <= Math.floor(x) + 1; i++) {
      const weight = basis(x - i - 0.5) * basis(y - j - 0.5);
      if (weight !== 0) {
        sum += validPixel(pixels, i, j) * weight;
      }
    }
  }
  return sum;
}

function splineGrid(
  pixels: Pixels,
  layout: GridLayout,
  multiplier: number,
): Float32Array {
  const { factor, columns, rows } = layout;
  const values: number[] = [];
  for (let y = rows.first; y < rows.first + rows.count; y++) {
    for (let x = columns.first; x < columns.first + columns.count; x++) {
      values.push(spline(pixels, x / factor, y / factor) * multiplier);
    }
  }
  return Float32Array.from(values);
}

function splineOver(
  window: DemWindow,
  layout: GridLayout,
  multiplier: number,
): HeightBlock {
  const { factor, columns, rows } = layout;
  return gridByQuadraticBSpline(
    gatherDemPixels(
      window.tiles,
      demPixelsUnderGrid(columns, factor),
      demPixelsUnderGrid(rows, factor),
    ),
    factor,
    columns,
    rows,
    multiplier,
  );
}

function layoutOf(window: DemWindow, subsampleBelow: number): GridLayout {
  return gridLayout(window, subsampleBelow) as GridLayout;
}

function float32Step(value: number): number {
  return 2 ** (Math.floor(Math.log2(Math.abs(value))) - 23);
}

function largestDifferenceInFloat32Steps(
  a: Float32Array,
  b: Float32Array,
): number {
  let largest = 0;
  for (let i = 0; i < a.length; i++) {
    if (!isNaN(a[i]) || !isNaN(b[i])) {
      largest = Math.max(largest, Math.abs(a[i] - b[i]) / float32Step(a[i]));
    }
  }
  return largest;
}

describe("each step computes what the HeightTile method it replaces computes", () => {
  describe.each(TERRAINS)("%s", (_, pixels, missingTiles) => {
    describe.each(WINDOWS)("%s", (_, depth, column, row) => {
      const window = windowAround(pixels, missingTiles, depth, column, row);
      const dem = demByClosures(window);
      const width = WIDTH / 2 ** depth;
      const left = column * width;
      const top = row * width;
      const block = gatherDemPixels(
        window.tiles,
        around(left, width, 2),
        around(top, width, 2),
      );

      test("demByClosures reads the DEM pixels in and around the window", () => {
        const seen = without(pixels, missingTiles);
        expect(dem).toMatchObject({ width, height: width });
        for (let y = -2; y < width + 2; y++) {
          for (let x = -2; x < width + 2; x++) {
            expect(dem.get(x, y)).toBe(validPixel(seen, left + x, top + y));
          }
        }
      });

      test("gatherDemPixels is fromRawDem, split, combineNeighbors and materialize(2)", () => {
        expectSameAsTile(block, dem.materialize(2), 2);
      });

      test("chaikinDoublePixels is subsamplePixelCenters(2).materialize(2)", () => {
        const once = chaikinDoublePixels(
          block,
          around(2 * left, 2 * width, 2),
          around(2 * top, 2 * width, 2),
        );
        const onceBefore = dem.subsamplePixelCenters(2).materialize(2);
        expectSameAsTile(once, onceBefore, 2);
        expectSameAsTile(
          chaikinDoublePixels(
            once,
            around(4 * left, 4 * width, 2),
            around(4 * top, 4 * width, 2),
          ),
          onceBefore.subsamplePixelCenters(2).materialize(2),
          2,
        );
      });

      test.each([1, FEET])(
        "meanOfFourPixelsAtCorners is averagePixelCentersToGrid().scaleElevation(%d).materialize(1)",
        (multiplier) => {
          expectSameAsTile(
            meanOfFourPixelsAtCorners(
              block,
              around(left, width + 1, 1),
              around(top, width + 1, 1),
              multiplier,
            ),
            dem
              .materialize(2)
              .averagePixelCentersToGrid()
              .scaleElevation(multiplier)
              .materialize(1),
            1,
          );
        },
      );

      test.each([1, ...FACTORS])(
        "gridByChaikinDoubling %dx is the chain of closures",
        (factor) => {
          expectSameAsTile(
            gridByChaikinDoubling(
              block,
              factor,
              around(left * factor, width * factor + 1, 1),
              around(top * factor, width * factor + 1, 1),
              FEET,
            ),
            gridByClosureChain(dem, width * factor, FEET),
            1,
          );
        },
      );
    });
  });
});

test("upsamplingFactor doubles until the width reaches subsampleBelow", () => {
  expect(upsamplingFactor(512, 100)).toBe(1);
  expect(upsamplingFactor(100, 100)).toBe(1);
  expect(upsamplingFactor(64, 100)).toBe(2);
  expect(upsamplingFactor(32, 100)).toBe(4);
  expect(upsamplingFactor(1, 100)).toBe(128);
  expect(upsamplingFactor(0.5, 100)).toBe(256);
});

test("pixelsChaikinDoublingReads is the pixels one doubling blends", () => {
  expect(pixelsChaikinDoublingReads({ first: -2, count: 12 })).toEqual({
    first: -2,
    count: 8,
  });
  expect(pixelsChaikinDoublingReads({ first: 5, count: 1 })).toEqual({
    first: 2,
    count: 2,
  });
  expect(pixelsChaikinDoublingReads({ first: 6, count: 1 })).toEqual({
    first: 2,
    count: 2,
  });
});

describe("gridByQuadraticBSpline", () => {
  describe.each([
    ...WINDOWS,
    ["a window one pixel wide", 2, 1, 2],
    ["a window half a pixel wide at the DEM tile's edge", 3, 7, 0],
    ["a window an eighth of a pixel wide", 5, 9, 30],
  ] as [string, number, number, number][])("%s", (_, depth, column, row) => {
    const width = WIDTH / 2 ** depth;

    test.each(FACTORS.filter((factor) => width * factor >= 1))(
      "%dx is the biquadratic B-spline with the DEM pixels as control points",
      (factor) => {
        const window = windowAround(rough, [], depth, column, row);
        const layout = layoutOf(window, width * factor);
        expect(layout).toMatchObject({
          factor,
          cellsAcross: width * factor,
          cellsDown: width * factor,
        });
        expect(splineOver(window, layout, FEET).data).toEqual(
          splineGrid(rough, layout, FEET),
        );
      },
    );

    test.each(FACTORS.filter((factor) => width * factor >= 1))(
      "%dx is missing exactly where a pixel it blends is missing",
      (factor) => {
        const pixels = withHoles(rough);
        const window = windowAround(pixels, [5], depth, column, row);
        const layout = layoutOf(window, width * factor);
        expect(splineOver(window, layout, 1).data).toEqual(
          splineGrid(without(pixels, [5]), layout, 1),
        );
      },
    );
  });
});

describe("heightGrid", () => {
  describe.each(TERRAINS)("%s", (_, pixels, missingTiles) => {
    describe.each(WINDOWS)("%s", (_, depth, column, row) => {
      const window = windowAround(pixels, missingTiles, depth, column, row);
      const dem = demByClosures(window);
      const width = WIDTH / 2 ** depth;

      test("at the zoom of the DEM is the chain of closures", () => {
        const grid = heightGrid(window, width, FEET);
        const before = gridByClosureChain(dem, width, FEET);
        expect(grid).toMatchObject({ width: width + 1, height: width + 1 });
        expect(valuesOf(grid, 1)).toEqual(valuesOf(before, 1));
      });

      test.each(FACTORS)(
        "upsampled %dx is the spline, and the chain of closures where a pixel is missing",
        (factor) => {
          const size = width * factor;
          const grid = valuesOf(heightGrid(window, size, FEET), 1);
          const before = valuesOf(gridByClosureChain(dem, size, FEET), 1);
          const direct = splineOver(window, layoutOf(window, size), FEET);
          for (let i = 0; i < grid.length; i++) {
            expect(grid[i]).toBe(
              isNaN(direct.data[i]) ? before[i] : direct.data[i],
            );
          }
        },
      );
    });

    test.each([
      [2, 1],
      [1, 2],
      [0.5, 3],
      [0.25, 4],
      [0.125, 5],
    ])(
      "a window %d pixels wide is the same part of the whole DEM tile's grid",
      (width, depth) => {
        const cells = 4;
        const factor = cells / width;
        const whole = heightGrid(
          windowAround(pixels, missingTiles),
          WIDTH * factor,
          FEET,
        );
        for (let row = 0; row < 2 ** depth; row++) {
          for (let column = 0; column < 2 ** depth; column++) {
            const part = heightGrid(
              windowAround(pixels, missingTiles, depth, column, row),
              cells,
              FEET,
            );
            expect(part).toMatchObject({ width: cells + 1, height: cells + 1 });
            const expected: number[] = [];
            for (let y = -1; y <= cells + 1; y++) {
              for (let x = -1; x <= cells + 1; x++) {
                expected.push(whole.get(column * cells + x, row * cells + y));
              }
            }
            expect(valuesOf(part, 1)).toEqual(Float32Array.from(expected));
          }
        }
      },
    );
  });

  test.each([2, 4])(
    "upsampled %dx on whole meters is the chain of closures bit for bit",
    (factor) => {
      const window = windowAround(rough);
      expect(valuesOf(heightGrid(window, WIDTH * factor, FEET), 1)).toEqual(
        valuesOf(
          gridByClosureChain(demByClosures(window), WIDTH * factor, FEET),
          1,
        ),
      );
    },
  );

  test.each([
    [2, 1],
    [4, 1],
    [8, 1],
    [16, 2],
    [32, 2],
  ])(
    "upsampled %dx is within %d 32 bit float steps of the chain of closures",
    (factor, steps) => {
      for (const pixels of [rough, fractional, withHoles(fractional)]) {
        const window = windowAround(pixels);
        expect(
          largestDifferenceInFloat32Steps(
            valuesOf(heightGrid(window, WIDTH * factor, 1), 1),
            valuesOf(
              gridByClosureChain(demByClosures(window), WIDTH * factor, 1),
              1,
            ),
          ),
        ).toBeLessThanOrEqual(steps);
      }
    },
  );

  test("a window that does not hold a whole number of grid cells takes the chain of closures", () => {
    const window = windowAround(rough, [], 1, 1, 0, 3);
    expect(gridLayout(window, 1)).toBeUndefined();
    expect(valuesOf(heightGrid(window, 1, 1), 1)).toEqual(
      valuesOf(gridByClosureChain(demByClosures(window), 1, 1), 1),
    );
  });

  describe.each([
    ["whole meters", rough],
    ["fractional meters", fractional],
    ["fractional meters with holes", withHoles(fractional)],
    [
      "a hole only the west tile can see",
      (x, y) => (x === 0 && y === 1 ? HOLE : fractional(x, y)),
    ],
    [
      "a hole only the east tile can see",
      (x, y) => (x === 2 * WIDTH - 1 && y === 2 ? HOLE : fractional(x, y)),
    ],
  ] as [string, Pixels][])("%s", (_, pixels) => {
    test.each([1, ...FACTORS])(
      "neighboring tiles upsampled %dx compute the same heights on their shared edge",
      (factor) => {
        const size = WIDTH * factor;
        const west = heightGrid(windowAround(pixels), size, FEET);
        const east = heightGrid(
          windowAround((x, y) => pixels(x + WIDTH, y)),
          size,
          FEET,
        );
        const south = heightGrid(
          windowAround((x, y) => pixels(x, y + WIDTH)),
          size,
          FEET,
        );
        for (let i = 0; i <= size; i++) {
          expect(west.get(size, i)).toBe(east.get(0, i));
          expect(west.get(i, size)).toBe(south.get(i, 0));
        }
        if (factor > 1) {
          for (let i = -1; i <= size + 1; i++) {
            expect(west.get(size + 1, i)).toBe(east.get(1, i));
            expect(west.get(size - 1, i)).toBe(east.get(-1, i));
            expect(west.get(i, size + 1)).toBe(south.get(i, 1));
            expect(west.get(i, size - 1)).toBe(south.get(i, -1));
          }
        }
      },
    );
  });
});

describe("the DEM tiles a window reads", () => {
  test("demTilesUnderNeighbors is the DEM tiles under the contour tile and its 8 neighbors", () => {
    expect(demTilesUnderNeighbors(0, 0, 0)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(demTilesUnderNeighbors(2, 1, 2)).toEqual([4]);
    expect(demTilesUnderNeighbors(2, 0, 3)).toEqual([3, 4, 6, 7]);
  });

  test.each([
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [1, 0, 1],
    [1, 1, 1],
  ])(
    "a window two pixels wide or wider reads the DEM tiles under its neighbors (depth %d, column %d, row %d)",
    (depth, column, row) => {
      const window = windowAround(rough, [], depth, column, row);
      for (const subsampleBelow of [1, 100]) {
        expect(demTilesRead(window, subsampleBelow)).toEqual(
          demTilesUnderNeighbors(depth, column, row),
        );
      }
    },
  );

  test("a window one pixel wide reads two pixels beyond itself, into DEM tiles its neighbors are not over", () => {
    const window = windowAround(rough, [], 2, 1, 1);
    expect(demTilesUnderNeighbors(2, 1, 1)).toEqual([4]);
    expect(demTilesRead(window, 100)).toEqual([0, 1, 3, 4]);
  });

  test("a window that takes the chain of closures reads the DEM tiles under its neighbors", () => {
    const window = windowAround(rough, [], 1, 1, 0, 3);
    expect(demTilesRead(window, 1)).toEqual(demTilesUnderNeighbors(1, 1, 0));
  });
});

describe("convexHullHoldsNoLevel", () => {
  const block = (...values: number[]): HeightBlock => ({
    columns: { first: 0, count: values.length },
    rows: { first: 0, count: 1 },
    data: Float32Array.from(values),
  });

  test("pixels between two levels hold no level", () => {
    expect(convexHullHoldsNoLevel(block(101, 105, 109), 1, 10)).toBe(true);
  });

  test("pixels on both sides of a level hold it", () => {
    expect(convexHullHoldsNoLevel(block(99, 101), 1, 10)).toBe(false);
  });

  test("pixels exactly on a level hold it", () => {
    expect(convexHullHoldsNoLevel(block(100, 100), 1, 10)).toBe(false);
  });

  test("a pixel within 32 bit float rounding of a level holds it", () => {
    expect(convexHullHoldsNoLevel(block(99.99999, 95), 1, 100)).toBe(false);
    expect(convexHullHoldsNoLevel(block(99.99, 95), 1, 100)).toBe(true);
  });

  test("missing pixels are left out, and no pixels hold no level", () => {
    expect(convexHullHoldsNoLevel(block(101, NaN, 109), 1, 10)).toBe(true);
    expect(convexHullHoldsNoLevel(block(NaN, NaN), 1, 10)).toBe(true);
  });

  test("levels are in the units the multiplier converts to", () => {
    expect(convexHullHoldsNoLevel(block(30, 30.4), FEET, 100)).toBe(true);
    expect(convexHullHoldsNoLevel(block(30.4, 30.5), FEET, 100)).toBe(false);
    expect(convexHullHoldsNoLevel(block(101, 109), -1, 10)).toBe(true);
    expect(convexHullHoldsNoLevel(block(99, 101), -1, 10)).toBe(false);
  });

  test("an interval that is not positive is never ruled out", () => {
    expect(convexHullHoldsNoLevel(block(101, 109), 1, 0)).toBe(false);
    expect(convexHullHoldsNoLevel(block(101, 109), 1, NaN)).toBe(false);
  });
});

describe("heightGridUnlessEmpty", () => {
  const gentle =
    (rise: number): Pixels =>
    (x, y) =>
      100 + (rough(x, y) * rise) / 1024;
  let ruledOut = 0;
  let traced = 0;

  describe.each([
    ["rising 3", gentle(3)],
    ["rising 12", gentle(12)],
    ["rising 40", gentle(40)],
    ["rising 12 with holes", withHoles(gentle(12))],
  ] as [string, Pixels][])("%s", (_, pixels) => {
    test.each([
      [0, 1],
      [0, 4],
      [1, 32],
      [3, 8],
      [4, 16],
    ])(
      "at depth %d upsampled %dx is heightGrid, or nothing where heightGrid traces no line",
      (depth, factor) => {
        const subsampleBelow = (WIDTH / 2 ** depth) * factor;
        for (let row = 0; row < 2 ** depth; row++) {
          for (let column = 0; column < 2 ** depth; column++) {
            const window = windowAround(pixels, [], depth, column, row);
            for (const multiplier of [1, FEET, -1]) {
              const grid = heightGrid(window, subsampleBelow, multiplier);
              for (const interval of [5, 10, 25]) {
                const unlessEmpty = heightGridUnlessEmpty(
                  window,
                  subsampleBelow,
                  multiplier,
                  interval,
                );
                if (unlessEmpty) {
                  expect(valuesOf(unlessEmpty, 1)).toEqual(valuesOf(grid, 1));
                  traced++;
                } else {
                  expect(generateIsolines(interval, grid, 4096, 1)).toEqual({});
                  ruledOut++;
                }
              }
            }
          }
        }
      },
    );
  });

  test("both outcomes were exercised", () => {
    expect(ruledOut).toBeGreaterThan(100);
    expect(traced).toBeGreaterThan(100);
  });

  test("a window that takes the chain of closures is never ruled out", () => {
    const window = windowAround(() => 101, [], 1, 1, 0, 3);
    expect(heightGridUnlessEmpty(window, 1, 1, 10)).toBeDefined();
  });
});

describe("the surface in plain numbers", () => {
  test("at the zoom of the DEM a grid point is the mean of the four pixels around it", () => {
    const grid = heightGrid(windowAround(rough), WIDTH, 1);
    for (let y = -1; y <= WIDTH + 1; y++) {
      for (let x = -1; x <= WIDTH + 1; x++) {
        expect(grid.get(x, y)).toBe(
          mean(
            rough(x - 1, y - 1),
            rough(x, y - 1),
            rough(x - 1, y),
            rough(x, y),
          ),
        );
      }
    }
  });

  test("a missing pixel is left out of the mean", () => {
    const pixels: Pixels = (x, y) => (x === 1 && y === 1 ? HOLE : rough(x, y));
    const grid = heightGrid(windowAround(pixels), WIDTH, 1);
    expect(grid.get(1, 1)).toBe(mean(rough(0, 0), rough(1, 0), rough(0, 1)));
    expect(grid.get(2, 2)).toBe(mean(rough(2, 1), rough(1, 2), rough(2, 2)));
  });

  test("a grid point with no pixel around it is missing", () => {
    const pixels: Pixels = (x, y) =>
      x >= 1 && x <= 2 && y >= 1 && y <= 2 ? HOLE : rough(x, y);
    const grid = heightGrid(windowAround(pixels), WIDTH, 1);
    expect(grid.get(2, 2)).toBeNaN();
    expect(grid.get(1, 1)).toBe(mean(rough(0, 0), rough(1, 0), rough(0, 1)));
  });

  test("a missing DEM tile reads as missing pixels", () => {
    const east = 5;
    const grid = heightGrid(windowAround(rough, [east]), WIDTH, 1);
    expect(grid.get(WIDTH, 2)).toBe(
      mean(rough(WIDTH - 1, 1), rough(WIDTH - 1, 2)),
    );
    expect(grid.get(WIDTH + 1, 2)).toBeNaN();
  });

  test("upsampling fills a missing pixel from the pixels on each side", () => {
    const columns: Pixels = (x) => (x === 1 ? HOLE : 100 * x);
    const grid = heightGrid(windowAround(columns, [], 0, 0, 0, 2), 4, 1);
    expect(grid.width).toBe(5);
    expect([1, 2, 3, 4, 5].map((x) => grid.get(x, 2))).toEqual([
      -12.5, 0, 100, 200, 212.5,
    ]);
  });

  test("a window one pixel wide on a slope of 100 per pixel rises 50 per half pixel", () => {
    const slope: Pixels = (x) => 100 * x;
    const grid = heightGrid(windowAround(slope, [], 2, 1, 1), 2, 1);
    expect(grid.width).toBe(3);
    expect([-1, 0, 1, 2, 3].map((x) => grid.get(x, 1))).toEqual([
      0, 50, 100, 150, 200,
    ]);
  });
});
