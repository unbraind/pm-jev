/** Retain at most limit UTF-16 units without splitting a valid surrogate pair; malformed input stays invalid. */
export function boundedText(value, limit) {
    const prefix = value.slice(0, limit);
    const splitsPair = /[\uD800-\uDBFF]$/.test(prefix) && /[\uDC00-\uDFFF]/.test(value.charAt(prefix.length));
    return splitsPair ? prefix.slice(0, -1) : prefix;
}
//# sourceMappingURL=bounded-text.js.map