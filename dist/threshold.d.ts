/** Reduced rational with a positive denominator; never serialized as a report number. */
export interface Rational {
    readonly numerator: bigint;
    readonly denominator: bigint;
}
/** Finite decimals retain their declared decimal value; infinities are internal disabled-policy sentinels. */
export type ExactValue = Rational | number | string;
/** Construct a reduced count ratio without a floating-point division. */
export declare function fraction(numerator: number | bigint, denominator?: number | bigint): Rational;
/** Parse a bounded decimal/scientific lexeme exactly; number inputs use their canonical decimal spelling. */
export declare function decimal(value: ExactValue): Rational;
/** Add ratios before any report conversion. */
export declare function addExact(a: ExactValue, b: ExactValue): Rational;
/** Subtract count-derived rates without cancellation in binary floating point. */
export declare function subtractExact(a: ExactValue, b: ExactValue): Rational;
/** Multiply exact decimal costs, weights and count ratios. */
export declare function multiplyExact(a: ExactValue, b: ExactValue): Rational;
/** Convert only at a display boundary, retaining subnormal decimals without overflowing the denominator. */
export declare function displayExact(value: ExactValue): number;
/** Render a count ratio; callers handle empty denominators explicitly. */
export declare function displayRatio(numerator: number, denominator: number): number;
/** Compare empirical precision/recall/F1 using their counts, with an explicit zero-support fallback. */
export declare function countRatio(numerator: number, denominator: number): Rational;
/** Exact categorical TV from integer counts over the common category union. */
export declare function populationDistance(a: readonly number[], b: readonly number[]): Rational;
/** Wilson lower-bound qualification via the score inequality, avoiding a rounded irrational bound. */
export declare function precisionMeets(correct: number, count: number, target: ThresholdInput, z?: ExactValue): boolean;
/** Portable exact policy boundary; disabled and the legacy negative-infinity bound are explicit states. */
export type Threshold = {
    readonly state: "enabled";
    readonly numerator: string;
    readonly denominator: string;
} | {
    readonly state: "disabled";
} | {
    readonly state: "unbounded";
};
/** Legacy numeric/null cutoffs and exact tagged boundaries are accepted at the same boundary. */
export type ThresholdInput = ExactValue | Threshold | null;
/** Normalize legacy sentinels before arithmetic and validate the one serialized threshold schema. */
export declare function threshold(value: ThresholdInput): Threshold;
/** Single fit/apply comparator: finite rationals cross-multiply; explicit sentinels retain legacy ordering. */
export declare function compareThreshold(a: ThresholdInput, b: ThresholdInput): -1 | 0 | 1;
/** A disabled cutoff accepts nothing, even when a legacy metric row contains a nonfinite score. */
export declare function acceptsThreshold(value: ThresholdInput, cutoff: ThresholdInput, exclusive?: boolean): boolean;
/** Resolve a finite tagged threshold to its exact arithmetic value after boundary normalization. */
export declare function thresholdRatio(value: ThresholdInput): Rational;
/** Negative evidence cannot be established by a disabled channel; never subtract an infinity sentinel. */
export declare function belowComplement(value: ExactValue, cutoff: ThresholdInput): boolean;
/** Choose a numeric decimal boundary no greater than the exact observation; fitting counts with this same boundary. */
export declare function numericBoundary(value: ExactValue): number;
/** Preserve last-release scalar result forms while new typed results retain explicit sentinel states. */
export declare function legacyThreshold(value: ThresholdInput): number;
/** The exact top-two margin from probabilities as stored, shared by margin fitting and runtime application. */
export declare function marginValue(probabilities: Readonly<Record<string, number>>): Rational;
//# sourceMappingURL=threshold.d.ts.map