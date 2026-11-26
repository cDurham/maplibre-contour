import { HeightTile } from "./height-tile";
const initialTile = HeightTile.fromRawDem({
  width: 2,
  height: 2,
  data: Float32Array.from([0, 1, 2, 3]),
});

test("raw tile", () => {
  expect(initialTile.get(0, 0)).toBe(0);
  expect(initialTile.get(1, 0)).toBe(1);
  expect(initialTile.get(1, 1)).toBe(3);
});

test("split height tile", () => {
  const split = initialTile.split(1, 0, 0);
  expect(split.get(0, 0)).toBe(0);
  expect(split.width).toBe(1);
  const split2 = initialTile.split(1, 1, 1);
  expect(split2.get(0, 0)).toBe(3);
  expect(split2.width).toBe(1);
});

const neighbors: HeightTile[] = [];
for (let i = 0; i < 9; i++) {
  const row = Math.floor(i / 3);
  const start = i * 2 + row * 6;
  neighbors.push(
    HeightTile.fromRawDem({
      width: 2,
      height: 2,
      data: Float32Array.from([start, start + 1, start + 6, start + 7]),
    }),
  );
}

// 0  1  | 2  3  | 4  5
// 6  7  | 8  9  | 10 11
// ------ ------- ------
// 12 13 | 14 15 | 16 17
// 18 19 | 20 21 | 22 23
// ------ ------- ------
// 24 25 | 26 27 | 28 29
// 30 31 | 32 33 | 34 35
test("neighboring tiles", () => {
  const virtualTile = HeightTile.combineNeighbors(neighbors);
  expect(virtualTile?.get(-1, -1)).toBe(7);
  expect(virtualTile?.get(0, -1)).toBe(8);
  expect(virtualTile?.get(1, -1)).toBe(9);
  expect(virtualTile?.get(2, -1)).toBe(10);

  expect(virtualTile?.get(-1, 0)).toBe(13);
  expect(virtualTile?.get(0, 0)).toBe(14);
  expect(virtualTile?.get(1, 0)).toBe(15);
  expect(virtualTile?.get(2, 0)).toBe(16);

  expect(virtualTile?.get(-1, 2)).toBe(25);
  expect(virtualTile?.get(0, 2)).toBe(26);
  expect(virtualTile?.get(1, 2)).toBe(27);
  expect(virtualTile?.get(2, 2)).toBe(28);
});

// 0  1  | 2  3  | 4  5
// 6  7  | 8  9  | 10 11
// ------ ------- ------
// 12 13 | 14 15 | 16 17
// 18 19 | 20 21 | 22 23
// ------ ------- ------
// 24 25 | 26 27 | 28 29
// 30 31 | 32 33 | 34 35
test("average pixel centers to grid", () => {
  const virtualTile =
    HeightTile.combineNeighbors(neighbors)?.averagePixelCentersToGrid();
  // 7,8,13,14
  expect(virtualTile?.get(0, 0)).toBe((7 + 8 + 13 + 14) / 4);
  expect(virtualTile?.get(1, 0)).toBe((8 + 9 + 14 + 15) / 4);
  expect(virtualTile?.get(2, 0)).toBe((9 + 10 + 15 + 16) / 4);
  expect(virtualTile?.get(0, 2)).toBe((19 + 20 + 25 + 26) / 4);
  expect(virtualTile?.get(2, 2)).toBe((21 + 22 + 27 + 28) / 4);
  expect(virtualTile).toMatchObject({
    width: 3,
    height: 3,
  });
});

test("subsample pixel centers", () => {
  /*  ___________ ____________
     |             |            |
     | old -1,-1   |  old 0,-1  |
     |      7      |     8      |
     |new -1,-1>x  |  x<new 0,-1|
     |_____________|____________|
     |             |            |
     | new -1,0>x  |  x<new 0,0 |
     |       13    |     14     |
     |   old -1,0  |  old 0,0   |
     |_____________|____________|
  */
  const virtualTile =
    HeightTile.combineNeighbors(neighbors)?.subsamplePixelCenters(2);
  expect(virtualTile?.get(0, 0)).toBe((7.75 + 3 * 13.75) / 4);
  expect(virtualTile?.get(-1, -1)).toBe((7.25 * 3 + 13.25) / 4);
  expect(virtualTile).toMatchObject({
    width: 4,
    height: 4,
  });
});

test("subsample and average centers alignment between tiles", () => {
  /*  ___________ ____________
     |             |            |
     | old -1,-1   |  old 0,-1  |
     |      7      |     8      |
     |new -1,-1>x  |  x<new 0,-1|
     |_____________|____________|
     |             |            |
     | new -1,0>x  |  x<new 0,0 |
     |       13    |     14     |
     |   old -1,0  |  old 0,0   |
     |_____________|____________|
  */
  const subsampled = HeightTile.combineNeighbors(neighbors)
    ?.subsamplePixelCenters(2)
    .averagePixelCentersToGrid();
  const notSubsampled =
    HeightTile.combineNeighbors(neighbors)?.averagePixelCentersToGrid();

  expect(subsampled).toMatchObject({
    width: 5,
    height: 5,
  });
  expect(notSubsampled).toMatchObject({
    width: 3,
    height: 3,
  });

  expect(subsampled?.get(0, 0)).toBe(notSubsampled?.get(0, 0));
  expect(subsampled?.get(2, 2)).toBe(notSubsampled?.get(1, 1));
  expect(subsampled?.get(-2, -2)).toBe(notSubsampled?.get(-1, -1));
});

function randomDem(size: number, seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const special = [NaN, -0, -20000, 10000, -12000, 9000];
  return {
    width: size,
    height: size,
    data: Float32Array.from({ length: size * size }, () => {
      const pick = next();
      return pick < 0.1
        ? special[Math.floor(next() * special.length)]
        : (next() - 0.3) * 4000;
    }),
  };
}

const plain = (tile: HeightTile) =>
  new HeightTile(tile.width, tile.height, tile.get);

function values(tile: HeightTile, buffer: number): number[] {
  const result: number[] = [];
  for (let y = -buffer; y < tile.height + buffer; y++) {
    for (let x = -buffer; x < tile.width + buffer; x++) {
      result.push(tile.get(x, y));
    }
  }
  return result;
}

function randomNeighbors(size: number, seed: number, missing: number[] = []) {
  return Array.from({ length: 9 }, (_, i) =>
    missing.includes(i)
      ? undefined
      : HeightTile.fromRawDem(randomDem(size, seed + i)),
  );
}

test.each([0, 1, 2, 3, 8, 9])(
  "materialize neighbors with buffer %d matches reading each pixel",
  (buffer) => {
    for (const missing of [[], [0, 5], [4]]) {
      const tiles = randomNeighbors(8, 7, missing);
      const fast = HeightTile.combineNeighbors(tiles)?.materialize(buffer);
      const slow = HeightTile.combineNeighbors(
        tiles.map((tile) => tile && plain(tile)),
      )?.materialize(buffer);
      expect(fast && values(fast, buffer)).toEqual(
        slow && values(slow, buffer),
      );
    }
  },
);

test.each([
  [1, 0, 0],
  [1, 1, 0],
  [2, 3, 1],
])(
  "materialize split %d/%d/%d neighbors matches reading each pixel",
  (z, x, y) => {
    const tiles = randomNeighbors(16, 11).map((tile) => tile?.split(z, x, y));
    const fast = HeightTile.combineNeighbors(tiles)?.materialize(2);
    const slow = HeightTile.combineNeighbors(
      tiles.map((tile) => tile && plain(tile)),
    )?.materialize(2);
    expect(fast && values(fast, 2)).toEqual(slow && values(slow, 2));
  },
);

test.each([
  [1, 1, 2],
  [3.28084, 1, 2],
  [0.3048, 0, 1],
  [3.28084, 2, 3],
  [3.28084, 2, 2],
])(
  "average, scale by %d and materialize(%d) after materialize(%d) matches reading each pixel",
  (multiplier, buffer, sourceBuffer) => {
    const source = HeightTile.combineNeighbors(
      randomNeighbors(8, 3),
    )?.materialize(sourceBuffer);
    const fast = source
      ?.averagePixelCentersToGrid()
      .scaleElevation(multiplier)
      .materialize(buffer);
    const slow =
      source &&
      plain(source)
        .averagePixelCentersToGrid()
        .scaleElevation(multiplier)
        .materialize(buffer);
    expect(fast && values(fast, buffer)).toEqual(slow && values(slow, buffer));
  },
);

test.each([0, 1, 2, 3])(
  "materialize(%d) of a tile materialized with buffer 3 matches reading each pixel",
  (buffer) => {
    const source = HeightTile.combineNeighbors(
      randomNeighbors(8, 5),
    )?.materialize(3);
    const fast = source?.materialize(buffer);
    const slow = source && plain(source).materialize(buffer);
    expect(fast && values(fast, buffer)).toEqual(slow && values(slow, buffer));
  },
);

test("materialize of a tile already materialized with that buffer is the tile", () => {
  const source = HeightTile.combineNeighbors(
    randomNeighbors(8, 5),
  )?.materialize(2);
  expect(source?.materialize(2)).toBe(source);
  expect(source?.materialize(1)).not.toBe(source);
});

test.each([
  [0, 0, 0],
  [1, 1, 0],
  [2, 3, 1],
])(
  "materialize a raw tile split %d/%d/%d matches reading each pixel",
  (z, x, y) => {
    const tile = HeightTile.fromRawDem(randomDem(16, 13)).split(z, x, y);
    expect(values(tile.materialize(0), 0)).toEqual(
      values(plain(tile).materialize(0), 0),
    );
  },
);
