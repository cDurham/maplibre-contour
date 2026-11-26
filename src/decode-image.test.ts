import defaultDecoder from "./decode-image";
import { shouldUseVideoFrame } from "./utils";

jest.mock("./utils", () => ({
  ...jest.requireActual("./utils"),
  shouldUseVideoFrame: jest.fn(() => true),
}));

(window as any).createImageBitmap = () =>
  Promise.resolve({ width: 1, height: 1 });
(window as any).VideoFrame = class {
  format = "RGBA";
  allocationSize = () => 4;
  copyTo = (data: Uint8ClampedArray) => data.set([1, 2, 3, 255]);
  close = () => {};
};

const decode = () =>
  defaultDecoder(new Blob(), "terrarium", new AbortController());

test("importing the decoder does not probe the browser", () => {
  expect(shouldUseVideoFrame).not.toHaveBeenCalled();
});

test("the first decode probes the browser, and only once", async () => {
  const tiles = await Promise.all([decode(), decode()]);
  tiles.push(await decode());
  expect(shouldUseVideoFrame).toHaveBeenCalledTimes(1);
  for (const tile of tiles) {
    expect(tile).toEqual({
      width: 1,
      height: 1,
      data: Float32Array.from([1 * 256 + 2 + 3 / 256 - 32768]),
    });
  }
});
