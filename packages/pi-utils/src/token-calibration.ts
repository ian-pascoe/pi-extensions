/**
 * Token-estimate calibration. Extensions that size Review Evidence by Pi's chars/4 estimate
 * undercount real tokens (about 1.3× on Claude Haiku and 1.7–1.9× on Claude Opus for JSON-heavy
 * evidence). A model's factor starts conservative and follows the tokens its provider reports
 * against the estimate, in coarse steps with hysteresis so a stable factor keeps the evidence
 * window, and with it the provider's prompt cache, stable from review to review. Callers own where
 * the samples live: Guardian records them in the session branch, Advisor keeps them per observer.
 */

/** Factor assumed before a model reports usage. */
export const fallbackTokenFactor = 1.5;
const minimumFactor = 1;
const maximumFactor = 3;
/** Factors move in steps of this size. */
const factorStep = 0.25;
/** A lower measured ratio replaces the factor only when it falls this far below it. */
const shrinkMargin = 0.35;
/** A higher measured ratio replaces the factor only when it exceeds it by more than this. */
const growMargin = 0.05;
/** Requests smaller than this are dominated by fixed provider overhead and calibrate nothing. */
const minimumCalibrationTokens = 2_000;

/** The next factor after a review whose request Pi estimated at `estimated` tokens (chars/4). */
export function calibratedFactor(current: number, estimated: number, reported: number): number {
  if (estimated < minimumCalibrationTokens || !(reported > 0)) return current;
  const ratio = reported / estimated;
  const stepped = Math.min(
    maximumFactor,
    Math.max(minimumFactor, Math.ceil(ratio / factorStep) * factorStep),
  );
  if (ratio > current + growMargin || ratio < current - shrinkMargin) return stepped;
  return current;
}

/** One measurement: Pi's chars/4 estimate of a request or its added evidence, and the real tokens reported. */
export interface TokenSample {
  estimated: number;
  reported: number;
}

/** A model's factor after its recorded samples, in order, starting from `fallback`. */
export function tokenFactor(
  samples: readonly TokenSample[],
  fallback: number = fallbackTokenFactor,
): number {
  return samples.reduce(
    (factor, sample) => calibratedFactor(factor, sample.estimated, sample.reported),
    fallback,
  );
}
