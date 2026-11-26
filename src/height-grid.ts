import { HeightTile } from "./height-tile";

export interface HeightArray {
  width: number;
  height: number;
  border: number;
  data: Float32Array;
}

const PIXEL_BORDER = 2;
const GRID_BORDER = 1;

export function heightGrid(
  dem: HeightTile,
  subsampleBelow: number,
  multiplier: number,
): HeightTile {
  if (!Number.isInteger(dem.width) || !Number.isInteger(dem.height)) {
    return gridByClosureChain(dem, subsampleBelow, multiplier);
  }
  const pixels = copyDemPixels(dem);
  const factor = upsamplingFactor(dem.width, subsampleBelow);
  if (factor === 1) {
    return heightTileOver(meanOfFourPixelsAtCorners(pixels, multiplier));
  }
  const grid = gridByQuadraticBSpline(pixels, factor, multiplier);
  if (hasMissingValue(pixels)) {
    takeMissingValuesFrom(
      grid,
      gridByChaikinDoubling(pixels, factor, multiplier),
    );
  }
  return heightTileOver(grid);
}

export function gridByClosureChain(
  dem: HeightTile,
  subsampleBelow: number,
  multiplier: number,
): HeightTile {
  let tile = dem;
  if (tile.width >= subsampleBelow) {
    tile = tile.materialize(2);
  } else {
    while (tile.width < subsampleBelow) {
      tile = tile.subsamplePixelCenters(2).materialize(2);
    }
  }
  return tile
    .averagePixelCentersToGrid()
    .scaleElevation(multiplier)
    .materialize(1);
}

export function upsamplingFactor(
  width: number,
  subsampleBelow: number,
): number {
  let factor = 1;
  while (width * factor < subsampleBelow) {
    factor *= 2;
  }
  return factor;
}

export function copyDemPixels(dem: HeightTile): HeightArray {
  const border = PIXEL_BORDER;
  const data = new Float32Array(
    (dem.width + 2 * border) * (dem.height + 2 * border),
  );
  let out = 0;
  for (let y = -border; y < dem.height + border; y++) {
    for (let x = -border; x < dem.width + border; x++) {
      data[out++] = dem.get(x, y);
    }
  }
  return { width: dem.width, height: dem.height, border, data };
}

export function heightTileOver(heights: HeightArray): HeightTile {
  const { data, border } = heights;
  const stride = heights.width + 2 * border;
  return new HeightTile(
    heights.width,
    heights.height,
    (x, y) => data[(y + border) * stride + x + border],
  );
}

export function gridByChaikinDoubling(
  pixels: HeightArray,
  factor: number,
  multiplier: number,
): HeightArray {
  let doubled = pixels;
  for (let reached = 1; reached < factor; reached *= 2) {
    doubled = chaikinDoublePixels(doubled);
  }
  return meanOfFourPixelsAtCorners(doubled, multiplier);
}

export function chaikinDoublePixels(pixels: HeightArray): HeightArray {
  const border = PIXEL_BORDER;
  const from = pixels.data;
  const fromStride = pixels.width + 2 * border;
  const width = pixels.width * 2;
  const height = pixels.height * 2;
  const data = new Float32Array((width + 2 * border) * (height + 2 * border));
  let out = 0;
  for (let y = -border; y < height + border; y++) {
    const above = y & 1 ? y >> 1 : (y >> 1) - 1;
    const towardBelow = y & 1 ? 0.25 : 0.75;
    const row = (above + border) * fromStride + border;
    for (let x = -border; x < width + border; x++) {
      const left = x & 1 ? x >> 1 : (x >> 1) - 1;
      const towardRight = x & 1 ? 0.25 : 0.75;
      const i = row + left;
      data[out++] = blendSkippingMissing(
        blendSkippingMissing(from[i], from[i + 1], towardRight),
        blendSkippingMissing(
          from[i + fromStride],
          from[i + fromStride + 1],
          towardRight,
        ),
        towardBelow,
      );
    }
  }
  return { width, height, border, data };
}

function blendSkippingMissing(a: number, b: number, towardB: number): number {
  return a !== a ? b : b !== b ? a : a + (b - a) * towardB;
}

export function meanOfFourPixelsAtCorners(
  pixels: HeightArray,
  multiplier: number,
): HeightArray {
  const border = GRID_BORDER;
  const from = pixels.data;
  const fromStride = pixels.width + 2 * pixels.border;
  const width = pixels.width + 1;
  const height = pixels.height + 1;
  const data = new Float32Array((width + 2 * border) * (height + 2 * border));
  let out = 0;
  for (let y = -border; y < height + border; y++) {
    const row = (y - 1 + pixels.border) * fromStride + pixels.border - 1;
    for (let x = -border; x < width + border; x++) {
      const i = row + x;
      const northwest = from[i];
      const southwest = from[i + fromStride];
      const northeast = from[i + 1];
      const southeast = from[i + fromStride + 1];
      let sum = 0;
      let count = 0;
      if (northwest === northwest) {
        sum += northwest;
        count++;
      }
      if (southwest === southwest) {
        sum += southwest;
        count++;
      }
      if (northeast === northeast) {
        sum += northeast;
        count++;
      }
      if (southeast === southeast) {
        sum += southeast;
        count++;
      }
      data[out++] = count === 0 ? NaN : (sum / count) * multiplier;
    }
  }
  return { width, height, border, data };
}

interface SplineTaps {
  count: number;
  first: Int32Array;
  third: Int32Array;
  firstWeight: Float64Array;
  secondWeight: Float64Array;
  thirdWeight: Float64Array;
}

export function quadraticBSplineTaps(
  pixelCount: number,
  factor: number,
): SplineTaps {
  const count = pixelCount * factor + 1 + 2 * GRID_BORDER;
  const taps: SplineTaps = {
    count,
    first: new Int32Array(count),
    third: new Int32Array(count),
    firstWeight: new Float64Array(count),
    secondWeight: new Float64Array(count),
    thirdWeight: new Float64Array(count),
  };
  for (let k = 0; k < count; k++) {
    const gridIndex = k - GRID_BORDER;
    const pixel = Math.floor(gridIndex / factor);
    const t = (gridIndex - pixel * factor) / factor;
    taps.first[k] = pixel - 1 + PIXEL_BORDER;
    taps.third[k] = (t === 0 ? pixel : pixel + 1) + PIXEL_BORDER;
    taps.firstWeight[k] = ((1 - t) * (1 - t)) / 2;
    taps.secondWeight[k] = (-2 * t * t + 2 * t + 1) / 2;
    taps.thirdWeight[k] = (t * t) / 2;
  }
  return taps;
}

export function gridByQuadraticBSpline(
  pixels: HeightArray,
  factor: number,
  multiplier: number,
): HeightArray {
  const from = pixels.data;
  const fromStride = pixels.width + 2 * PIXEL_BORDER;
  const fromRows = pixels.height + 2 * PIXEL_BORDER;
  const columns = quadraticBSplineTaps(pixels.width, factor);
  const rows = quadraticBSplineTaps(pixels.height, factor);
  const stride = columns.count;

  const blendedAlongRows = new Float64Array(fromRows * stride);
  let out = 0;
  for (let row = 0; row < fromRows; row++) {
    const start = row * fromStride;
    for (let k = 0; k < stride; k++) {
      const first = start + columns.first[k];
      blendedAlongRows[out++] =
        columns.firstWeight[k] * from[first] +
        columns.secondWeight[k] * from[first + 1] +
        columns.thirdWeight[k] * from[start + columns.third[k]];
    }
  }

  const data = new Float32Array(stride * rows.count);
  out = 0;
  for (let k = 0; k < rows.count; k++) {
    const first = rows.first[k] * stride;
    const second = first + stride;
    const third = rows.third[k] * stride;
    const firstWeight = rows.firstWeight[k];
    const secondWeight = rows.secondWeight[k];
    const thirdWeight = rows.thirdWeight[k];
    for (let x = 0; x < stride; x++) {
      data[out++] =
        (firstWeight * blendedAlongRows[first + x] +
          secondWeight * blendedAlongRows[second + x] +
          thirdWeight * blendedAlongRows[third + x]) *
        multiplier;
    }
  }
  return {
    width: pixels.width * factor + 1,
    height: pixels.height * factor + 1,
    border: GRID_BORDER,
    data,
  };
}

function hasMissingValue(heights: HeightArray): boolean {
  const { data } = heights;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== data[i]) {
      return true;
    }
  }
  return false;
}

function takeMissingValuesFrom(grid: HeightArray, other: HeightArray): void {
  for (let i = 0; i < grid.data.length; i++) {
    if (grid.data[i] !== grid.data[i]) {
      grid.data[i] = other.data[i];
    }
  }
}
