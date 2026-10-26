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
/** Cross-multiply exact values; this is the sole package cutoff comparator, with no epsilon. */
export declare function compareExact(a: ExactValue, b: ExactValue): -1 | 0 | 1;
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
export declare function precisionMeets(correct: number, count: number, target: ExactValue, z?: ExactValue): boolean;
//# sourceMappingURL=exact.d.ts.map