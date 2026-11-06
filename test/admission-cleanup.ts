import { rm } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

/** Remove an owned fixture after awaited commands, retrying only transient nonempty directories. */
export async function removeAdmissionScratch(root: string, remove: typeof rm = rm, wait: (ms: number) => Promise<void> = setTimeout): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await remove(root, { recursive: true, force: true }); return; }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== "ENOTEMPTY" || attempt >= 5) throw error;
      await wait(25 * (attempt + 1));
    }
  }
}
