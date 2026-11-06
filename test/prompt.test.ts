/**
 * System prompt classification tests.
 */

import { describe, expect, test } from "bun:test";

import {
  buildPromptParts,
  byteLength,
  firstLineLabel,
  instructionEntries,
  type SystemPartLike,
} from "../src/prompt";

const instructions = (entries: Array<{ key: string; text: string }>): SystemPartLike => ({
  type: "text",
  text: entries.map((entry) => entry.text).join("\n\n"),
  metadata: { experimental: { instructions: entries } },
});

describe("byteLength and labels", () => {
  test("counts UTF-8 bytes", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("🧠")).toBe(4);
  });

  test("uses the first meaningful line, stripping markdown and tags", () => {
    expect(firstLineLabel("# AGENTS.md\nrules")).toBe("AGENTS.md");
    expect(firstLineLabel("\n\n<notes-context>\nbody")).toBe("body");
    expect(firstLineLabel("")).toBe("Additional context");
    expect(firstLineLabel("x".repeat(100))).toHaveLength(64);
  });
});

describe("instructionEntries", () => {
  test("reads only complete entries", () => {
    const part: SystemPartLike = {
      type: "text",
      text: "date",
      metadata: {
        experimental: {
          instructions: [
            { key: "core/date", text: "date" },
            { key: "missing-text" },
            null,
          ],
        },
      },
    };
    expect(instructionEntries(part)).toEqual([{ key: "core/date", text: "date" }]);
  });

  test("returns undefined without the experimental metadata", () => {
    expect(instructionEntries({ type: "text", text: "plain" })).toBeUndefined();
    expect(instructionEntries({ type: "text", text: "plain", metadata: {} })).toBeUndefined();
  });
});

describe("buildPromptParts", () => {
  const system: SystemPartLike[] = [
    { type: "text", text: "BASE PROMPT" },
    instructions([
      { key: "core/codemode", text: "CODEMODE" },
      { key: "core/instructions", text: "# AGENTS.md\nrules" },
      { key: "core/date", text: "DATE" },
      { key: "api/pinned", text: '<context key="pinned">X</context>' },
    ]),
    { type: "text", text: "<notes-context>\nnotes\n</notes-context>" },
    { type: "text", text: "<memory-context>\nmemory\n</memory-context>" },
    { type: "text", text: "<plans-context>\nplans\n</plans-context>" },
    { type: "text", text: "Memory routing: follow these rules" },
    { type: "text", text: "Some extra context from a plugin" },
  ];

  test("orders and groups every layer", () => {
    const { parts, totalBytes } = buildPromptParts(system);

    expect(parts).toHaveLength(10);
    expect(parts.map((part) => part.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(parts.map((part) => part.group)).toEqual([
      "fixed",
      "fixed",
      "added",
      "fixed",
      "dynamic",
      "dynamic",
      "dynamic",
      "dynamic",
      "dynamic",
      "dynamic",
    ]);

    expect(parts[0]!.key).toBe("base");
    expect(parts[1]!.key).toBe("core/codemode");
    expect(parts[1]!.labelKey).toBe("part.codemode");
    expect(parts[2]!.key).toBe("core/instructions");
    expect(parts[2]!.labelKey).toBe("part.instructions");
    expect(parts[3]!.key).toBe("core/date");
    expect(parts[3]!.labelKey).toBe("part.date");
    expect(parts[4]!.key).toBe("api/pinned");
    expect(parts[4]!.labelKey).toBe("part.dynamic");
    expect(parts[4]!.detail).toBe("pinned");

    expect(parts[5]!.labelKey).toBe("part.notes");
    expect(parts[6]!.labelKey).toBe("part.memory");
    expect(parts[7]!.labelKey).toBe("part.plans");
    expect(parts[8]!.labelKey).toBe("part.memoryRouting");
    expect(parts[9]!.labelKey).toBeUndefined();
    expect(parts[9]!.label).toBe("Some extra context from a plugin");

    expect(totalBytes).toBe(parts.reduce((sum, part) => sum + part.bytes, 0));
  });

  test("treats a lone system part as the base prompt", () => {
    const { parts } = buildPromptParts([{ type: "text", text: "only" }]);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.key).toBe("base");
    expect(parts[0]!.group).toBe("fixed");
  });

  test("skips empty parts and empty systems", () => {
    expect(buildPromptParts([])).toEqual({ parts: [], totalBytes: 0 });
    const { parts } = buildPromptParts([
      { type: "text", text: "" },
      { type: "text", text: "base" },
      { type: "text", text: "" },
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toBe("base");
  });

  test("falls back to a plugin part when instruction metadata is empty", () => {
    const { parts } = buildPromptParts([
      { type: "text", text: "base" },
      {
        type: "text",
        text: "instructions",
        metadata: { experimental: { instructions: [] } },
      },
    ]);
    expect(parts[1]!.key).toBe("plugin/unknown");
    expect(parts[1]!.group).toBe("dynamic");
  });

  test("recognises plans and system-update tags", () => {
    const { parts } = buildPromptParts([
      { type: "text", text: "base" },
      { type: "text", text: "<plans-plugin>\ninstruction\n</plans-plugin>" },
      { type: "text", text: "<system-update>\nupdate\n</system-update>" },
    ]);
    expect(parts[1]!.labelKey).toBe("part.plansInstruction");
    expect(parts[2]!.labelKey).toBe("part.systemUpdate");
  });
});
