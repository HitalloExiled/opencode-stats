/**
 * Pure classification of the request's `system` array into labelled parts.
 *
 * The server builds the system prompt in up to three layers:
 *
 *  1. the base prompt (agent override or the built-in OpenCode prompt);
 *  2. one instructions part carrying `metadata.experimental.instructions`,
 *     where every rendered source has a `key` such as `core/instructions`
 *     (AGENTS.md) or `api/<key>` (session instruction entries);
 *  3. extra parts pushed by plugins after the core layers (`<notes-context>`,
 *     `<memory-context>`, `<plans-context>`, routing rules, ...).
 *
 * This module only reads data; it never runs on the GUI bundle.
 */

import type { PromptCapture, PromptGroup, PromptPart, PromptSource } from "./gui/contract.js";

export type SystemPartLike = {
  type: "text";
  text: string;
  metadata?: Record<string, unknown> | undefined;
};

export type CaptureInput = {
  sessionID: string;
  agent: string;
  model: PromptCapture["model"];
  system: readonly SystemPartLike[];
  capturedAt?: number | undefined;
};

type InstructionEntry = { key: string; text: string };

const CORE_LABELS: Record<string, { label: string; labelKey: string }> = {
  "core/codemode": { label: "Code Mode", labelKey: "part.codemode" },
  "core/mcp-guidance": { label: "MCP", labelKey: "part.mcp" },
  "core/reference-guidance": { label: "References", labelKey: "part.references" },
  "core/skill-guidance": { label: "Skills", labelKey: "part.skills" },
  "core/date": { label: "Date", labelKey: "part.date" },
  "core/environment": { label: "Environment", labelKey: "part.environment" },
};

const PLUGIN_TAGS: ReadonlyArray<{ tag: string; label: string; labelKey: string }> = [
  { tag: "<notes-context>", label: "Notes", labelKey: "part.notes" },
  { tag: "<memory-context>", label: "Memory", labelKey: "part.memory" },
  { tag: "<plans-context>", label: "Plans", labelKey: "part.plans" },
  { tag: "<plans-plugin>", label: "Plans instruction", labelKey: "part.plansInstruction" },
  { tag: "<system-update>", label: "System update", labelKey: "part.systemUpdate" },
];

const ROUTING_RULES: ReadonlyArray<{ prefix: string; label: string; labelKey: string }> = [
  { prefix: "memory routing", label: "Memory routing", labelKey: "part.memoryRouting" },
  { prefix: "notes routing", label: "Notes routing", labelKey: "part.notesRouting" },
  { prefix: "plans routing", label: "Plans routing", labelKey: "part.plansRouting" },
];

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** First non-empty line, stripped of markdown/tags, as a label for unknown parts. */
export function firstLineLabel(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cleaned = line
      .replace(/^#+\s*/, "")
      .replace(/^<[^>]+>\s*/, "")
      .replace(/<\/[^>]+>\s*$/, "")
      .trim();
    if (!cleaned) continue;
    return cleaned.length > 64 ? `${cleaned.slice(0, 63)}…` : cleaned;
  }
  return "Additional context";
}

function isInstructionEntry(value: unknown): value is InstructionEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { key?: unknown; text?: unknown };
  return typeof entry.key === "string" && typeof entry.text === "string";
}

/** Reads `metadata.experimental.instructions` from an instructions part. */
export function instructionEntries(part: SystemPartLike): InstructionEntry[] | undefined {
  const metadata = part.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const experimental = (metadata as { experimental?: unknown }).experimental;
  if (!experimental || typeof experimental !== "object") return undefined;
  const instructions = (experimental as { instructions?: unknown }).instructions;
  if (!Array.isArray(instructions)) return undefined;
  return instructions.filter(isInstructionEntry);
}

function classifyCore(key: string): { label: string; labelKey?: string; group: PromptGroup } {
  const known = CORE_LABELS[key];
  if (known) return { label: known.label, labelKey: known.labelKey, group: "fixed" };
  return { label: key, group: "fixed" };
}

function classifyKey(key: string): {
  label: string;
  labelKey?: string | undefined;
  detail?: string | undefined;
  group: PromptGroup;
  source: PromptSource;
} {
  if (key === "core/instructions") {
    return {
      label: "AGENTS.md and project instructions",
      labelKey: "part.instructions",
      group: "added",
      source: "instructions",
    };
  }
  if (key.startsWith("api/")) {
    const detail = key.slice("api/".length);
    return {
      label: `Dynamic · ${detail}`,
      labelKey: "part.dynamic",
      detail,
      group: "dynamic",
      source: "api",
    };
  }
  if (key.startsWith("core/")) {
    const core = classifyCore(key);
    return { label: core.label, labelKey: core.labelKey, group: core.group, source: "core" };
  }
  return { label: key, group: "dynamic", source: "plugin" };
}

/** Detects known plugin blocks and routing rules; unknown text falls back to its first line. */
function classifyPluginText(text: string): {
  label: string;
  labelKey?: string | undefined;
  key: string;
} {
  const head = text.slice(0, 400).toLowerCase();
  for (const item of PLUGIN_TAGS) {
    if (head.includes(item.tag)) {
      return { label: item.label, labelKey: item.labelKey, key: `plugin/${item.tag.slice(1, -1)}` };
    }
  }
  const first = firstLineLabel(text);
  const normalized = first.toLowerCase();
  for (const rule of ROUTING_RULES) {
    if (normalized.startsWith(rule.prefix)) {
      return { label: rule.label, labelKey: rule.labelKey, key: `plugin/${rule.prefix.replace(/\s+/g, "-")}` };
    }
  }
  return { label: first, key: "plugin/unknown" };
}

/** Converts the request's system parts into ordered, labelled prompt parts. */
export function buildPromptParts(system: readonly SystemPartLike[]): {
  parts: PromptPart[];
  totalBytes: number;
} {
  const parts: PromptPart[] = [];
  let order = 1;

  const push = (
    input: Omit<PromptPart, "order" | "bytes"> & { text: string },
  ) => {
    if (!input.text) return;
    parts.push({
      order: order++,
      key: input.key,
      label: input.label,
      ...(input.labelKey ? { labelKey: input.labelKey } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      group: input.group,
      source: input.source,
      text: input.text,
      bytes: byteLength(input.text),
    });
  };

  for (const part of system) {
    if (!part || part.type !== "text" || !part.text) continue;

    const instructions = instructionEntries(part);
    if (instructions && instructions.length > 0) {
      for (const entry of instructions) {
        const classified = classifyKey(entry.key);
        push({
          key: entry.key,
          label: classified.label,
          ...(classified.labelKey ? { labelKey: classified.labelKey } : {}),
          ...(classified.detail ? { detail: classified.detail } : {}),
          group: classified.group,
          source: classified.source,
          text: entry.text,
        });
      }
      continue;
    }

    if (order === 1) {
      push({
        key: "base",
        label: "Base prompt",
        labelKey: "part.base",
        group: "fixed",
        source: "base",
        text: part.text,
      });
      continue;
    }

    const plugin = classifyPluginText(part.text);
    push({
      key: plugin.key,
      label: plugin.label,
      ...(plugin.labelKey ? { labelKey: plugin.labelKey } : {}),
      group: "dynamic",
      source: "plugin",
      text: part.text,
    });
  }

  const totalBytes = parts.reduce((sum, part) => sum + part.bytes, 0);
  return { parts, totalBytes };
}
