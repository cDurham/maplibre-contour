import { HeightTile } from "./height-tile";
import {
  chaikinDoublePixels,
  copyDemPixels,
  gridByChaikinDoubling,
  gridByClosureChain,
  gridByQuadraticBSpline,
  heightGrid,
  meanOfFourPixelsAtCorners,
  upsamplingFactor,
} from "./height-grid";
import type { HeightArray } from "./height-grid";

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
  ["a missing east neighbor", rough, [5]],
  ["only the center tile", fractional, [0, 1, 2, 3, 5, 6, 7, 8]],
];

function demAround(
  pixels: Pixels,
  missingNeighbors: number[] = [],
  width: number = WIDTH,
): HeightTile {
  const neighbors: (HeightTile | undefined)[] = [];
  for (let i = 0; i < 9; i++) {
    const left = ((i % 3) - 1) * width;
    const top = (Math.floor(i / 3) - 1) * width;
    const data = new Float32Array(width * width);
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        data[y * width + x] = pixels(left + x, top + y);
      }
    }
    neighbors.push(
      missingNeighbors.includes(i)
        ? undefined
        : HeightTile.fromRawDem({ width, height: width, data }),
    );
  }
  return HeightTile.combineNeighbors(neighbors) as HeightTile;
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

function expectSameAsTile(heights: HeightArray, tile: HeightTile) {
  expect(heights).toMatchObject({ width: tile.width, height: tile.height });
  expect(heights.data).toEqual(valuesOf(tile, heights.border));
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
  factor: number,
  multiplier: number,
): Float32Array {
  const values: number[] = [];
  for (let y = -1; y <= WIDTH * factor + 1; y++) {
    for (let x = -1; x <= WIDTH * factor + 1; x++) {
      values.push(spline(pixels, x / factor, y / factor) * multiplier);
    }
  }
  return Float32Array.from(values);
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
  describe.each(TERRAINS)("%s", (_, pixels, missingNeighbors) => {
    const dem = demAround(pixels, missingNeighbors);

    test("copyDemPixels is materialize(2)", () => {
      expectSameAsTile(copyDemPixels(dem), dem.materialize(2));
    });

    test("chaikinDoublePixels is subsamplePixelCenters(2).materialize(2)", () => {
      const once = chaikinDoublePixels(copyDemPixels(dem));
      const onceBefore = dem.subsamplePixelCenters(2).materialize(2);
      expectSameAsTile(once, onceBefore);
      expectSameAsTile(
        chaikinDoublePixels(once),
        onceBefore.subsamplePixelCenters(2).materialize(2),
      );
    });

    test.each([1, FEET])(
      "meanOfFourPixelsAtCorners is averagePixelCentersToGrid().scaleElevation(%d).materialize(1)",
      (multiplier) => {
        expectSameAsTile(
          meanOfFourPixelsAtCorners(copyDemPixels(dem), multiplier),
          dem
            .materialize(2)
            .averagePixelCentersToGrid()
            .scaleElevation(multiplier)
            .materialize(1),
        );
      },
    );

    test.each([1, ...FACTORS])(
      "gridByChaikinDoubling %dx is the chain of closures",
      (factor) => {
        expectSameAsTile(
          gridByChaikinDoubling(copyDemPixels(dem), factor, FEET),
          gridByClosureChain(dem, WIDTH * factor, FEET),
        );
      },
    );
  });
});

test("upsamplingFactor doubles until the width reaches subsampleBelow", () => {
  expect(upsamplingFactor(512, 100)).toBe(1);
  expect(upsamplingFactor(100, 100)).toBe(1);
  expect(upsamplingFactor(64, 100)).toBe(2);
  expect(upsamplingFactor(32, 100)).toBe(4);
  expect(upsamplingFactor(1, 100)).toBe(128);
});

describe("gridByQuadraticBSpline", () => {
  describe.each(FACTORS)("%dx", (factor) => {
    test("is the biquadratic B-spline with the DEM pixels as control points", () => {
      const grid = gridByQuadraticBSpline(
        copyDemPixels(demAround(rough)),
        factor,
        FEET,
      );
      expect(grid).toMatchObject({
        width: WIDTH * factor + 1,
        height: WIDTH * factor + 1,
        border: 1,
      });
      expect(grid.data).toEqual(splineGrid(rough, factor, FEET));
    });

    test("is missing exactly where a pixel it blends is missing", () => {
      const pixels = withHoles(rough);
      const grid = gridByQuadraticBSpline(
        copyDemPixels(demAround(pixels, [5])),
        factor,
        1,
      );
      const eastMissing: Pixels = (x, y) => (x >= WIDTH ? HOLE : pixels(x, y));
      expect(grid.data).toEqual(splineGrid(eastMissing, factor, 1));
    });
  });
});

describe("heightGrid", () => {
  describe.each(TERRAINS)("%s", (_, pixels, missingNeighbors) => {
    const dem = demAround(pixels, missingNeighbors);

    test("at the zoom of the DEM is the chain of closures", () => {
      const grid = heightGrid(dem, WIDTH, FEET);
      const before = gridByClosureChain(dem, WIDTH, FEET);
      expect(grid).toMatchObject({ width: WIDTH + 1, height: WIDTH + 1 });
      expect(valuesOf(grid, 1)).toEqual(valuesOf(before, 1));
    });

    test.each(FACTORS)(
      "upsampled %dx is the spline, and the chain of closures where a pixel is missing",
      (factor) => {
        const size = WIDTH * factor;
        const grid = valuesOf(heightGrid(dem, size, FEET), 1);
        const before = valuesOf(gridByClosureChain(dem, size, FEET), 1);
        const direct = gridByQuadraticBSpline(copyDemPixels(dem), factor, FEET);
        for (let i = 0; i < grid.length; i++) {
          expect(grid[i]).toBe(
            isNaN(direct.data[i]) ? before[i] : direct.data[i],
          );
        }
      },
    );
  });

  test.each([2, 4])(
    "upsampled %dx on whole meters is the chain of closures bit for bit",
    (factor) => {
      const dem = demAround(rough);
      expect(valuesOf(heightGrid(dem, WIDTH * factor, FEET), 1)).toEqual(
        valuesOf(gridByClosureChain(dem, WIDTH * factor, FEET), 1),
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
        const dem = demAround(pixels);
        expect(
          largestDifferenceInFloat32Steps(
            valuesOf(heightGrid(dem, WIDTH * factor, 1), 1),
            valuesOf(gridByClosureChain(dem, WIDTH * factor, 1), 1),
          ),
        ).toBeLessThanOrEqual(steps);
      }
    },
  );

  test("a window that is not a whole number of pixels takes the chain of closures", () => {
    const dem = demAround(rough).split(3, 1, 2);
    expect(dem.width).toBe(0.5);
    expect(valuesOf(heightGrid(dem, 4, 1), 1)).toEqual(
      valuesOf(gridByClosureChain(dem, 4, 1), 1),
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
        const west = heightGrid(demAround(pixels), size, FEET);
        const east = heightGrid(
          demAround((x, y) => pixels(x + WIDTH, y)),
          size,
          FEET,
        );
        const south = heightGrid(
          demAround((x, y) => pixels(x, y + WIDTH)),
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

describe("the surface in plain numbers", () => {
  test("at the zoom of the DEM a grid point is the mean of the four pixels around it", () => {
    const grid = heightGrid(demAround(rough), WIDTH, 1);
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
    const grid = heightGrid(demAround(pixels), WIDTH, 1);
    expect(grid.get(1, 1)).toBe(mean(rough(0, 0), rough(1, 0), rough(0, 1)));
    expect(grid.get(2, 2)).toBe(mean(rough(2, 1), rough(1, 2), rough(2, 2)));
  });

  test("a grid point with no pixel around it is missing", () => {
    const pixels: Pixels = (x, y) =>
      x >= 1 && x <= 2 && y >= 1 && y <= 2 ? HOLE : rough(x, y);
    const grid = heightGrid(demAround(pixels), WIDTH, 1);
    expect(grid.get(2, 2)).toBeNaN();
    expect(grid.get(1, 1)).toBe(mean(rough(0, 0), rough(1, 0), rough(0, 1)));
  });

  test("a missing neighbor tile reads as missing pixels", () => {
    const east = 5;
    const grid = heightGrid(demAround(rough, [east]), WIDTH, 1);
    expect(grid.get(WIDTH, 2)).toBe(
      mean(rough(WIDTH - 1, 1), rough(WIDTH - 1, 2)),
    );
    expect(grid.get(WIDTH + 1, 2)).toBeNaN();
  });

  test("upsampling fills a missing pixel from the pixels on each side", () => {
    const columns: Pixels = (x) => (x === 1 ? HOLE : 100 * x);
    const grid = heightGrid(demAround(columns, [], 2), 4, 1);
    expect(grid.width).toBe(5);
    expect([1, 2, 3, 4, 5].map((x) => grid.get(x, 2))).toEqual([
      -12.5, 0, 100, 200, 212.5,
    ]);
  });
});
