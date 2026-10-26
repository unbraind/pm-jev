/** Reduced rational with a positive denominator; never serialized as a report number. */
export interface Rational { readonly numerator: bigint; readonly denominator: bigint }
/** Finite decimals retain their declared decimal value; infinities are internal disabled-policy sentinels. */
export type ExactValue = Rational | number | string;

/** Euclidean reduction bounds intermediates during repeated exact arithmetic. */
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return a;
}
/** Convert integer counts before multiplication, refusing already-rounded unsafe integers. */
function integer(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) throw new RangeError("Exact counts must be safe integers or BigInts");
  return BigInt(value);
}
/** Construct a reduced count ratio without a floating-point division. */
export function fraction(numerator: number | bigint, denominator: number | bigint = 1): Rational {
  const n = integer(numerator), d = integer(denominator);
  if (d <= 0n) throw new RangeError("Exact denominator must be positive");
  const divisor = gcd(n < 0n ? -n : n, d);
  return { numerator: n / divisor, denominator: d / divisor };
}
/** Parse a bounded decimal/scientific lexeme exactly; number inputs use their canonical decimal spelling. */
export function decimal(value: ExactValue): Rational {
  if (typeof value === "object") return fraction(value.numerator, value.denominator);
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || text.length > 256) throw new RangeError("Expected a finite decimal with at most 256 characters");
  const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024) throw new RangeError("Decimal exponent exceeds the exact arithmetic bound");
  const n = BigInt(`${match[1]}${match[2]}${match[3] ?? ""}`);
  return exponent >= 0 ? fraction(n * 10n ** BigInt(exponent)) : fraction(n, 10n ** BigInt(-exponent));
}
/** Cross-multiply exact values; this is the sole package cutoff comparator, with no epsilon. */
export function compareExact(a: ExactValue, b: ExactValue): -1 | 0 | 1 {
  if (typeof a === "number" && Number.isNaN(a) || typeof b === "number" && Number.isNaN(b)) throw new RangeError("NaN has no exact ordering");
  if (a === Infinity || b === -Infinity) return a === b ? 0 : 1;
  if (a === -Infinity || b === Infinity) return -1;
  const x = decimal(a), y = decimal(b);
  const left = x.numerator * y.denominator, right = y.numerator * x.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}
/** Add ratios before any report conversion. */
export function addExact(a: ExactValue, b: ExactValue): Rational {
  const x = decimal(a), y = decimal(b);
  return fraction(x.numerator * y.denominator + y.numerator * x.denominator, x.denominator * y.denominator);
}
/** Subtract count-derived rates without cancellation in binary floating point. */
export function subtractExact(a: ExactValue, b: ExactValue): Rational {
  const x = decimal(a), y = decimal(b);
  return fraction(x.numerator * y.denominator - y.numerator * x.denominator, x.denominator * y.denominator);
}
/** Multiply exact decimal costs, weights and count ratios. */
export function multiplyExact(a: ExactValue, b: ExactValue): Rational {
  const x = decimal(a), y = decimal(b);
  return fraction(x.numerator * y.numerator, x.denominator * y.denominator);
}
/** Convert only at a display boundary, retaining subnormal decimals without overflowing the denominator. */
export function displayExact(value: ExactValue): number {
  const { numerator: n, denominator: d } = decimal(value);
  const exponent = (n < 0n ? -n : n).toString().length - d.toString().length;
  const scale = 24 - exponent;
  const digits = scale >= 0 ? n * 10n ** BigInt(scale) / d : n / (d * 10n ** BigInt(-scale));
  return Number(`${digits}e${-scale}`);
}
/** Render a count ratio; callers handle empty denominators explicitly. */
export function displayRatio(numerator: number, denominator: number): number { return displayExact(fraction(numerator, denominator)); }
/** Compare empirical precision/recall/F1 using their counts, with an explicit zero-support fallback. */
export function countRatio(numerator: number, denominator: number): Rational { return fraction(numerator, denominator === 0 ? 1 : denominator); }
/** Exact categorical TV from integer counts over the common category union. */
export function populationDistance(a: readonly number[], b: readonly number[]): Rational {
  const na = a.reduce(/** Sum counts as integers before cross multiplication. */ (sum, value) => sum + integer(value), 0n);
  const nb = b.reduce(/** Each vector supplies its own denominator. */ (sum, value) => sum + integer(value), 0n);
  if (a.length !== b.length || na <= 0n || nb <= 0n || [...a, ...b].some(/** Negative counts cannot define a distribution. */ value => value < 0)) throw new RangeError("Population counts require matching nonnegative vectors with positive totals");
  let distance = 0n;
  for (let i = 0; i < a.length; i++) {
    const delta = integer(a[i]) * nb - integer(b[i]) * na;
    distance += delta < 0n ? -delta : delta;
  }
  return fraction(distance, 2n * na * nb);
}
/** Wilson lower-bound qualification via the score inequality, avoiding a rounded irrational bound. */
export function precisionMeets(correct: number, count: number, target: ExactValue, z: ExactValue = "1.6448536269514722"): boolean {
  if (count === 0) return false;
  if (compareExact(target, 1) === 0 && compareExact(z, 0) !== 0) return false;
  const p = fraction(correct, count), gap = subtractExact(p, target);
  return compareExact(gap, 0) >= 0 && compareExact(multiplyExact(multiplyExact(gap, gap), count), multiplyExact(multiplyExact(z, z), multiplyExact(target, subtractExact(1, target)))) >= 0;
}
