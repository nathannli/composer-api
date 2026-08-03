import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export function hashOwnerKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ContextWindowCache {
  private identity: string | undefined;
  private value: Record<string, number> = {};

  constructor(private readonly filePath: string) {}

  read(): Record<string, number> {
    let identity: string;
    try {
      const stats = statSync(this.filePath);
      identity = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
    } catch {
      this.identity = undefined;
      this.value = {};
      return this.value;
    }

    if (identity === this.identity) return this.value;

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as {
        contextWindows?: Record<string, unknown>;
      };
      this.value = Object.fromEntries(
        Object.entries(parsed.contextWindows ?? {})
          .filter((entry): entry is [string, number] => (
            typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] > 0
          ))
          .map(([model, contextWindow]) => [model.trim().toLowerCase(), contextWindow])
      );
    } catch {
      this.value = {};
    }
    this.identity = identity;
    return this.value;
  }
}

export function createDeadline(timeoutMs: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer)
  };
}

interface StoppableServer {
  stop(force?: boolean): Promise<void> | void;
}

export async function stopServerGracefully(server: StoppableServer, forceAfterMs: number): Promise<void> {
  const timer = setTimeout(() => {
    void server.stop(true);
  }, forceAfterMs);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  try {
    await server.stop(false);
  } finally {
    clearTimeout(timer);
  }
}
