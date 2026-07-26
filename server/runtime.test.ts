import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContextWindowCache,
  createDeadline,
  hashOwnerKey,
  stopServerGracefully
} from "./runtime";

describe("server runtime helpers", () => {
  it("derives a full SHA-256 owner fingerprint", () => {
    expect(hashOwnerKey("cursor-key")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOwnerKey("cursor-key")).not.toBe(hashOwnerKey("other-key"));
  });

  it("reloads context windows after the bridge atomically replaces the cache file", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "composer-server-context-"));
    const cachePath = path.join(directory, "context-windows.json");
    const replacementPath = path.join(directory, "replacement.json");
    try {
      writeFileSync(cachePath, JSON.stringify({ contextWindows: { "composer-2.5": 200_000 } }));
      const cache = new ContextWindowCache(cachePath);
      expect(cache.read()).toEqual({ "composer-2.5": 200_000 });

      writeFileSync(replacementPath, JSON.stringify({ contextWindows: { "grok-4.5": 384_000 } }));
      renameSync(replacementPath, cachePath);
      expect(cache.read()).toEqual({ "grok-4.5": 384_000 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("aborts an expired bridge deadline", async () => {
    const deadline = createDeadline(5);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(deadline.signal.aborted).toBe(true);
    } finally {
      deadline.clear();
    }
  });

  it("forces shutdown after the graceful drain deadline", async () => {
    let resolveGraceful!: () => void;
    const calls: boolean[] = [];
    const server = {
      stop(force = false) {
        calls.push(force);
        if (force) {
          resolveGraceful();
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          resolveGraceful = resolve;
        });
      }
    };

    await stopServerGracefully(server, 5);
    expect(calls).toEqual([false, true]);
  });
});
