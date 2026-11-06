/**
 * In-memory capture store for the composed system prompt.
 *
 * The server rebuilds `system` on every request, so the plugin keeps the latest
 * capture per session. Nothing touches disk: the prompt can be large and is
 * only useful while the process is alive. A hash deduplicates unchanged
 * captures and a small LRU keeps memory bounded.
 */

import { createHash } from "node:crypto";

import type { PromptCapture } from "./gui/contract.js";
import { buildPromptParts, byteLength, type CaptureInput } from "./prompt.js";

export type CaptureStoreOptions = {
  /** Maximum sessions kept in memory. Defaults to 50. */
  maxSessions?: number;
  /** Maximum total bytes kept across sessions. Defaults to 8 MiB. */
  maxTotalBytes?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
};

export type CaptureStore = {
  /** Captures the system array for one request. Never throws. */
  capture(input: CaptureInput): PromptCapture;
  /** Latest capture for a session, touching its LRU position. */
  get(sessionID: string): PromptCapture | null;
  /** Latest capture without touching the LRU; used by status reads. */
  peek(sessionID: string): PromptCapture | null;
  /** Drops every capture. */
  clear(): void;
  readonly size: number;
  readonly bytes: number;
};

export function hashPrompt(parts: readonly { key: string; text: string }[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part.key);
    hash.update("\u0000");
    hash.update(part.text);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

export function createCaptureStore(options: CaptureStoreOptions = {}): CaptureStore {
  const maxSessions = Math.max(1, options.maxSessions ?? 50);
  const maxTotalBytes = Math.max(1, options.maxTotalBytes ?? 8 * 1024 * 1024);
  const clock = options.now ?? Date.now;
  const sessions = new Map<string, PromptCapture>();

  const touch = (sessionID: string) => {
    const capture = sessions.get(sessionID);
    if (!capture) return;
    sessions.delete(sessionID);
    sessions.set(sessionID, capture);
  };

  const evict = () => {
    while (sessions.size > 1 && sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    let total = 0;
    for (const capture of sessions.values()) total += capture.totalBytes;
    while (sessions.size > 1 && total > maxTotalBytes) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      const removed = sessions.get(oldest);
      sessions.delete(oldest);
      total -= removed?.totalBytes ?? 0;
    }
  };

  const capture = (input: CaptureInput): PromptCapture => {
    const sessionID = String(input.sessionID);
    const { parts, totalBytes } = buildPromptParts(input.system);
    // Tool schemas are sent alongside `system`, not inside it; include them in
    // the dedupe hash so a tool-set change creates a new capture.
    const toolsText = JSON.stringify(input.tools ?? {});
    const toolBytes = byteLength(toolsText);
    const hash = createHash("sha256")
      .update(hashPrompt(parts))
      .update("\u0000")
      .update(toolsText)
      .digest("hex");
    const previous = sessions.get(sessionID);
    const requestCount = (previous?.requestCount ?? 0) + 1;
    const capturedAt = input.capturedAt ?? clock();

    const next: PromptCapture =
      previous && previous.hash === hash
        ? {
            ...previous,
            capturedAt,
            requestCount,
            agent: String(input.agent),
            model: { ...input.model },
          }
        : {
            sessionID,
            capturedAt,
            agent: String(input.agent),
            model: { ...input.model },
            parts,
            totalBytes,
            toolBytes,
            hash,
            requestCount,
          };

    sessions.delete(sessionID);
    sessions.set(sessionID, next);
    evict();
    return next;
  };

  return {
    capture,
    get(sessionID) {
      const capture = sessions.get(String(sessionID));
      if (!capture) return null;
      touch(String(sessionID));
      return capture;
    },
    peek(sessionID) {
      return sessions.get(String(sessionID)) ?? null;
    },
    clear() {
      sessions.clear();
    },
    get size() {
      return sessions.size;
    },
    get bytes() {
      let total = 0;
      for (const capture of sessions.values()) total += capture.totalBytes;
      return total;
    },
  };
}
