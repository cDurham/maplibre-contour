import {
  MARCHING_SQUARES_EXIT,
  countCrossingsOnEdges,
  followContours,
  linesByElevation,
  quantizeHeightsToLevelLattice,
} from "./contour-follower";
import type { HeightBlock } from "./height-grid";
import { HeightTile } from "./height-tile";
import generateIsolines, { CASES } from "./isolines";

type Lines = { [elevation: number]: number[][] };
type Heights = (x: number, y: number) => number;

const EXTENT = 4096;
const BORDER = 3;
const SIDES = ["top", "left", "right", "bottom"];

const rough = (x: number, y: number, seed: number): number =>
  Math.imul((x * 73856093) ^ (y * 19349663) ^ (seed * 83492791), 2654435761) >>>
  22;

const TERRAINS: [string, (seed: number) => Heights][] = [
  [
    "smooth",
    (seed) => (x, y) =>
      Math.fround(
        40 +
          25 * Math.sin(x / 2.3 + seed) * Math.cos(y / 3.1 - seed) +
          rough(x, y, seed) / 400,
      ),
  ],
  ["whole numbers", (seed) => (x, y) => rough(x, y, seed) >> 4],
  ["halves", (seed) => (x, y) => (rough(x, y, seed) >> 3) / 2],
  [
    "smooth with holes",
    (seed) => (x, y) =>
      rough(x, y, seed + 7) < 60
        ? NaN
        : Math.fround(30 + 20 * Math.sin(x / 1.7 + seed) + (y * seed) / 5),
  ],
  [
    "whole numbers with holes",
    (seed) => (x, y) =>
      rough(x, y, seed + 7) < 90 ? NaN : rough(x, y, seed) >> 4,
  ],
];

interface Terrain {
  cells: number;
  stride: number;
  data: Float32Array;
}

function terrain(heights: Heights, cells: number): Terrain {
  const stride = cells + 1 + 2 * BORDER;
  const data = new Float32Array(stride * stride);
  for (let y = 0; y < stride; y++) {
    for (let x = 0; x < stride; x++) {
      data[y * stride + x] = heights(x - BORDER, y - BORDER);
    }
  }
  return { cells, stride, data };
}

function tileOf({ cells, stride, data }: Terrain): HeightTile {
  return new HeightTile(
    cells + 1,
    cells + 1,
    (x, y) => data[(y + BORDER) * stride + x + BORDER],
  );
}

function blockOf(
  { cells, stride, data }: Terrain,
  buffer: number,
  leftColumnAsTodayReadsIt: boolean = false,
): HeightBlock {
  const count = cells + 1 + 2 * buffer;
  const block = new Float32Array(count * count);
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      const column = leftColumnAsTodayReadsIt && x === 0 ? 0 : x - buffer;
      block[y * count + x] =
        data[(y - buffer + BORDER) * stride + column + BORDER];
    }
  }
  return {
    columns: { first: -buffer, count },
    rows: { first: -buffer, count },
    data: block,
  };
}

function isRing(line: number[]): boolean {
  const n = line.length;
  return n >= 8 && line[0] === line[n - 2] && line[1] === line[n - 1];
}

function sameLineWhereverItsRingStarts(line: number[]): string {
  if (!isRing(line)) {
    return line.join(",");
  }
  const points: string[] = [];
  for (let i = 0; i < line.length - 2; i += 2) {
    points.push(`${line[i]},${line[i + 1]}`);
  }
  let best = "";
  for (let start = 0; start < points.length; start++) {
    const rotated = [...points.slice(start), ...points.slice(0, start)].join(
      " ",
    );
    if (best === "" || rotated < best) {
      best = rotated;
    }
  }
  return `ring ${best}`;
}

function inAnyOrder(lines: Lines): { [elevation: string]: string[] } {
  const result: { [elevation: string]: string[] } = {};
  for (const elevation of Object.keys(lines).sort()) {
    result[elevation] = lines[Number(elevation)]
      .map(sameLineWhereverItsRingStarts)
      .sort();
  }
  return result;
}

function segmentsOfLines(
  lines: Lines,
  interval: number,
): { [level: string]: string[] } {
  const result: { [level: string]: string[] } = {};
  for (const elevation of Object.keys(lines)) {
    const level = Math.round(Number(elevation) / interval);
    const segments = result[level] || (result[level] = []);
    for (const line of lines[Number(elevation)]) {
      for (let i = 0; i + 3 < line.length; i += 2) {
        segments.push(
          `${line[i]},${line[i + 1]}>${line[i + 2]},${line[i + 3]}`,
        );
      }
    }
  }
  for (const level of Object.keys(result)) {
    result[level].sort();
  }
  return result;
}

function segmentsByMarchingSquaresOneCellAtATime(
  interval: number,
  heights: HeightBlock,
  scale: number,
): { [level: string]: string[] } {
  const result: { [level: string]: string[] } = {};
  const columns = heights.columns.count;
  const ratio = (a: number, b: number, c: number) => (b - a) / (c - a);
  for (let row = 1; row < heights.rows.count; row++) {
    for (let column = 1; column < columns; column++) {
      const tl = heights.data[(row - 1) * columns + column - 1];
      const tr = heights.data[(row - 1) * columns + column];
      const bl = heights.data[row * columns + column - 1];
      const br = heights.data[row * columns + column];
      if (isNaN(tl) || isNaN(tr) || isNaN(bl) || isNaN(br)) {
        continue;
      }
      const c = column + heights.columns.first;
      const r = row + heights.rows.first;
      const point = ([x, y]: [number, number], threshold: number): string => {
        const at =
          x === 0
            ? [c - 1, r - ratio(bl, threshold, tl)]
            : x === 2
              ? [c, r - ratio(br, threshold, tr)]
              : y === 0
                ? [c - ratio(tr, threshold, tl), r - 1]
                : [c - ratio(br, threshold, bl), r];
        return `${Math.round(scale * at[0])},${Math.round(scale * at[1])}`;
      };
      const lowest = Math.floor(Math.min(tl, tr, bl, br) / interval) - 1;
      const highest = Math.ceil(Math.max(tl, tr, bl, br) / interval) + 1;
      for (let level = lowest; level <= highest; level++) {
        const threshold = level * interval;
        const squareCase =
          (tl > threshold ? 8 : 0) |
          (tr > threshold ? 4 : 0) |
          (br > threshold ? 2 : 0) |
          (bl > threshold ? 1 : 0);
        for (const [start, end] of CASES[squareCase]) {
          (result[level] || (result[level] = [])).push(
            `${point(start, threshold)}>${point(end, threshold)}`,
          );
        }
      }
    }
  }
  for (const level of Object.keys(result)) {
    result[level].sort();
  }
  return result;
}

function follow(
  interval: number,
  block: HeightBlock,
  cells: number,
  multiplier: number = 1,
): Lines {
  return linesByElevation(
    followContours(interval, block, EXTENT / cells, multiplier),
  );
}

test("MARCHING_SQUARES_EXIT is the case table of generateIsolines", () => {
  const side = ([x, y]: [number, number]) =>
    SIDES.indexOf(
      x === 0 ? "left" : x === 2 ? "right" : y === 0 ? "top" : "bottom",
    );
  let segments = 0;
  for (let squareCase = 0; squareCase < 16; squareCase++) {
    for (const [start, end] of CASES[squareCase]) {
      expect(MARCHING_SQUARES_EXIT[squareCase * 4 + side(start)]).toBe(
        side(end),
      );
      segments++;
    }
  }
  expect(MARCHING_SQUARES_EXIT.filter((exit) => exit >= 0).length).toBe(
    segments,
  );
});

describe("quantizeHeightsToLevelLattice", () => {
  test.each([1, 10, 2.5, 0.3, 0.1, 0.7, 1 / 3, 3.28084])(
    "a height has more than i levels below it exactly when generateIsolines finds it above i times the interval of %d",
    (interval) => {
      const heights: number[] = [];
      for (let level = -40; level <= 40; level++) {
        const onLevel = Math.fround(level * interval);
        heights.push(
          level * interval,
          onLevel,
          onLevel + 2 ** -10,
          onLevel - 2 ** -10,
          Math.fround(level * interval + interval / 3),
        );
      }
      const block: HeightBlock = {
        columns: { first: 0, count: heights.length },
        rows: { first: 0, count: 1 },
        data: Float32Array.from(heights),
      };
      const { levelsBelow, stride } = quantizeHeightsToLevelLattice(
        block,
        interval,
        1,
      );
      for (let k = 0; k < heights.length; k++) {
        for (let level = -45; level <= 45; level++) {
          expect(levelsBelow[stride + 1 + k] > level).toBe(
            block.data[k] > level * interval,
          );
        }
      }
    },
  );

  test("a cell is whole when none of its four corners is missing", () => {
    const block: HeightBlock = {
      columns: { first: 0, count: 4 },
      rows: { first: 0, count: 3 },
      data: Float32Array.from([1, 2, 3, 4, 5, NaN, 7, 8, 9, 10, 11, 12]),
    };
    const { cellIsWhole, stride, missing } = quantizeHeightsToLevelLattice(
      block,
      1,
      1,
    );
    expect(missing).toBe(1);
    const whole = (column: number, row: number) =>
      cellIsWhole[(row + 1) * stride + column + 1];
    expect([whole(0, 0), whole(1, 0), whole(2, 0)]).toEqual([0, 0, 1]);
    expect([whole(0, 1), whole(1, 1), whole(2, 1)]).toEqual([0, 0, 1]);
    expect([whole(3, 0), whole(0, 2), whole(-1, 0), whole(0, -1)]).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

describe.each(TERRAINS)("%s", (_, heightsFor) => {
  describe.each([1, 2, 10, 2.5])("interval %d", (interval) => {
    test.each([0, 1, 2, 3])(
      "buffer %d: followContours gives the lines of generateIsolines",
      (buffer) => {
        for (let seed = 1; seed <= 6; seed++) {
          const land = terrain(heightsFor(seed), 5 + seed);
          const today = generateIsolines(
            interval,
            tileOf(land),
            EXTENT,
            buffer,
          );
          const asTodayReadsIt = blockOf(land, buffer, buffer > 0);
          expect(
            inAnyOrder(follow(interval, asTodayReadsIt, land.cells)),
          ).toEqual(inAnyOrder(today));
        }
      },
    );

    test("countCrossingsOnEdges is the number of points generateIsolines writes, and every one is written once", () => {
      for (let seed = 1; seed <= 6; seed++) {
        const land = terrain(heightsFor(seed), 5 + seed);
        const block = blockOf(land, 0);
        const count = countCrossingsOnEdges(
          quantizeHeightsToLevelLattice(block, interval, 1),
        );
        const followed = followContours(interval, block, EXTENT / land.cells);
        const crossings = count.onHorizontalEdges + count.onVerticalEdges;
        const today = generateIsolines(interval, tileOf(land), EXTENT, 0);
        let pointsToday = 0;
        for (const elevation of Object.keys(today)) {
          for (const line of today[Number(elevation)]) {
            pointsToday += line.length / 2;
          }
        }
        const ringsClosedByRepeatingAPoint =
          followed.lineCount - followed.openLineCount;
        expect(crossings).toBe(pointsToday - ringsClosedByRepeatingAPoint);
        expect(followed.points.length).toBe(2 * crossings);
        expect(followed.lineStart[followed.lineCount]).toBe(2 * crossings);
      }
    });

    test.each([1, 2, 3])(
      "buffer %d: with the left column read where it is, only lines that reach x <= 0 differ from generateIsolines",
      (buffer) => {
        let differing = 0;
        for (let seed = 1; seed <= 6; seed++) {
          const land = terrain(heightsFor(seed), 5 + seed);
          const today = inAnyOrder(
            generateIsolines(interval, tileOf(land), EXTENT, buffer),
          );
          const followed = follow(interval, blockOf(land, buffer), land.cells);
          for (const elevation of Object.keys(followed)) {
            for (const line of followed[Number(elevation)]) {
              const same = (today[elevation] || []).includes(
                sameLineWhereverItsRingStarts(line),
              );
              if (!same) {
                differing++;
                expect(
                  line.filter((_, i) => i % 2 === 0).some((x) => x <= 0),
                ).toBe(true);
              }
            }
          }
        }
        expect(differing).toBeGreaterThan(0);
      },
    );
  });

  test.each([1, 10, 2.5, 0.3, 0.1, 0.7, 1 / 3])(
    "interval %d: followContours joins the segments marching squares gives one cell and one level at a time",
    (interval) => {
      for (const buffer of [0, 1, 3]) {
        for (let seed = 1; seed <= 4; seed++) {
          const land = terrain(heightsFor(seed), 5 + seed);
          const block = blockOf(land, buffer);
          const scale = EXTENT / land.cells;
          expect(
            segmentsOfLines(follow(interval, block, land.cells), interval),
          ).toEqual(
            segmentsByMarchingSquaresOneCellAtATime(interval, block, scale),
          );
        }
      }
    },
  );

  test.each([0.3, 0.1, 0.7])(
    "interval %d: every elevation is a whole number of intervals",
    (interval) => {
      const land = terrain(heightsFor(3), 8);
      const followed = followContours(interval, blockOf(land, 1), EXTENT / 8);
      const lines = linesByElevation(followed);
      const elevations = new Set(
        Array.from(followed.lineLevel, (level) => String(level * interval)),
      );
      expect(new Set(Object.keys(lines))).toEqual(elevations);
      expect(followed.lineCount).toBeGreaterThan(10);
    },
  );

  test("a tile and its east neighbor, followed separately, give the segments of both followed as one", () => {
    for (const interval of [1, 2.5]) {
      for (let seed = 1; seed <= 4; seed++) {
        const cells = 8;
        const heights = heightsFor(seed);
        const both = terrain(heights, 2 * cells);
        const wide: HeightBlock = {
          columns: { first: 0, count: 2 * cells + 1 },
          rows: { first: 0, count: cells + 1 },
          data: new Float32Array((2 * cells + 1) * (cells + 1)),
        };
        for (let y = 0; y <= cells; y++) {
          for (let x = 0; x <= 2 * cells; x++) {
            wide.data[y * (2 * cells + 1) + x] =
              both.data[(y + BORDER) * both.stride + x + BORDER];
          }
        }
        const half = (first: number): HeightBlock => {
          const data = new Float32Array((cells + 1) * (cells + 1));
          for (let y = 0; y <= cells; y++) {
            for (let x = 0; x <= cells; x++) {
              data[y * (cells + 1) + x] =
                both.data[(y + BORDER) * both.stride + first + x + BORDER];
            }
          }
          return {
            columns: { first: 0, count: cells + 1 },
            rows: { first: 0, count: cells + 1 },
            data,
          };
        };
        const scale = EXTENT / cells;
        const shifted = (lines: Lines): Lines => {
          const result: Lines = {};
          for (const elevation of Object.keys(lines)) {
            result[Number(elevation)] = lines[Number(elevation)].map((line) =>
              line.map((value, i) => (i % 2 === 0 ? value + EXTENT : value)),
            );
          }
          return result;
        };
        const west = segmentsOfLines(
          follow(interval, half(0), cells),
          interval,
        );
        const east = segmentsOfLines(
          shifted(follow(interval, half(cells), cells)),
          interval,
        );
        const joined: { [level: string]: string[] } = {};
        for (const part of [west, east]) {
          for (const level of Object.keys(part)) {
            (joined[level] || (joined[level] = [])).push(...part[level]);
          }
        }
        for (const level of Object.keys(joined)) {
          joined[level].sort();
        }
        expect(joined).toEqual(
          segmentsOfLines(
            linesByElevation(followContours(interval, wide, scale)),
            interval,
          ),
        );
      }
    }
  });
});

describe("followContours in plain numbers", () => {
  const block = (...rows: number[][]): HeightBlock => ({
    columns: { first: 0, count: rows[0].length },
    rows: { first: 0, count: rows.length },
    data: Float32Array.from(rows.flat()),
  });

  test("a line runs with the higher ground on its left: counterclockwise around a peak", () => {
    const followed = followContours(
      2,
      block([1, 1, 1], [1, 3, 1], [1, 1, 1]),
      2,
    );
    expect(followed.openLineCount).toBe(0);
    expect(followed.lineCount).toBe(1);
    expect(Array.from(followed.lineLevel)).toEqual([1]);
    expect(Array.from(followed.points)).toEqual([2, 3, 3, 2, 2, 1, 1, 2]);
    expect(linesByElevation(followed)).toEqual({
      2: [[2, 3, 3, 2, 2, 1, 1, 2, 2, 3]],
    });
  });

  test("clockwise around a pit", () => {
    const followed = followContours(
      2,
      block([3, 3, 3], [3, 1, 3], [3, 3, 3]),
      2,
    );
    expect(Array.from(followed.points)).toEqual([2, 1, 3, 2, 2, 3, 1, 2]);
  });

  test("a slope rising to the east is crossed from north to south", () => {
    const followed = followContours(
      10,
      block([5, 15, 25], [5, 15, 25], [5, 15, 25]),
      100,
    );
    expect(linesByElevation(followed)).toEqual({
      10: [[50, 0, 50, 100, 50, 200]],
      20: [[150, 0, 150, 100, 150, 200]],
    });
  });

  test("the multiplier converts heights before they are compared with levels", () => {
    const meters = block([30.4, 30.5], [30.4, 30.5]);
    expect(linesByElevation(followContours(100, meters, 100))).toEqual({});
    expect(
      Object.keys(linesByElevation(followContours(100, meters, 100, 3.28084))),
    ).toEqual(["100"]);
  });

  test("a line stops beside a missing height", () => {
    const followed = followContours(
      10,
      block([5, 15, 25], [5, 15, NaN], [5, 15, 25], [5, 15, 25]),
      100,
    );
    expect(linesByElevation(followed)).toEqual({
      10: [[50, 0, 50, 100, 50, 200, 50, 300]],
      20: [[150, 200, 150, 300]],
    });
  });

  test("no interval, flat ground on a level, and no heights give no lines", () => {
    const flat = block([10, 10], [10, 10]);
    expect(followContours(0, flat, 1).lineCount).toBe(0);
    expect(followContours(10, flat, 1).lineCount).toBe(0);
    expect(followContours(10, block([NaN, NaN], [NaN, NaN]), 1).lineCount).toBe(
      0,
    );
    expect(followContours(10, block([1, 20]), 1).lineCount).toBe(0);
  });
});
