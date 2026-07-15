// Native file-tool no-ops must return control to the model so later task steps can run.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  agentLoop,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { createApplyPatchTool } from "./apply-patch.js";
import { createEditTool } from "./sessions/tools/edit.js";
import { createWriteTool } from "./sessions/tools/write.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

const TEST_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ORIGINAL_CONTENT = "foo\nbar\n";
const FINAL_CONTENT = "completed\n";
const tempDirs: string[] = [];

type NoOpCase = {
  name: string;
  createTool: (cwd: string) => AgentTool;
  args: Record<string, unknown>;
};

const noOpCases: NoOpCase[] = [
  {
    name: "write",
    createTool: (cwd) => createWriteTool(cwd),
    args: { path: "source.txt", content: ORIGINAL_CONTENT },
  },
  {
    name: "edit",
    createTool: (cwd) => createEditTool(cwd),
    args: { path: "source.txt", edits: [{ oldText: "bar", newText: "bar" }] },
  },
  {
    name: "apply_patch",
    createTool: (cwd) => createApplyPatchTool({ cwd }),
    args: {
      input: `*** Begin Patch
*** Update File: source.txt
@@
 foo
-bar
+bar
*** End Patch`,
    },
  },
];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("native file-tool no-op continuation", () => {
  it.each(noOpCases)("continues after a $name no-op and completes later work", async (testCase) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-file-noop-loop-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, "source.txt"), ORIGINAL_CONTENT, "utf8");

    const noOpTool = testCase.createTool(cwd);
    const writeTool = createWriteTool(cwd);
    const tools = noOpTool.name === writeTool.name ? [noOpTool] : [noOpTool, writeTool];
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      streamCalls += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          streamCalls === 1
            ? createToolCallMessage("call-noop", noOpTool.name, testCase.args, streamCalls)
            : streamCalls === 2
              ? createToolCallMessage(
                  "call-final-write",
                  writeTool.name,
                  { path: "reached-after-noop.txt", content: FINAL_CONTENT },
                  streamCalls,
                )
              : createFinalMessage(streamCalls);
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    };

    const stream = agentLoop(
      [{ role: "user", content: "complete every file step", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools },
      { model, convertToLlm: (messages) => messages as Message[] },
      undefined,
      streamFn,
    );
    const events = await collectEvents(stream);

    expect(streamCalls).toBe(3);
    await expect(fs.readFile(path.join(cwd, "source.txt"), "utf8")).resolves.toBe(ORIGINAL_CONTENT);
    await expect(fs.readFile(path.join(cwd, "reached-after-noop.txt"), "utf8")).resolves.toBe(
      FINAL_CONTENT,
    );
    expect(
      events.some(
        (event) =>
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.content.some(
            (content) => content.type === "text" && content.text === "all steps complete",
          ),
      ),
    ).toBe(true);
  });
});

function createToolCallMessage(
  id: string,
  name: string,
  args: Record<string, unknown>,
  timestamp: number,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: TEST_USAGE,
    stopReason: "toolUse",
    timestamp,
  };
}

function createFinalMessage(timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "all steps complete" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: TEST_USAGE,
    stopReason: "stop",
    timestamp,
  };
}

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
