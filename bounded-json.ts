import { open } from "node:fs/promises";
import { constants } from "node:fs";

/** Read bounded regular JSON, handling short reads and growth without blocking on a pipe. */
export async function readBoundedJson(file: string | undefined, maximum: number): Promise<unknown> {
  if (!file?.trim()) throw new Error("A regular JSON file is required.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("A regular JSON file is required.");
    const bytes = Buffer.alloc(maximum + 1); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > maximum) throw new Error("JSON exceeds the byte limit.");
    return JSON.parse(bytes.toString("utf8", 0, offset)) as unknown;
  } finally { await handle.close(); }
}
