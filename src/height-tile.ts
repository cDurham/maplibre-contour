import type { DemTile } from "./types";

const MIN_VALID_M = -12000;
const MAX_VALID_M = 9000;
function defaultIsValid(number: number): boolean {
  return !isNaN(number) && number >= MIN_VALID_M && number <= MAX_VALID_M;
}

interface Pixels {
  data: Float32Array;
  offset: number;
  stride: number;
  buffer: number;
  raw: boolean;
}

interface Average {
  pixels: Pixels;
  multiplier: number;
}

function copyRow(
  pixels: Pixels | undefined,
  x: number,
  y: number,
  length: number,
  out: Float32Array,
  start: number,
) {
  if (!pixels) {
    out.fill(NaN, start, start + length);
    return;
  }
  const from = pixels.offset + y * pixels.stride + x;
  out.set(pixels.data.subarray(from, from + length), start);
  if (pixels.raw) {
    for (let i = start; i < start + length; i++) {
      if (!defaultIsValid(out[i])) out[i] = NaN;
    }
  }
}

/** A tile containing elevation values aligned to a grid. */
export class HeightTile {
  get: (x: number, y: number) => number;
  width: number;
  height: number;
  private pixels?: Pixels;
  private neighbors?: (HeightTile | undefined)[];
  private average?: Average;
  constructor(
    width: number,
    height: number,
    get: (x: number, y: number) => number,
  ) {
    this.get = get;
    this.width = width;
    this.height = height;
  }

  /** Construct a height tile from raw DEM pixel values */
  static fromRawDem(demTile: DemTile): HeightTile {
    const tile = new HeightTile(demTile.width, demTile.height, (x, y) => {
      const value = demTile.data[y * demTile.width + x];
      return defaultIsValid(value) ? value : NaN;
    });
    tile.pixels = {
      data: demTile.data,
      offset: 0,
      stride: demTile.width,
      buffer: 0,
      raw: true,
    };
    return tile;
  }

  /**
   * Construct a height tile from values already computed: `data` holds every value from
   * `-buffer, -buffer` to `width + buffer, height + buffer`, row by row. Anything further
   * out is read from `outside`, which is `NaN` everywhere unless given.
   */
  static fromArray(
    width: number,
    height: number,
    data: Float32Array,
    buffer: number = 0,
    outside: (x: number, y: number) => number = () => NaN,
  ): HeightTile {
    const stride = width + 2 * buffer;
    if (data.length !== stride * (height + 2 * buffer)) {
      throw new Error(
        "data must hold (width + 2 * buffer) * (height + 2 * buffer) values",
      );
    }
    const tile = new HeightTile(width, height, (x, y) =>
      x >= -buffer && x < width + buffer && y >= -buffer && y < height + buffer
        ? data[(y + buffer) * stride + x + buffer]
        : outside(x, y),
    );
    tile.pixels = {
      data,
      offset: buffer * stride + buffer,
      stride,
      buffer,
      raw: false,
    };
    return tile;
  }

  /**
   * Construct a height tile from a DEM tile plus it's 8 neighbors, so that
   * you can request `x` or `y` outside the bounds of the original tile.
   *
   * @param neighbors An array containing tiles: `[nw, n, ne, w, c, e, sw, s, se]`
   */
  static combineNeighbors(
    neighbors: (HeightTile | undefined)[],
  ): HeightTile | undefined {
    if (neighbors.length !== 9) {
      throw new Error("Must include a tile plus 8 neighbors");
    }
    const mainTile = neighbors[4];
    if (!mainTile) {
      return undefined;
    }
    const width = mainTile.width;
    const height = mainTile.height;
    const tile = new HeightTile(width, height, (x, y) => {
      let gridIdx = 0;
      if (y < 0) {
        y += height;
      } else if (y < height) {
        gridIdx += 3;
      } else {
        y -= height;
        gridIdx += 6;
      }
      if (x < 0) {
        x += width;
      } else if (x < width) {
        gridIdx += 1;
      } else {
        x -= width;
        gridIdx += 2;
      }
      const grid = neighbors[gridIdx];
      return grid ? grid.get(x, y) : NaN;
    });
    if (
      neighbors.every(
        (neighbor) =>
          !neighbor ||
          (neighbor.pixels &&
            neighbor.width === width &&
            neighbor.height === height),
      )
    ) {
      tile.neighbors = neighbors;
    }
    return tile;
  }

  /**
   * Splits this tile into a `1<<subz` x `1<<subz` grid and returns the tile at coordinates `subx, suby`.
   */
  split = (subz: number, subx: number, suby: number): HeightTile => {
    if (subz === 0) return this;
    const by = 1 << subz;
    const dx = (subx * this.width) / by;
    const dy = (suby * this.height) / by;
    const tile = new HeightTile(this.width / by, this.height / by, (x, y) =>
      this.get(x + dx, y + dy),
    );
    const pixels = this.pixels;
    if (pixels && [dx, dy, tile.width, tile.height].every(Number.isInteger)) {
      tile.pixels = {
        ...pixels,
        offset: pixels.offset + dy * pixels.stride + dx,
        buffer: 0,
      };
    }
    return tile;
  };

  /**
   * Returns a new tile scaled up by `factor` with pixel values that are subsampled using
   * bilinear interpolation between the original height tile values.
   *
   * The original and result tile are assumed to represent values taken at the center of each pixel.
   */
  subsamplePixelCenters = (factor: number): HeightTile => {
    const lerp = (a: number, b: number, f: number) =>
      isNaN(a) ? b : isNaN(b) ? a : a + (b - a) * f;
    if (factor <= 1) return this;
    const sub = 0.5 - 1 / (2 * factor);
    const blerper = (x: number, y: number) => {
      const dx = x / factor - sub;
      const dy = y / factor - sub;
      const ox = Math.floor(dx);
      const oy = Math.floor(dy);
      const a = this.get(ox, oy);
      const b = this.get(ox + 1, oy);
      const c = this.get(ox, oy + 1);
      const d = this.get(ox + 1, oy + 1);
      const fx = dx - ox;
      const fy = dy - oy;
      const top = lerp(a, b, fx);
      const bottom = lerp(c, d, fx);
      return lerp(top, bottom, fy);
    };
    return new HeightTile(this.width * factor, this.height * factor, blerper);
  };

  /**
   * Assumes the input tile represented measurements taken at the center of each pixel, and
   * returns a new tile where values are the height at the top-left of each pixel by averaging
   * the 4 adjacent pixel values.
   */
  averagePixelCentersToGrid = (radius: number = 1): HeightTile => {
    const tile = new HeightTile(this.width + 1, this.height + 1, (x, y) => {
      let sum = 0,
        count = 0,
        v = 0;
      for (let newX = x - radius; newX < x + radius; newX++) {
        for (let newY = y - radius; newY < y + radius; newY++) {
          if (!isNaN((v = this.get(newX, newY)))) {
            count++;
            sum += v;
          }
        }
      }
      return count === 0 ? NaN : sum / count;
    });
    if (radius === 1 && this.pixels && !this.pixels.raw) {
      tile.average = { pixels: this.pixels, multiplier: 1 };
    }
    return tile;
  };

  /** Returns a new tile with elevation values scaled by `multiplier`. */
  scaleElevation = (multiplier: number): HeightTile => {
    if (multiplier === 1) return this;
    const tile = new HeightTile(
      this.width,
      this.height,
      (x, y) => this.get(x, y) * multiplier,
    );
    if (this.average?.multiplier === 1) {
      tile.average = { ...this.average, multiplier };
    }
    return tile;
  };

  /**
   * Precompute every value from `-bufer, -buffer` to `width + buffer, height + buffer` and serve them
   * out of a `Float32Array`. Until this method is called, all `get` requests are lazy and call all previous
   * methods in the chain up to the root DEM tile.
   */
  materialize = (buffer: number = 2): HeightTile => {
    const stride = this.width + 2 * buffer;
    const size = stride * (this.height + 2 * buffer);
    const own = this.pixels;
    if (
      own &&
      !own.raw &&
      own.buffer === buffer &&
      own.stride === stride &&
      own.offset === buffer * stride + buffer &&
      own.data.length === size
    ) {
      return this;
    }
    const data = new Float32Array(size);
    if (
      !this.copyOwn(data, buffer) &&
      !this.copyNeighbors(data, buffer) &&
      !this.fillAverage(data, buffer)
    ) {
      let idx = 0;
      for (let y = -buffer; y < this.height + buffer; y++) {
        for (let x = -buffer; x < this.width + buffer; x++) {
          data[idx++] = this.get(x, y);
        }
      }
    }
    const tile = new HeightTile(
      this.width,
      this.height,
      (x, y) => data[(y + buffer) * stride + x + buffer],
    );
    tile.pixels = {
      data,
      offset: buffer * stride + buffer,
      stride,
      buffer,
      raw: false,
    };
    return tile;
  };

  /**
   * Every value from `-buffer, -buffer` to `width + buffer, height + buffer`, row by row.
   * The array may be the one this tile serves its values from, so treat it as read-only.
   */
  toArray = (buffer: number = 0): Float32Array => {
    const pixels = this.materialize(buffer).pixels;
    if (!pixels) throw new Error("materialize left no values");
    return pixels.data;
  };

  private copyOwn(data: Float32Array, buffer: number): boolean {
    const pixels = this.pixels;
    if (!pixels || buffer > pixels.buffer) return false;
    const length = this.width + 2 * buffer;
    let idx = 0;
    for (let y = -buffer; y < this.height + buffer; y++) {
      copyRow(pixels, -buffer, y, length, data, idx);
      idx += length;
    }
    return true;
  }

  private copyNeighbors(data: Float32Array, buffer: number): boolean {
    const { neighbors, width, height } = this;
    if (!neighbors || buffer > width || buffer > height) return false;
    let idx = 0;
    for (let y = -buffer; y < height + buffer; y++) {
      const west = y < 0 ? 0 : y < height ? 3 : 6;
      const tileY = y < 0 ? y + height : y < height ? y : y - height;
      copyRow(
        neighbors[west]?.pixels,
        width - buffer,
        tileY,
        buffer,
        data,
        idx,
      );
      copyRow(neighbors[west + 1]?.pixels, 0, tileY, width, data, idx + buffer);
      copyRow(
        neighbors[west + 2]?.pixels,
        0,
        tileY,
        buffer,
        data,
        idx + buffer + width,
      );
      idx += width + 2 * buffer;
    }
    return true;
  }

  private fillAverage(data: Float32Array, buffer: number): boolean {
    const average = this.average;
    if (!average || buffer >= average.pixels.buffer) {
      return false;
    }
    const { data: source, offset, stride } = average.pixels;
    const multiplier = average.multiplier;
    const width = this.width + 2 * buffer;
    const height = this.height + 2 * buffer;
    let idx = 0;
    for (let row = 0; row < height; row++) {
      let at = offset + (row - buffer - 1) * stride - buffer - 1;
      for (let col = 0; col < width; col++, at++) {
        let sum = 0,
          count = 0,
          v = 0;
        if (!isNaN((v = source[at]))) {
          count++;
          sum += v;
        }
        if (!isNaN((v = source[at + stride]))) {
          count++;
          sum += v;
        }
        if (!isNaN((v = source[at + 1]))) {
          count++;
          sum += v;
        }
        if (!isNaN((v = source[at + stride + 1]))) {
          count++;
          sum += v;
        }
        data[idx++] = (count === 0 ? NaN : sum / count) * multiplier;
      }
    }
    return true;
  }
}
