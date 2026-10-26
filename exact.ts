/** Compatibility entry point; all arithmetic and threshold decisions are implemented in one domain module. */
export { fraction, decimal, compareThreshold as compareExact, addExact, subtractExact, multiplyExact, displayExact, displayRatio, countRatio, populationDistance, precisionMeets } from "./threshold.ts";
/** Preserve the existing exact arithmetic type imports for SDK callers. */
export type { Rational, ExactValue } from "./threshold.ts";
