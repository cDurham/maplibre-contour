/*
Adapted from d3-contour https://github.com/d3/d3-contour

Copyright 2012-2023 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
*/

import type { HeightTile } from "./height-tile";

function pushAll(target: number[], source: number[]) {
  for (let i = 0; i < source.length; i++) {
    target.push(source[i]);
  }
}

function pushPairsReversed(target: number[], source: number[]) {
  for (let i = source.length - 2; i >= 0; i -= 2) {
    target.push(source[i], source[i + 1]);
  }
}

const NOWHERE = -1;
const NO_EDGE = -2147483648;

/**
 * The line ends still waiting for the cell on their other side, for one elevation.
 *
 * The scan goes row by row, so a waiting end is either on the bottom edge of a cell, to be
 * met by the cell below it, or on the right edge of the cell just scanned, to be met by the
 * next. There is one slot per column for the first and one more for the second. A slot also
 * keeps the edge it was written for, because the cell it waits for may be skipped.
 */
class Level {
  endEdges: Int32Array;
  ends: Fragment[];
  startEdges: Int32Array;
  starts: Fragment[];
  fragments: Fragment[] = [];

  constructor(slots: number) {
    this.endEdges = new Int32Array(slots).fill(NO_EDGE);
    this.ends = new Array(slots);
    this.startEdges = new Int32Array(slots).fill(NO_EDGE);
    this.starts = new Array(slots);
  }
}

class Fragment {
  start: number;
  end: number;
  /** Where `end` is kept in its level's `ends`, or `NOWHERE`. */
  endSlot: number;
  /** When `start` was last set: the order unfinished lines come out in. */
  order: number;
  /** False once the line has closed into a ring or been joined onto another. */
  open: boolean;
  prepended: number[];
  appended: number[];

  constructor(start: number, end: number, order: number) {
    this.start = start;
    this.end = end;
    this.endSlot = NOWHERE;
    this.order = order;
    this.open = true;
    this.prepended = [];
    this.appended = [];
  }

  lineString() {
    return this.toArray();
  }

  size() {
    return this.prepended.length + this.appended.length;
  }

  isEmpty() {
    return this.size() < 2;
  }

  appendFragment(other: Fragment) {
    if (this.size() >= other.size()) {
      pushPairsReversed(this.appended, other.prepended);
      pushAll(this.appended, other.appended);
    } else {
      pushPairsReversed(other.prepended, this.appended);
      pushAll(other.prepended, this.prepended);
      this.prepended = other.prepended;
      this.appended = other.appended;
    }
    this.end = other.end;
  }

  toArray() {
    if (this.prepended.length === 0) {
      return this.appended;
    }
    const result: number[] = [];
    pushPairsReversed(result, this.prepended);
    pushAll(result, this.appended);
    return result;
  }
}

const CASES: [number, number][][][] = [
  [],
  [
    [
      [1, 2],
      [0, 1],
    ],
  ],
  [
    [
      [2, 1],
      [1, 2],
    ],
  ],
  [
    [
      [2, 1],
      [0, 1],
    ],
  ],
  [
    [
      [1, 0],
      [2, 1],
    ],
  ],
  [
    [
      [1, 2],
      [0, 1],
    ],
    [
      [1, 0],
      [2, 1],
    ],
  ],
  [
    [
      [1, 0],
      [1, 2],
    ],
  ],
  [
    [
      [1, 0],
      [0, 1],
    ],
  ],
  [
    [
      [0, 1],
      [1, 0],
    ],
  ],
  [
    [
      [1, 2],
      [1, 0],
    ],
  ],
  [
    [
      [0, 1],
      [1, 0],
    ],
    [
      [2, 1],
      [1, 2],
    ],
  ],
  [
    [
      [2, 1],
      [1, 0],
    ],
  ],
  [
    [
      [0, 1],
      [2, 1],
    ],
  ],
  [
    [
      [1, 2],
      [2, 1],
    ],
  ],
  [
    [
      [0, 1],
      [1, 2],
    ],
  ],
  [],
];

function index(width: number, x: number, y: number, point: [number, number]) {
  x = x * 2 + point[0];
  y = y * 2 + point[1];
  return x + y * (width + 1) * 2;
}

function ratio(a: number, b: number, c: number) {
  return (b - a) / (c - a);
}

/**
 * Adds to `points` where the contour at `threshold` crosses the edge `point` of the cell
 * whose bottom-right corner is at column `c`, row `r`.
 */
function cross(
  points: number[],
  point: [number, number],
  threshold: number,
  multiplier: number,
  c: number,
  r: number,
  tld: number,
  trd: number,
  bld: number,
  brd: number,
) {
  if (point[0] === 0) {
    // left
    points.push(
      Math.round(multiplier * (c - 1)),
      Math.round(multiplier * (r - ratio(bld, threshold, tld))),
    );
  } else if (point[0] === 2) {
    // right
    points.push(
      Math.round(multiplier * c),
      Math.round(multiplier * (r - ratio(brd, threshold, trd))),
    );
  } else if (point[1] === 0) {
    // top
    points.push(
      Math.round(multiplier * (c - ratio(trd, threshold, tld))),
      Math.round(multiplier * (r - 1)),
    );
  } else {
    // bottom
    points.push(
      Math.round(multiplier * (c - ratio(brd, threshold, bld))),
      Math.round(multiplier * r),
    );
  }
}

/**
 * Every value the scan reads, row by row from `-buffer, -buffer`: the tile's own array when
 * it has been materialized to this buffer, and otherwise each value read once, as it is.
 */
function heightsOf(
  tile: HeightTile,
  buffer: number,
): Float32Array | Float64Array {
  const own = tile.ownArray(buffer);
  if (own) return own;
  const stride = tile.width + 2 * buffer;
  const heights = new Float64Array(stride * (tile.height + 2 * buffer));
  let idx = 0;
  for (let y = -buffer; y < tile.height + buffer; y++) {
    for (let x = -buffer; x < tile.width + buffer; x++) {
      heights[idx++] = tile.get(x, y);
    }
  }
  return heights;
}

/**
 * Generates contour lines from a HeightTile
 *
 * @param interval Vertical distance between contours
 * @param tile The input height tile, where values represent the height at the top-left of each pixel
 * @param extent Vector tile extent (default 4096)
 * @param buffer How many pixels into each neighboring tile to include in a tile
 * @returns an object where keys are the elevation, and values are a list of `[x1, y1, x2, y2, ...]`
 * contour lines in tile coordinates
 */
export default function generateIsolines(
  interval: number,
  tile: HeightTile,
  extent: number = 4096,
  buffer: number = 1,
): { [ele: number]: number[][] } {
  if (!interval) {
    return {};
  }
  const width = tile.width;
  const multiplier = extent / (width - 1);
  const stride = width + 2 * buffer;
  const origin = buffer * stride + buffer;
  const heights = heightsOf(tile, buffer);
  let tld: number, trd: number, bld: number, brd: number;
  const segments: { [ele: string]: number[][] } = {};
  const levels: Map<number, Level> = new Map();
  const columnSlot = buffer - 1;
  const sideSlot = width + 2 * buffer - 1;
  let threshold = NaN;
  let level = new Level(0);
  let order = 0;

  // Most marching-squares implementations (d3-contour, gdal-contour) make one pass through the matrix per threshold.
  // This implementation makes a single pass through the matrix, building up all of the contour lines at the
  // same time to improve performance.
  for (let r = 1 - buffer; r < tile.height + buffer; r++) {
    const above = origin + (r - 1) * stride;
    const below = origin + r * stride;
    trd = heights[above];
    brd = heights[below];
    let minR = Math.min(trd, brd);
    let maxR = Math.max(trd, brd);
    for (let c = 1 - buffer; c < width + buffer; c++) {
      tld = trd;
      bld = brd;
      trd = heights[above + c];
      brd = heights[below + c];
      const minL = minR;
      const maxL = maxR;
      minR = Math.min(trd, brd);
      maxR = Math.max(trd, brd);
      if (isNaN(tld) || isNaN(trd) || isNaN(brd) || isNaN(bld)) {
        continue;
      }
      const min = Math.min(minL, minR);
      const max = Math.max(maxL, maxR);
      const start = Math.ceil(min / interval) * interval;
      const end = Math.floor(max / interval) * interval;
      for (let t = start; t <= end; t += interval) {
        const tl = tld > t;
        const tr = trd > t;
        const bl = bld > t;
        const br = brd > t;
        const cellSegments =
          CASES[(tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)];
        for (let s = 0; s < cellSegments.length; s++) {
          const segment = cellSegments[s];
          if (t !== threshold) {
            threshold = t;
            let found = levels.get(t);
            if (!found) levels.set(t, (found = new Level(sideSlot + 1)));
            level = found;
          }
          const start = segment[0];
          const end = segment[1];
          const startIndex = index(width, c, r, start);
          const endIndex = index(width, c, r, end);
          const startSlot = start[0] === 1 ? c + columnSlot : sideSlot;
          const endSlot = end[0] === 1 ? c + columnSlot : sideSlot;
          // only a bottom or a right edge has a cell still to come on its other side
          const startWaits = start[0] === 2 || start[1] === 2;
          const endWaits = end[0] === 2 || end[1] === 2;
          let f: Fragment | undefined, g: Fragment | undefined;

          if (level.endEdges[startSlot] === startIndex) {
            f = level.ends[startSlot];
            level.endEdges[startSlot] = NO_EDGE;
            if (level.startEdges[endSlot] === endIndex) {
              g = level.starts[endSlot];
              level.startEdges[endSlot] = NO_EDGE;
              if (f === g) {
                // closing a ring
                cross(f.appended, end, t, multiplier, c, r, tld, trd, bld, brd);
                f.open = false;
                if (!f.isEmpty()) {
                  let list = segments[t];
                  if (!list) {
                    segments[t] = list = [];
                  }
                  list.push(f.lineString());
                }
              } else {
                // connecting 2 segments
                f.appendFragment(g);
                g.open = false;
                f.end = g.end;
                f.endSlot = g.endSlot;
                if (
                  f.endSlot !== NOWHERE &&
                  level.endEdges[f.endSlot] === f.end
                ) {
                  level.ends[f.endSlot] = f;
                }
              }
            } else {
              // adding to the end of f
              cross(f.appended, end, t, multiplier, c, r, tld, trd, bld, brd);
              f.end = endIndex;
              if (endWaits) {
                f.endSlot = endSlot;
                level.endEdges[endSlot] = endIndex;
                level.ends[endSlot] = f;
              } else {
                f.endSlot = NOWHERE;
              }
            }
          } else if (level.startEdges[endSlot] === endIndex) {
            f = level.starts[endSlot];
            level.startEdges[endSlot] = NO_EDGE;
            // extending the start of f
            cross(f.prepended, start, t, multiplier, c, r, tld, trd, bld, brd);
            f.start = startIndex;
            f.order = order++;
            if (startWaits) {
              level.startEdges[startSlot] = startIndex;
              level.starts[startSlot] = f;
            }
          } else {
            // starting a new fragment
            const newFrag = new Fragment(startIndex, endIndex, order++);
            level.fragments.push(newFrag);
            const points = newFrag.appended;
            cross(points, start, t, multiplier, c, r, tld, trd, bld, brd);
            cross(points, end, t, multiplier, c, r, tld, trd, bld, brd);
            if (startWaits) {
              level.startEdges[startSlot] = startIndex;
              level.starts[startSlot] = newFrag;
            }
            if (endWaits) {
              newFrag.endSlot = endSlot;
              level.endEdges[endSlot] = endIndex;
              level.ends[endSlot] = newFrag;
            }
          }
        }
      }
    }
  }

  for (const [ele, { fragments }] of levels.entries()) {
    let list: number[][] | null = null;
    const unfinished = fragments
      .filter((fragment) => fragment.open)
      .sort((a, b) => a.order - b.order);
    for (const value of unfinished) {
      if (!value.isEmpty()) {
        if (list == null) {
          list = segments[ele] || (segments[ele] = []);
        }
        list.push(value.lineString());
      }
    }
  }

  return segments;
}
