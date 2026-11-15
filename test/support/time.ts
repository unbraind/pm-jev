/** Scale harness budgets only; product deadlines and their assertions stay fixed. */
export function testTime(milliseconds: number): number {
  const scale = Number(process.env.PM_TEST_TIME_SCALE ?? "1");
  const result = Math.ceil(milliseconds * scale);
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(result) || result > 2_147_483_647) {
    throw new Error("PM_TEST_TIME_SCALE must produce a finite positive timer budget");
  }
  return result;
}
