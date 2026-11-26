import type { HeightBlock } from "./height-grid";
import { CASES } from "./isolines";

export interface FollowedContours {
  interval: number;
  points: Int32Array;
  lineStart: Int32Array;
  lineLevel: Int32Array;
  lineCount: number;
  openLineCount: number;
}

export interface LevelLattice {
  levelsBelow: Int32Array;
  cellIsWhole: Uint8Array;
  stride: number;
  end: number;
  missing: number;
}

export interface CrossingCount {
  crossingsBefore: Int32Array;
  onHorizontalEdges: number;
  onVerticalEdges: number;
}

const TOP = 0;
const LEFT = 1;
const RIGHT = 2;
const BOTTOM = 3;

export const MARCHING_SQUARES_EXIT = marchingSquaresExits(CASES);

export function marchingSquaresExits(cases: [number, number][][][]): Int8Array {
  const exits = new Int8Array(64).fill(-1);
  for (let squareCase = 0; squareCase < 16; squareCase++) {
    for (const [start, end] of cases[squareCase]) {
      exits[squareCase * 4 + sideOfCasePoint(start)] = sideOfCasePoint(end);
    }
  }
  return exits;
}

function sideOfCasePoint(point: [number, number]): number {
  return point[0] === 0
    ? LEFT
    : point[0] === 2
      ? RIGHT
      : point[1] === 0
        ? TOP
        : BOTTOM;
}

export function followContours(
  interval: number,
  heights: HeightBlock,
  scale: number,
  multiplier: number = 1,
): FollowedContours {
  const columns = heights.columns.count;
  const rows = heights.rows.count;
  if (!(interval > 0) || columns < 2 || rows < 2) {
    return {
      interval,
      points: new Int32Array(0),
      lineStart: new Int32Array(1),
      lineLevel: new Int32Array(0),
      lineCount: 0,
      openLineCount: 0,
    };
  }
  const lattice = quantizeHeightsToLevelLattice(heights, interval, multiplier);
  const count = countCrossingsOnEdges(lattice);
  const follower = new ContourFollower(
    heights,
    lattice,
    count,
    interval,
    scale,
    multiplier,
  );
  follower.followOpenLines();
  const openLineCount = follower.lineCount;
  follower.followRings();
  return {
    interval,
    points: follower.points,
    lineStart: follower.lineStart.subarray(0, follower.lineCount + 1),
    lineLevel: follower.lineLevel.subarray(0, follower.lineCount),
    lineCount: follower.lineCount,
    openLineCount,
  };
}

export function quantizeHeightsToLevelLattice(
  heights: HeightBlock,
  interval: number,
  multiplier: number,
): LevelLattice {
  const { data } = heights;
  const columns = heights.columns.count;
  const rows = heights.rows.count;
  const stride = columns + 1;
  const size = stride * (rows + 2) + 2;
  const levelsBelow = new Int32Array(size);
  const cellIsWhole = new Uint8Array(size);
  let missing = 0;
  for (let row = 1, from = 0; row <= rows; row++) {
    let at = row * stride + 1;
    for (let column = 1; column <= columns; column++, at++, from++) {
      const height = data[from] * multiplier;
      if (height !== height) {
        missing++;
      } else {
        let level = Math.ceil(height / interval);
        if ((level - 1) * interval >= height) {
          level--;
        } else if (level * interval < height) {
          level++;
        }
        levelsBelow[at] = level;
      }
    }
  }
  for (let row = 1; row < rows; row++) {
    cellIsWhole.fill(1, row * stride + 1, row * stride + columns);
  }
  if (missing > 0) {
    for (let row = 1, from = 0; row <= rows; row++) {
      let at = row * stride + 1;
      for (let column = 1; column <= columns; column++, at++, from++) {
        const height = data[from] * multiplier;
        if (height !== height) {
          cellIsWhole[at] = 0;
          cellIsWhole[at - 1] = 0;
          cellIsWhole[at - stride] = 0;
          cellIsWhole[at - stride - 1] = 0;
        }
      }
    }
  }
  return {
    levelsBelow,
    cellIsWhole,
    stride,
    end: (rows + 1) * stride,
    missing,
  };
}

export function countCrossingsOnEdges(lattice: LevelLattice): CrossingCount {
  const { levelsBelow, cellIsWhole, stride, end } = lattice;
  const crossingsBefore = new Int32Array(levelsBelow.length);
  let onHorizontalEdges = 0;
  let onVerticalEdges = 0;
  for (let at = stride; at < end; at++) {
    const here = levelsBelow[at];
    const right = levelsBelow[at + 1];
    const crossings = Math.abs(right - here);
    crossingsBefore[at] = onHorizontalEdges - ((here + right - crossings) >> 1);
    onHorizontalEdges +=
      (cellIsWhole[at - stride] | cellIsWhole[at]) * crossings;
    onVerticalEdges +=
      (cellIsWhole[at - 1] | cellIsWhole[at]) *
      Math.abs(levelsBelow[at + stride] - here);
  }
  return { crossingsBefore, onHorizontalEdges, onVerticalEdges };
}

function roundHalfUp(x: number): number {
  return x === 0.49999999999999994 ? 0 : Math.floor(x + 0.5);
}

class ContourFollower {
  points: Int32Array;
  pointsWritten = 0;
  lineStart = new Int32Array(257);
  lineLevel = new Int32Array(256);
  lineCount = 0;
  private visited: Int32Array;
  private data: Float32Array;
  private columns: number;
  private rows: number;
  private left: number;
  private top: number;
  private levelsBelow: Int32Array;
  private cellIsWhole: Uint8Array;
  private stride: number;
  private end: number;
  private missing: number;
  private crossingsBefore: Int32Array;
  private onHorizontalEdges: number;

  constructor(
    heights: HeightBlock,
    lattice: LevelLattice,
    count: CrossingCount,
    private interval: number,
    private scale: number,
    private multiplier: number,
  ) {
    this.data = heights.data;
    this.columns = heights.columns.count;
    this.rows = heights.rows.count;
    this.left = heights.columns.first;
    this.top = heights.rows.first;
    this.levelsBelow = lattice.levelsBelow;
    this.cellIsWhole = lattice.cellIsWhole;
    this.stride = lattice.stride;
    this.end = lattice.end;
    this.missing = lattice.missing;
    this.crossingsBefore = count.crossingsBefore;
    this.onHorizontalEdges = count.onHorizontalEdges;
    this.points = new Int32Array(
      2 * (count.onHorizontalEdges + count.onVerticalEdges),
    );
    this.visited = new Int32Array(((count.onHorizontalEdges + 31) >>> 5) + 1);
  }

  followOpenLines(): void {
    const { columns, rows } = this;
    if (this.missing > 0) {
      this.followLinesEnteringBetween(1, columns, 1, rows);
    } else {
      this.followLinesEnteringBetween(1, columns, 1, 1);
      this.followLinesEnteringBetween(1, 1, 2, rows - 1);
      this.followLinesEnteringBetween(columns, columns, 2, rows - 1);
      this.followLinesEnteringBetween(1, columns, rows, rows);
    }
  }

  private followLinesEnteringBetween(
    firstColumn: number,
    lastColumn: number,
    firstRow: number,
    lastRow: number,
  ): void {
    const { levelsBelow, cellIsWhole, stride } = this;
    for (let row = firstRow; row <= lastRow; row++) {
      const y = row - 1 + this.top;
      for (let column = firstColumn; column <= lastColumn; column++) {
        const at = row * stride + column;
        const x = column - 1 + this.left;
        const here = cellIsWhole[at];
        const above = cellIsWhole[at - stride];
        const level = levelsBelow[at];
        if (above !== here) {
          const right = levelsBelow[at + 1];
          if (right > level) {
            if (here) {
              for (let i = level; i < right; i++) {
                this.followOpenLine(at, x, y, TOP, i);
              }
            }
          } else if (above) {
            for (let i = right; i < level; i++) {
              this.followOpenLine(at - stride, x, y - 1, BOTTOM, i);
            }
          }
        }
        const west = cellIsWhole[at - 1];
        if (west !== here) {
          const below = levelsBelow[at + stride];
          if (level > below) {
            if (here) {
              for (let i = below; i < level; i++) {
                this.followOpenLine(at, x, y, LEFT, i);
              }
            }
          } else if (west) {
            for (let i = level; i < below; i++) {
              this.followOpenLine(at - 1, x - 1, y, RIGHT, i);
            }
          }
        }
      }
    }
  }

  followRings(): void {
    const { visited, crossingsBefore, levelsBelow, stride, end } = this;
    const crossings = this.onHorizontalEdges;
    const words = (crossings + 31) >>> 5;
    for (let word = 0; word < words; word++) {
      const inUse =
        word === words - 1 && (crossings & 31) !== 0
          ? (1 << (crossings & 31)) - 1
          : -1;
      let unvisited = ~visited[word] & inUse;
      while (unvisited !== 0) {
        const crossing = word * 32 + 31 - Math.clz32(unvisited & -unvisited);
        let low = stride;
        let high = end;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (
            crossingsBefore[middle] +
              Math.min(levelsBelow[middle], levelsBelow[middle + 1]) >
            crossing
          ) {
            high = middle;
          } else {
            low = middle + 1;
          }
        }
        const at = low - 1;
        const level = crossing - crossingsBefore[at];
        const row = (at / stride) | 0;
        const x = at - row * stride - 1 + this.left;
        const y = row - 1 + this.top;
        this.startLine(level);
        if (levelsBelow[at + 1] > levelsBelow[at]) {
          this.followThroughCells(at, x, y, TOP, level, at);
        } else {
          this.followThroughCells(at - stride, x, y - 1, BOTTOM, level, at);
        }
        unvisited = ~visited[word] & inUse;
      }
    }
    this.lineStart[this.lineCount] = this.pointsWritten;
  }

  private startLine(level: number): void {
    if (this.lineCount + 1 >= this.lineLevel.length) {
      const capacity = this.lineLevel.length * 2;
      const lineStart = new Int32Array(capacity + 1);
      const lineLevel = new Int32Array(capacity);
      lineStart.set(this.lineStart);
      lineLevel.set(this.lineLevel);
      this.lineStart = lineStart;
      this.lineLevel = lineLevel;
    }
    this.lineStart[this.lineCount] = this.pointsWritten;
    this.lineLevel[this.lineCount] = level;
    this.lineCount++;
  }

  private followOpenLine(
    cell: number,
    x: number,
    y: number,
    entry: number,
    level: number,
  ): void {
    this.startLine(level);
    this.writeEntryPoint(cell, x, y, entry, level);
    this.followThroughCells(cell, x, y, entry, level, -2);
  }

  private writeEntryPoint(
    cell: number,
    x: number,
    y: number,
    entry: number,
    level: number,
  ): void {
    const { data, points, columns, scale, multiplier } = this;
    const threshold = level * this.interval;
    const written = this.pointsWritten;
    const from = (y - this.top) * columns + (x - this.left);
    if (entry === TOP || entry === BOTTOM) {
      const down = entry === TOP ? 0 : 1;
      const right = data[from + down * columns + 1] * multiplier;
      const left = data[from + down * columns] * multiplier;
      points[written] = roundHalfUp(
        scale * (x + 1 - (threshold - right) / (left - right)),
      );
      points[written + 1] = roundHalfUp(scale * (y + down));
      const bit = this.crossingsBefore[cell + down * this.stride] + level;
      this.visited[bit >>> 5] |= 1 << (bit & 31);
    } else {
      const across = entry === LEFT ? 0 : 1;
      const bottom = data[from + columns + across] * multiplier;
      const top = data[from + across] * multiplier;
      points[written] = roundHalfUp(scale * (x + across));
      points[written + 1] = roundHalfUp(
        scale * (y + 1 - (threshold - bottom) / (top - bottom)),
      );
    }
    this.pointsWritten = written + 2;
  }

  private followThroughCells(
    cell: number,
    x: number,
    y: number,
    entry: number,
    level: number,
    stopAtEdge: number,
  ): void {
    const { levelsBelow, cellIsWhole, crossingsBefore, visited, data, points } =
      this;
    const { columns, stride, scale, multiplier } = this;
    const threshold = level * this.interval;
    let written = this.pointsWritten;
    let from = (y - this.top) * columns + (x - this.left);
    for (;;) {
      const squareCase =
        (levelsBelow[cell] > level ? 8 : 0) |
        (levelsBelow[cell + 1] > level ? 4 : 0) |
        (levelsBelow[cell + stride + 1] > level ? 2 : 0) |
        (levelsBelow[cell + stride] > level ? 1 : 0);
      const exit = MARCHING_SQUARES_EXIT[(squareCase << 2) | entry];
      if (exit === TOP) {
        const right = data[from + 1] * multiplier;
        const left = data[from] * multiplier;
        points[written] = roundHalfUp(
          scale * (x + 1 - (threshold - right) / (left - right)),
        );
        points[written + 1] = roundHalfUp(scale * y);
        written += 2;
        const bit = crossingsBefore[cell] + level;
        visited[bit >>> 5] |= 1 << (bit & 31);
        if (cell === stopAtEdge) {
          break;
        }
        cell -= stride;
        from -= columns;
        y--;
        entry = BOTTOM;
      } else if (exit === BOTTOM) {
        const right = data[from + columns + 1] * multiplier;
        const left = data[from + columns] * multiplier;
        points[written] = roundHalfUp(
          scale * (x + 1 - (threshold - right) / (left - right)),
        );
        points[written + 1] = roundHalfUp(scale * (y + 1));
        written += 2;
        const edge = cell + stride;
        const bit = crossingsBefore[edge] + level;
        visited[bit >>> 5] |= 1 << (bit & 31);
        if (edge === stopAtEdge) {
          break;
        }
        cell = edge;
        from += columns;
        y++;
        entry = TOP;
      } else if (exit === LEFT) {
        const bottom = data[from + columns] * multiplier;
        const top = data[from] * multiplier;
        points[written] = roundHalfUp(scale * x);
        points[written + 1] = roundHalfUp(
          scale * (y + 1 - (threshold - bottom) / (top - bottom)),
        );
        written += 2;
        cell--;
        from--;
        x--;
        entry = RIGHT;
      } else if (exit === RIGHT) {
        const bottom = data[from + columns + 1] * multiplier;
        const top = data[from + 1] * multiplier;
        points[written] = roundHalfUp(scale * (x + 1));
        points[written + 1] = roundHalfUp(
          scale * (y + 1 - (threshold - bottom) / (top - bottom)),
        );
        written += 2;
        cell++;
        from++;
        x++;
        entry = LEFT;
      } else {
        throw new Error(
          `No contour leaves cell ${cell} from side ${entry} at level ${level}`,
        );
      }
      if (cellIsWhole[cell] === 0) {
        break;
      }
    }
    this.pointsWritten = written;
  }
}

export function linesByElevation(followed: FollowedContours): {
  [elevation: number]: number[][];
} {
  const { points, lineStart, lineLevel, openLineCount, interval } = followed;
  const lines: { [elevation: number]: number[][] } = {};
  for (let line = 0; line < followed.lineCount; line++) {
    const start = lineStart[line];
    const length = lineStart[line + 1] - start;
    const isRing = line >= openLineCount;
    const coordinates = new Array<number>(isRing ? length + 2 : length);
    for (let i = 0; i < length; i++) {
      coordinates[i] = points[start + i];
    }
    if (isRing) {
      coordinates[length] = points[start];
      coordinates[length + 1] = points[start + 1];
    }
    const elevation = lineLevel[line] * interval;
    (lines[elevation] || (lines[elevation] = [])).push(coordinates);
  }
  return lines;
}
