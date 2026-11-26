import { decodeParsedImage } from "./decode-image";
import type { Encoding } from "./types";

const formulas: Record<Encoding, (r: number, g: number, b: number) => number> =
  {
    mapbox: (r, g, b) => -10000 + (r * 256 * 256 + g * 256 + b) * 0.1,
    terrarium: (r, g, b) => r * 256 + g + b / 256 - 32768,
  };

const expected = (encoding: Encoding, input: Uint8ClampedArray) => {
  const data = new Float32Array(input.length / 4);
  for (let i = 0; i < input.length; i += 4) {
    data[i / 4] = formulas[encoding](input[i], input[i + 1], input[i + 2]);
  }
  return data;
};

const noise = (pixels: number) => {
  const input = new Uint8ClampedArray(pixels * 4);
  let seed = 1;
  for (let i = 0; i < input.length; i++) {
    seed = (seed * 48271) % 2147483647;
    input[i] = seed & 255;
  }
  return input;
};

for (const encoding of ["mapbox", "terrarium"] as const) {
  test(`${encoding}: every channel at its least and its most`, () => {
    const ends = [0, 255];
    const input = Uint8ClampedArray.from(
      ends.flatMap((r) =>
        ends.flatMap((g) => ends.flatMap((b) => [r, g, b, 255])),
      ),
    );
    expect(decodeParsedImage(4, 2, encoding, input)).toEqual({
      width: 4,
      height: 2,
      data: expected(encoding, input),
    });
  });

  test(`${encoding}: a tile of noise, alpha ignored`, () => {
    const input = noise(64 * 64);
    const { data } = decodeParsedImage(64, 64, encoding, input);
    expect(data).toEqual(expected(encoding, input));
  });
}

test("a view into a larger buffer is read from its own start", () => {
  const whole = noise(18);
  const input = new Uint8ClampedArray(whole.buffer, 5, 16 * 4);
  const { data } = decodeParsedImage(4, 4, "terrarium", input);
  expect(data).toEqual(expected("terrarium", input));
});
