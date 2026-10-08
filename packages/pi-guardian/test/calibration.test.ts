import { describe, expect, it } from "vitest";
import { calibratedFactor, fallbackTokenFactor } from "../src/guardian-calibration.js";

describe("token estimate calibration", () => {
  it("starts conservative and rises to the reported ratio in quarter steps", () => {
    expect(fallbackTokenFactor).toBe(1.5);
    // Claude Opus in live use: 54k reported for a 32k estimate.
    expect(calibratedFactor(1.5, 32_000, 54_000)).toBe(1.75);
  });

  it("keeps a stable factor when the ratio wobbles, so the evidence window stays put", () => {
    // Claude Haiku in live use: 43k reported for a 32k estimate (1.34) stays at 1.5.
    expect(calibratedFactor(1.5, 32_000, 43_000)).toBe(1.5);
    expect(calibratedFactor(1.75, 32_000, 54_500)).toBe(1.75);
    expect(calibratedFactor(1.5, 10_000, 15_200)).toBe(1.5);
  });

  it("shrinks only for a clearly lower ratio, and ignores small or empty requests", () => {
    expect(calibratedFactor(2, 10_000, 11_000)).toBe(1.25);
    expect(calibratedFactor(1.5, 1_000, 5_000)).toBe(1.5);
    expect(calibratedFactor(1.5, 10_000, 0)).toBe(1.5);
    expect(calibratedFactor(1.5, 10_000, 90_000)).toBe(3);
  });
});
