import { HeightTile, MAX_VALID_M, MIN_VALID_M } from "./height-tile";
import type { DemTile } from "./types";

export interface Span {
  first: number;
  count: number;
}

export interface HeightBlock {
  columns: Span;
  rows: Span;
  data: Float32Array;
}

export interface DemWindow {
  tiles: (DemTile | undefined)[];
  depth: number;
  column: number;
  row: number;
}

export interface GridLayout {
  factor: number;
  cellsAcross: number;
  cellsDown: number;
  columns: Span;
  rows: Span;
}

const CENTER = 4;
const GRID_BORDER = 1;

export function heightGrid(
  window: DemWindow,
  subsampleBelow: number,
  multiplier: number,
): HeightTile {
  const layout = gridLayout(window, subsampleBelow);
  return layout
    ? gridOverDemPixels(
        layout,
        demPixelsUnderLayout(window, layout),
        multiplier,
      )
    : gridByClosureChain(demByClosures(window), subsampleBelow, multiplier);
}

function demPixelsUnderLayout(
  window: DemWindow,
  layout: GridLayout,
): HeightBlock {
  return gatherDemPixels(
    window.tiles,
    demPixelsUnderGrid(layout.columns, layout.factor),
    demPixelsUnderGrid(layout.rows, layout.factor),
  );
}

function gridOverDemPixels(
  layout: GridLayout,
  pixels: HeightBlock,
  multiplier: number,
): HeightTile {
  const { factor, columns, rows } = layout;
  const grid =
    factor === 1
      ? meanOfFourPixelsAtCorners(pixels, columns, rows, multiplier)
      : gridByQuadraticBSpline(pixels, factor, columns, rows, multiplier);
  if (factor > 1 && hasMissingValue(pixels)) {
    takeMissingValuesFrom(
      grid,
      gridByChaikinDoubling(pixels, factor, columns, rows, multiplier),
    );
  }
  return heightTileOver(
    grid,
    columns.first + GRID_BORDER,
    rows.first + GRID_BORDER,
    layout.cellsAcross + 1,
    layout.cellsDown + 1,
  );
}

export function gridLayout(
  window: DemWindow,
  subsampleBelow: number,
): GridLayout | undefined {
  const center = centerOf(window);
  const splits = 2 ** window.depth;
  const factor = upsamplingFactor(center.width / splits, subsampleBelow);
  const cellsAcross = (center.width * factor) / splits;
  const cellsDown = (center.height * factor) / splits;
  if (!Number.isInteger(cellsAcross) || !Number.isInteger(cellsDown)) {
    return undefined;
  }
  return {
    factor,
    cellsAcross,
    cellsDown,
    columns: {
      first: window.column * cellsAcross - GRID_BORDER,
      count: cellsAcross + 1 + 2 * GRID_BORDER,
    },
    rows: {
      first: window.row * cellsDown - GRID_BORDER,
      count: cellsDown + 1 + 2 * GRID_BORDER,
    },
  };
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

export function demPixelsUnderGrid(grid: Span, factor: number): Span {
  const first = Math.floor(grid.first / factor) - 1;
  const last = Math.ceil((grid.first + grid.count - 1) / factor);
  return { first, count: last - first + 1 };
}

export function demTilesUnderNeighbors(
  depth: number,
  column: number,
  row: number,
): number[] {
  const splits = 2 ** depth;
  const tiles = new Set<number>();
  for (let down = -1; down <= 1; down++) {
    for (let across = -1; across <= 1; across++) {
      tiles.add(demTileUnder(column + across, row + down, splits));
    }
  }
  return [...tiles];
}

export function demTilesRead(
  window: DemWindow,
  subsampleBelow: number,
): number[] {
  const layout = gridLayout(window, subsampleBelow);
  if (!layout) {
    return demTilesUnderNeighbors(window.depth, window.column, window.row);
  }
  const { width, height } = centerOf(window);
  const columns = demPixelsUnderGrid(layout.columns, layout.factor);
  const rows = demPixelsUnderGrid(layout.rows, layout.factor);
  const tiles: number[] = [];
  for (let down = -1; down <= 1; down++) {
    for (let across = -1; across <= 1; across++) {
      if (
        columns.first < (across + 1) * width &&
        columns.first + columns.count > across * width &&
        rows.first < (down + 1) * height &&
        rows.first + rows.count > down * height
      ) {
        tiles.push((down + 1) * 3 + across + 1);
      }
    }
  }
  return tiles;
}

function demTileUnder(column: number, row: number, splits: number): number {
  return (Math.floor(row / splits) + 1) * 3 + Math.floor(column / splits) + 1;
}

function centerOf(window: DemWindow): DemTile {
  const center = window.tiles[CENTER];
  if (!center) {
    throw new Error("A DEM window must include its center tile");
  }
  return center;
}

export function demByClosures(window: DemWindow): HeightTile {
  const splits = 2 ** window.depth;
  const neighbors: (HeightTile | undefined)[] = [];
  for (let down = -1; down <= 1; down++) {
    for (let across = -1; across <= 1; across++) {
      const column = window.column + across;
      const row = window.row + down;
      const tile = window.tiles[demTileUnder(column, row, splits)];
      neighbors.push(
        tile &&
          HeightTile.fromRawDem(tile).split(
            window.depth,
            column - Math.floor(column / splits) * splits,
            row - Math.floor(row / splits) * splits,
          ),
      );
    }
  }
  const dem = HeightTile.combineNeighbors(neighbors);
  if (!dem) {
    throw new Error("A DEM window must include its center tile");
  }
  return dem;
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

export function gatherDemPixels(
  tiles: (DemTile | undefined)[],
  columns: Span,
  rows: Span,
): HeightBlock {
  const center = tiles[CENTER];
  const data = new Float32Array(columns.count * rows.count).fill(NaN);
  if (!center) {
    return { columns, rows, data };
  }
  for (let i = 0; i < 9; i++) {
    const tile = tiles[i];
    if (!tile) {
      continue;
    }
    const tileLeft = ((i % 3) - 1) * center.width;
    const tileTop = (Math.floor(i / 3) - 1) * center.height;
    const left = Math.max(columns.first, tileLeft);
    const right = Math.min(
      columns.first + columns.count,
      tileLeft + tile.width,
    );
    const top = Math.max(rows.first, tileTop);
    const bottom = Math.min(rows.first + rows.count, tileTop + tile.height);
    for (let y = top; y < bottom; y++) {
      let from = (y - tileTop) * tile.width + left - tileLeft;
      let out = (y - rows.first) * columns.count + left - columns.first;
      for (let x = left; x < right; x++) {
        const value = tile.data[from++];
        data[out++] =
          value >= MIN_VALID_M && value <= MAX_VALID_M ? value : NaN;
      }
    }
  }
  return { columns, rows, data };
}

export function heightTileOver(
  heights: HeightBlock,
  left: number,
  top: number,
  width: number,
  height: number,
): HeightTile {
  const { data } = heights;
  const stride = heights.columns.count;
  const origin =
    (top - heights.rows.first) * stride + left - heights.columns.first;
  return new HeightTile(width, height, (x, y) => data[origin + y * stride + x]);
}

export function gridByChaikinDoubling(
  pixels: HeightBlock,
  factor: number,
  columns: Span,
  rows: Span,
  multiplier: number,
): HeightBlock {
  const columnsAtLevel = [pixelsMeanOfFourReads(columns)];
  const rowsAtLevel = [pixelsMeanOfFourReads(rows)];
  for (let reached = factor; reached > 1; reached /= 2) {
    columnsAtLevel.unshift(pixelsChaikinDoublingReads(columnsAtLevel[0]));
    rowsAtLevel.unshift(pixelsChaikinDoublingReads(rowsAtLevel[0]));
  }
  let doubled = pixels;
  for (let level = 1; level < columnsAtLevel.length; level++) {
    doubled = chaikinDoublePixels(
      doubled,
      columnsAtLevel[level],
      rowsAtLevel[level],
    );
  }
  return meanOfFourPixelsAtCorners(doubled, columns, rows, multiplier);
}

function pixelBeforeChaikinPoint(index: number): number {
  return index & 1 ? index >> 1 : (index >> 1) - 1;
}

export function pixelsChaikinDoublingReads(doubled: Span): Span {
  const first = pixelBeforeChaikinPoint(doubled.first);
  const last = pixelBeforeChaikinPoint(doubled.first + doubled.count - 1) + 1;
  return { first, count: last - first + 1 };
}

export function pixelsMeanOfFourReads(grid: Span): Span {
  return { first: grid.first - 1, count: grid.count + 1 };
}

export function chaikinDoublePixels(
  pixels: HeightBlock,
  columns: Span,
  rows: Span,
): HeightBlock {
  const from = pixels.data;
  const fromStride = pixels.columns.count;
  const data = new Float32Array(columns.count * rows.count);
  const right = columns.first + columns.count;
  const bottom = rows.first + rows.count;
  let out = 0;
  for (let y = rows.first; y < bottom; y++) {
    const towardBelow = y & 1 ? 0.25 : 0.75;
    const row =
      (pixelBeforeChaikinPoint(y) - pixels.rows.first) * fromStride -
      pixels.columns.first;
    for (let x = columns.first; x < right; x++) {
      const towardRight = x & 1 ? 0.25 : 0.75;
      const i = row + pixelBeforeChaikinPoint(x);
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
  return { columns, rows, data };
}

function blendSkippingMissing(a: number, b: number, towardB: number): number {
  return a !== a ? b : b !== b ? a : a + (b - a) * towardB;
}

export function meanOfFourPixelsAtCorners(
  pixels: HeightBlock,
  columns: Span,
  rows: Span,
  multiplier: number,
): HeightBlock {
  const from = pixels.data;
  const fromStride = pixels.columns.count;
  const data = new Float32Array(columns.count * rows.count);
  const right = columns.first + columns.count;
  const bottom = rows.first + rows.count;
  let out = 0;
  for (let y = rows.first; y < bottom; y++) {
    let i =
      (y - 1 - pixels.rows.first) * fromStride -
      pixels.columns.first -
      1 +
      columns.first;
    let westPair = from[i] + from[i + fromStride];
    for (let x = columns.first; x < right; x++, i++) {
      const northeast = from[i + 1];
      const southeast = from[i + fromStride + 1];
      const sumOfFour = westPair + northeast + southeast;
      westPair = northeast + southeast;
      data[out++] =
        sumOfFour === sumOfFour
          ? sumOfFour * 0.25 * multiplier
          : meanSkippingMissing(
              from[i],
              from[i + fromStride],
              northeast,
              southeast,
            ) * multiplier;
    }
  }
  return { columns, rows, data };
}

function meanSkippingMissing(
  northwest: number,
  southwest: number,
  northeast: number,
  southeast: number,
): number {
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
  return count === 0 ? NaN : sum / count;
}

interface SplineTaps {
  first: Int32Array;
  third: Int32Array;
  firstWeight: Float64Array;
  secondWeight: Float64Array;
  thirdWeight: Float64Array;
}

export function quadraticBSplineTaps(
  grid: Span,
  factor: number,
  pixels: Span,
): SplineTaps {
  const taps: SplineTaps = {
    first: new Int32Array(grid.count),
    third: new Int32Array(grid.count),
    firstWeight: new Float64Array(grid.count),
    secondWeight: new Float64Array(grid.count),
    thirdWeight: new Float64Array(grid.count),
  };
  for (let k = 0; k < grid.count; k++) {
    const gridIndex = grid.first + k;
    const pixel = Math.floor(gridIndex / factor);
    const t = (gridIndex - pixel * factor) / factor;
    taps.first[k] = pixel - 1 - pixels.first;
    taps.third[k] = (t === 0 ? pixel : pixel + 1) - pixels.first;
    taps.firstWeight[k] = ((1 - t) * (1 - t)) / 2;
    taps.secondWeight[k] = (-2 * t * t + 2 * t + 1) / 2;
    taps.thirdWeight[k] = (t * t) / 2;
  }
  return taps;
}

export function gridByQuadraticBSpline(
  pixels: HeightBlock,
  factor: number,
  columns: Span,
  rows: Span,
  multiplier: number,
): HeightBlock {
  const from = pixels.data;
  const fromStride = pixels.columns.count;
  const fromRows = pixels.rows.count;
  const across = quadraticBSplineTaps(columns, factor, pixels.columns);
  const down = quadraticBSplineTaps(rows, factor, pixels.rows);
  const stride = columns.count;

  const blendedAlongRows = new Float64Array(fromRows * stride);
  let out = 0;
  for (let row = 0; row < fromRows; row++) {
    const start = row * fromStride;
    for (let k = 0; k < stride; k++) {
      const first = start + across.first[k];
      blendedAlongRows[out++] =
        across.firstWeight[k] * from[first] +
        across.secondWeight[k] * from[first + 1] +
        across.thirdWeight[k] * from[start + across.third[k]];
    }
  }

  const data = new Float32Array(stride * rows.count);
  out = 0;
  for (let k = 0; k < rows.count; k++) {
    const first = down.first[k] * stride;
    const second = first + stride;
    const third = down.third[k] * stride;
    const firstWeight = down.firstWeight[k];
    const secondWeight = down.secondWeight[k];
    const thirdWeight = down.thirdWeight[k];
    for (let x = 0; x < stride; x++) {
      data[out++] =
        (firstWeight * blendedAlongRows[first + x] +
          secondWeight * blendedAlongRows[second + x] +
          thirdWeight * blendedAlongRows[third + x]) *
        multiplier;
    }
  }
  return { columns, rows, data };
}

function hasMissingValue(heights: HeightBlock): boolean {
  const { data } = heights;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== data[i]) {
      return true;
    }
  }
  return false;
}

function takeMissingValuesFrom(grid: HeightBlock, other: HeightBlock): void {
  for (let i = 0; i < grid.data.length; i++) {
    if (grid.data[i] !== grid.data[i]) {
      grid.data[i] = other.data[i];
    }
  }
}
