import { flattenDeep } from "lodash";
import { HeightTile } from "./height-tile";
import generateIsolines from "./isolines";

runTestWithRotations("corner halfway", 2, heightTile(1, 1, 1, 3), {
  2: [[1, 0.5, 0.5, 1]],
});

runTestWithRotations(
  "corner above most of the way",
  2,
  heightTile(1, 1, 1, 2.33333),
  {
    2: [[1, 0.75, 0.75, 1]],
  },
);

runTestWithRotations("two contours", 2, heightTile(1, 1, 1, 5), {
  2: [[1, 0.25, 0.25, 1]],
  4: [[1, 0.75, 0.75, 1]],
});

runTestWithRotations(
  "edge above threshold",
  2,
  heightTile(1, 1, 2.33333, 2.33333),
  {
    2: [[1, 0.75, 0, 0.75]],
  },
);

runTestWithRotations(
  "edge above threshold",
  2,
  heightTile(1, 1, 2.33333, 2.33333),
  {
    2: [[1, 0.75, 0, 0.75]],
  },
);

runTestWithRotations("corner up to threshold", 2, heightTile(1, 1, 1, 2), {});
runTestWithRotations("omit empty point??", 2, heightTile(2, 3, 3, 3), {
  2: [[0, 0, 0, 0]],
});
runTestWithRotations("side up to threshold", 2, heightTile(1, 2, 1, 2), {});
runTestWithRotations("side down to threshold", 2, heightTile(2, 3, 2, 3), {
  2: [[0, 0, 0, 1]],
});
runTestWithRotations(
  "threshold middle",
  2,
  heightTile([
    [1, 1, 1, 1],
    [1, 2, 1, 1],
    [1, 2, 1, 1],
    [1, 1, 1, 1],
  ]),
  {},
);
runTestWithRotations(
  "corner below threshold",
  2,
  heightTile([
    [1, 2.3333333],
    [2.3333333, 2.3333333],
  ]),
  {
    2: [[0.75, 0, 0, 0.75]],
  },
);
runTest(
  "saddle",
  0,
  2,
  heightTile([
    [1, 2.3333333],
    [2.3333333, 1],
  ]),
  {
    2: [
      [0.25, 1, 0, 0.75],
      [0.75, 0, 1, 0.25],
    ],
  },
);
runTestWithRotations("no contours", 2, heightTile(1, 1, 1, 1), {});
runTestWithRotations(
  "connect segments",
  2,
  heightTile([
    [1, 3, 3],
    [1, 1, 3],
    [1, 1, 1],
  ]),
  {
    2: [[0.5, 0, 1, 0.5, 1.5, 1, 2, 1.5]],
  },
);
runTest(
  "join a shorter piece onto the front of a longer one",
  0,
  2,
  heightTile([
    [1, 4, 0, 2, 0, 3],
    [1, 0, 2, 3, 2, 3],
    [1, 1, 4, 4, 3, 4],
    [0, 4, 0, 3, 2, 3],
    [4, 4, 1, 3, 4, 2],
    [2, 4, 3, 4, 3, 2],
  ]),
  {
    0: [
      [2, 3, 2, 3, 2, 3, 2, 3, 2, 3],
      [2, 0, 2, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 0],
      [4, 0, 4, 0, 4, 0],
      [0, 3, 0, 3, 0, 3],
    ],
    2: [
      [0.333, 0, 1, 0.5, 1.5, 0],
      [
        4.667, 0, 4, 1, 4, 1, 4, 1, 3, 0, 2, 1, 2, 1, 1.333, 2, 2, 2.5, 2.667,
        3, 2.5, 4, 2, 4.5, 1.666, 4, 1.5, 3, 1, 2.333, 0.5, 3, 0, 3.5,
      ],
      [0, 5, 0, 5],
      [5, 5, 5, 4, 4, 3, 4, 3, 4, 3, 4, 3, 5, 4],
    ],
  },
);
runTest(
  "center point above",
  0,
  2,
  heightTile([
    [1, 1, 1],
    [1, 3, 1],
    [1, 1, 1],
  ]),
  {
    2: [[1.5, 1, 1, 0.5, 0.5, 1, 1, 1.5, 1.5, 1]],
  },
);
runTest(
  "center point below",
  0,
  2,
  heightTile([
    [3, 3, 3],
    [3, 1, 3],
    [3, 3, 3],
  ]),
  {
    2: [[1, 1.5, 0.5, 1, 1, 0.5, 1.5, 1, 1, 1.5]],
  },
);

function heightTile(...values: number[] | number[][][]): HeightTile {
  const flattened = flattenDeep(values);
  const size = Math.sqrt(flattened.length);
  return HeightTile.fromRawDem({
    width: size,
    height: size,
    data: Float32Array.from(flattened),
  });
}

function runTestWithRotations(
  name: string,
  interval: number,
  heightTile: HeightTile,
  expected: { [ele: number]: number[][] },
) {
  for (const rotation of [0, 90, 180, 270]) {
    runTest(
      `${name} (rotation=${rotation})`,
      rotation,
      interval,
      heightTile,
      expected,
    );
  }
}

function rotate(
  [x, y]: [number, number],
  [ax, ay]: [number, number],
  angle: number,
): [number, number] {
  const theta = (angle * Math.PI) / 180;
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);

  const rx = x - ax;
  const ry = y - ay;

  return [round(ax + rx * cos - ry * sin), round(ay + ry * cos + rx * sin)];
}

function round(n: number): number {
  return Math.round(n * 1000 + 0.001) / 1000;
}

function runTest(
  name: string,
  rotation: number,
  interval: number,
  heightTile: HeightTile,
  expected: { [ele: number]: number[][] },
) {
  test(name, () => {
    const size = heightTile.width;
    const center = (size - 1) / 2;
    const rotatedHeightTile = new HeightTile(
      heightTile.width,
      heightTile.height,
      (x, y) => {
        if (x < 0 || x >= size) {
          throw new Error(`x=${x}`);
        } else if (y < 0 || y >= size) {
          throw new Error(`y=${y}`);
        }
        const [nx, ny] = rotate([x, y], [center, center], rotation).map(
          round,
        ) as [number, number];
        return heightTile.get(nx, ny);
      },
    );
    const isolines = generateIsolines(interval, rotatedHeightTile, 4096, 0);
    const rotatedResult: { [ele: number]: number[][] } = {};
    for (const ele in isolines) {
      rotatedResult[ele] = isolines[ele].map((eles) => {
        const rotatedLine: number[] = [...eles];
        for (let i = 0; i < rotatedLine.length; i += 2) {
          const [x, y] = rotate(
            [
              (rotatedLine[i] * (size - 1)) / 4096,
              (rotatedLine[i + 1] * (size - 1)) / 4096,
            ],
            [center, center],
            rotation,
          );
          rotatedLine[i] = x;
          rotatedLine[i + 1] = y;
        }
        return rotatedLine;
      });
    }
    expect(rotatedResult).toEqual(expected);
  });
}

// Expected lines below were generated by the tracer of release 0.2.0.
const traced: {
  name: string;
  width: number;
  height: number;
  interval: number;
  values: number[];
  lazy: { [ele: number]: number[][] };
  materialized: { [ele: number]: number[][] };
}[] = [
  {
    name: "around a hole",
    width: 4,
    height: 4,
    interval: 1,
    values: [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1.5,
      1.5,
      1.5,
      1.5,
      0,
      0,
      1.5,
      2.5,
      NaN,
      1.5,
      0,
      0,
      1.5,
      2.5,
      2.5,
      1.5,
      0,
      0,
      1.5,
      1.5,
      1.5,
      1.5,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ],
    lazy: {
      "0": [
        [
          -1365, 5461, 0, 5461, 1365, 5461, 2731, 5461, 4096, 5461, 5461, 4096,
          5461, 2731, 5461, 1365, 5461, 0, 4096, -1365, 2731, -1365, 1365,
          -1365, 0, -1365, -1365, -1365,
        ],
      ],
      "1": [
        [
          -1365, 4551, 0, 4551, 1365, 4551, 2731, 4551, 4096, 4551, 4551, 4096,
          4551, 2731, 4551, 1365, 4551, 0, 4096, -455, 2731, -455, 1365, -455,
          0, -455, -1365, -455,
        ],
      ],
      "2": [
        [1365, 683, 683, 1365, 683, 2731, 1365, 3413, 2731, 3413, 3413, 2731],
      ],
    },
    materialized: {
      "0": [
        [
          -1365, 5461, 0, 5461, 1365, 5461, 2731, 5461, 4096, 5461, 5461, 4096,
          5461, 2731, 5461, 1365, 5461, 0, 4096, -1365, 2731, -1365, 1365,
          -1365, 0, -1365, -1365, -1365,
        ],
      ],
      "1": [
        [
          -1365, 4551, 0, 4551, 1365, 4551, 2731, 4551, 4096, 4551, 4551, 4096,
          4551, 2731, 4551, 1365, 4551, 0, 4096, -455, 2731, -455, 1365, -455,
          0, -455, -1365, -455,
        ],
      ],
      "2": [
        [1365, 683, 683, 1365, 683, 2731, 1365, 3413, 2731, 3413, 3413, 2731],
      ],
    },
  },
  {
    name: "through saddles",
    width: 4,
    height: 3,
    interval: 2,
    values: [
      1, 3, 1, 3, 1, 3, 3, 1, 3, 1, 3, 1, 1, 3, 1, 3, 1, 3, 3, 1, 3, 1, 3, 1, 5,
      5, 5, 5, 5, 5,
    ],
    lazy: {
      "2": [
        [2048, 0, 1365, -683, 683, 0, 1365, 683, 2048, 0],
        [4779, 0, 4096, -683, 3413, 0, 4096, 683, 4779, 0],
        [3413, 1365, 2731, 683, 2048, 1365, 2731, 2048, 3413, 1365],
        [-1365, -683, 0, -683, 683, -1365],
        [2048, -1365, 2731, -683, 3413, -1365],
        [4779, -1365, 5461, -683],
        [5461, 683, 4779, 1365, 5461, 2048],
        [-1365, 2048, 0, 2048, 683, 1365, 0, 683, -1365, 683],
        [
          5461, 3072, 4779, 2731, 4096, 2048, 3413, 2731, 2731, 3072, 2048,
          2731, 1365, 2048, 683, 2731, 0, 3072, -1365, 3072,
        ],
      ],
      "4": [
        [5461, 3755, 4096, 3413, 2731, 3755, 1365, 3413, 0, 3755, -1365, 3755],
      ],
    },
    materialized: {
      "2": [
        [2048, 0, 1365, -683, 683, 0, 1365, 683, 2048, 0],
        [4779, 0, 4096, -683, 3413, 0, 4096, 683, 4779, 0],
        [3413, 1365, 2731, 683, 2048, 1365, 2731, 2048, 3413, 1365],
        [-1365, -683, 0, -683, 683, -1365],
        [2048, -1365, 2731, -683, 3413, -1365],
        [4779, -1365, 5461, -683],
        [5461, 683, 4779, 1365, 5461, 2048],
        [-1365, 2048, 0, 2048, 683, 1365, 0, 683, -1365, 683],
        [
          5461, 3072, 4779, 2731, 4096, 2048, 3413, 2731, 2731, 3072, 2048,
          2731, 1365, 2048, 683, 2731, 0, 3072, -1365, 3072,
        ],
      ],
      "4": [
        [5461, 3755, 4096, 3413, 2731, 3755, 1365, 3413, 0, 3755, -1365, 3755],
      ],
    },
  },
  {
    name: "out through every edge, with heights a Float32Array would round",
    width: 3,
    height: 3,
    interval: 0.3,
    values: [
      0.1, 0.25, 0.4, 0.55, 0.7, 0.2, 0.35, 0.5, 0.65, 0.8, 0.3, 0.45, 0.6,
      0.75, 0.9, 0.4, 0.55, 0.7, 0.85, 1, 0.5, 0.65, 0.8, 0.95, 1.1,
    ],
    lazy: {
      "0.3": [[683, -2048, 0, -1024, -2048, -1024]],
      "0.6": [
        [
          4779, -2048, 4096, -1024, 3413, 0, 2048, 2048, 2048, 2048, 683, 4096,
          0, 5120, -2048, 5120,
        ],
      ],
      "0.8999999999999999": [
        [6144, 2048, 6144, 2048, 4779, 4096, 4096, 5120, 3413, 6144],
      ],
    },
    materialized: {
      "0.3": [[683, -2048, 0, -1024, -2048, -1024]],
      "0.6": [
        [
          4779, -2048, 4096, -1024, 3413, 0, 2048, 2048, 2048, 2048, 683, 4096,
          0, 5120, -2048, 5120,
        ],
      ],
      "0.8999999999999999": [[6144, 2048, 4779, 4096, 4096, 5120, 3413, 6144]],
    },
  },
];

describe("with a buffer of 1", () => {
  for (const { name, width, height, interval, values, ...expected } of traced) {
    const stride = width + 2;
    const lazy = new HeightTile(
      width,
      height,
      (x, y) => values[(y + 1) * stride + x + 1],
    );
    test(`${name}, from a tile read pixel by pixel`, () => {
      expect(generateIsolines(interval, lazy, 4096, 1)).toEqual(expected.lazy);
    });
    test(`${name}, from a materialized tile`, () => {
      expect(generateIsolines(interval, lazy.materialize(1), 4096, 1)).toEqual(
        expected.materialized,
      );
    });
  }
});
