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
export function precisionMeets(correct: number, count: number, target: ThresholdInput, z: ExactValue = "1.6448536269514722"): boolean {
  if (count === 0) return false;
  const boundary = threshold(target);
  if (boundary.state === "disabled") return false;
  if (boundary.state === "unbounded") return true;
  const q = thresholdRatio(boundary);
  if (compareThreshold(q, 1) === 0 && compareThreshold(z, 0) !== 0) return false;
  const p = fraction(correct, count), gap = subtractExact(p, q);
  return compareThreshold(gap, 0) >= 0 && compareThreshold(multiplyExact(multiplyExact(gap, gap), count), multiplyExact(multiplyExact(z, z), multiplyExact(q, subtractExact(1, q)))) >= 0;
}

/** Portable exact policy boundary; disabled and the legacy negative-infinity bound are explicit states. */
export type Threshold = { readonly state: "enabled"; readonly numerator: string; readonly denominator: string } | { readonly state: "disabled" } | { readonly state: "unbounded" };
/** Legacy numeric/null cutoffs and exact tagged boundaries are accepted at the same boundary. */
export type ThresholdInput = ExactValue | Threshold | null;

/** Bound the portable representation so every emitted threshold can be validated after a round trip. */
function portable(ratio: Rational): Threshold {
  const numerator = String(ratio.numerator), denominator = String(ratio.denominator);
  if (numerator.length > 2048 || denominator.length > 2048) throw new RangeError("Serialized threshold exceeds the size bound");
  return { state: "enabled", numerator, denominator };
}
/** Normalize legacy sentinels before arithmetic and validate the one serialized threshold schema. */
export function threshold(value: ThresholdInput): Threshold {
  if (value === null || value === Infinity) return { state: "disabled" };
  if (value === -Infinity) return { state: "unbounded" };
  if (typeof value === "object" && "state" in value) {
    const keys = Object.keys(value);
    if ((value.state === "disabled" || value.state === "unbounded") && keys.length === 1 && keys[0] === "state") return { state: value.state };
    if (value.state !== "enabled" || keys.length !== 3 || !["state", "numerator", "denominator"].every(/** Serialized states require their own exact fields. */ key => Object.hasOwn(value, key)) || typeof value.numerator !== "string" || typeof value.denominator !== "string" || !/^-?\d{1,2048}$/.test(value.numerator) || !/^\d{1,2048}$/.test(value.denominator)) throw new RangeError("Invalid serialized threshold");
    const ratio = fraction(BigInt(value.numerator), BigInt(value.denominator));
    return portable(ratio);
  }
  const ratio = decimal(value);
  return portable(ratio);
}
/** Single fit/apply comparator: finite rationals cross-multiply; explicit sentinels retain legacy ordering. */
export function compareThreshold(a: ThresholdInput, b: ThresholdInput): -1 | 0 | 1 {
  const x = threshold(a), y = threshold(b);
  if (x.state === "disabled" || y.state === "unbounded") return x.state === y.state ? 0 : 1;
  if (x.state === "unbounded" || y.state === "disabled") return -1;
  const left = BigInt(x.numerator) * BigInt(y.denominator), right = BigInt(y.numerator) * BigInt(x.denominator);
  return left < right ? -1 : left > right ? 1 : 0;
}
/** A disabled cutoff accepts nothing, even when a legacy metric row contains a nonfinite score. */
export function acceptsThreshold(value: ThresholdInput, cutoff: ThresholdInput, exclusive = false): boolean {
  const boundary = threshold(cutoff);
  if (boundary.state === "disabled") return false;
  const comparison = compareThreshold(value, boundary);
  return exclusive ? comparison > 0 : comparison >= 0;
}
/** Resolve a finite tagged threshold to its exact arithmetic value after boundary normalization. */
export function thresholdRatio(value: ThresholdInput): Rational {
  const cutoff = threshold(value);
  if (cutoff.state !== "enabled") throw new RangeError("Disabled or unbounded thresholds have no finite ratio");
  return fraction(BigInt(cutoff.numerator), BigInt(cutoff.denominator));
}
/** Negative evidence cannot be established by a disabled channel; never subtract an infinity sentinel. */
export function belowComplement(value: ExactValue, cutoff: ThresholdInput): boolean {
  const normalized = threshold(cutoff);
  if (normalized.state === "disabled") return false;
  if (normalized.state === "unbounded") return true;
  return compareThreshold(value, subtractExact(1, thresholdRatio(normalized))) <= 0;
}
/** Adjacent binary value toward minus infinity, used only to construct a round-tripping decimal boundary. */
function nextDown(value: number): number {
  if (value === 0) return -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + (value > 0 ? -1n : 1n));
  return view.getFloat64(0);
}
/** Choose a numeric decimal boundary no greater than the exact observation; fitting counts with this same boundary. */
export function numericBoundary(value: ExactValue): number {
  let candidate = displayExact(value);
  if (!Number.isFinite(candidate)) throw new RangeError("A fitted finite boundary must have a finite numeric representation");
  while (compareThreshold(candidate, value) > 0) {
    candidate = nextDown(candidate);
    if (!Number.isFinite(candidate)) throw new RangeError("No finite numeric boundary exists below this value");
  }
  return candidate;
}
/** Preserve last-release scalar result forms while new typed results retain explicit sentinel states. */
export function legacyThreshold(value: ThresholdInput): number {
  const cutoff = threshold(value);
  if (cutoff.state === "disabled") return Infinity;
  if (cutoff.state === "unbounded") return -Infinity;
  const projected = displayExact(thresholdRatio(cutoff));
  if (!Number.isFinite(projected) || compareThreshold(projected, cutoff) !== 0) throw new RangeError("Use the tagged cutoff when a scalar cannot round-trip exactly");
  return projected;
}
/** The exact top-two margin from probabilities as stored, shared by margin fitting and runtime application. */
export function marginValue(probabilities: Readonly<Record<string, number>>): Rational {
  const ordered = Object.values(probabilities).sort(/** Preserve equal-score order through the shared comparator. */ (a, b) => compareThreshold(b, a));
  if (ordered.length < 2) throw new RangeError("Margin decisions require at least two probabilities");
  return subtractExact(ordered[0], ordered[1]);
}
