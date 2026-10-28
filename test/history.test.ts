import { describe, expect, test } from "bun:test";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { recentConversation } from "../src/history.ts";

function user(content: UserMessage["content"], extra: Partial<UserMessage> = {}): UserMessage {
  return { role: "user", content, timestamp: 0, ...extra };
}

function assistant(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }],
    api: "openai-completions", provider: "openai", model: "test", timestamp: 0,
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...extra,
  };
}

function entry(id: string, parentId: string | null, message: SessionMessageEntry["message"]): SessionMessageEntry {
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message };
}

function history(entries: SessionEntry[], leaf = entries.at(-1)?.id) {
  const byId = new Map(entries.map(item => [item.id, item]));
  return {
    getLeafEntry: () => leaf ? byId.get(leaf) : undefined,
    getEntry: (id: string) => byId.get(id),
  };
}

describe("recentConversation", () => {
  test("retains the newest six chat messages in chronological order, including corrections", () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(String(i), i ? String(i - 1) : null,
      i % 2 ? assistant(`回复 ${i}`) : user(i === 6 ? "纠正：不需要旧方案，使用最新方案" : `问题 ${i}`)));
    expect(recentConversation(history(entries))).toEqual([
      { role: "user", text: "问题 2" },
      { role: "assistant", text: "回复 3" },
      { role: "user", text: "问题 4" },
      { role: "assistant", text: "回复 5" },
      { role: "user", text: "纠正：不需要旧方案，使用最新方案" },
      { role: "assistant", text: "回复 7" },
    ]);
  });

  test("follows the selected branch rather than the latest appended sibling", () => {
    const entries = [
      entry("root", null, user("公共背景")),
      entry("left", "root", assistant("当前分支方案")),
      entry("right", "root", assistant("不相关分支方案")),
    ];
    expect(recentConversation(history(entries, "left"))).toEqual([
      { role: "user", text: "公共背景" }, { role: "assistant", text: "当前分支方案" },
    ]);
  });

  test("excludes tools, reasoning, images, provider payloads and automatic prompts", () => {
    const entries = [
      entry("0", null, user([{ type: "text", text: "用户正文" }, { type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }])),
      entry("1", "0", { role: "toolResult", toolCallId: "call", toolName: "read", isError: false,
        content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }], timestamp: 0 }),
      entry("2", "1", user("AUTO_CONTINUE", { synthetic: true })),
      entry("3", "2", user("AGENT_INJECTION", { attribution: "agent" })),
      entry("4", "3", assistant("", { content: [
        { type: "thinking", thinking: "PRIVATE_REASONING" },
        { type: "image", data: "PRIVATE_ASSISTANT_IMAGE", mimeType: "image/png" },
        { type: "text", text: "助手正文" },
      ] })),
    ];
    expect(recentConversation(history(entries))).toEqual([
      { role: "user", text: "用户正文" }, { role: "assistant", text: "助手正文" },
    ]);
  });

  test("stops at a reset boundary and ignores failed or tool-only assistant steps", () => {
    const boundary: SessionEntry = { type: "reset_boundary", id: "reset", parentId: "old", timestamp: "2026-01-01T00:00:00.000Z" };
    const entries = [entry("old", null, user("清空前的背景")), boundary,
      entry("new", "reset", user("清空后的背景")),
      entry("failed", "new", assistant("失败的部分输出", { stopReason: "error" })),
      entry("step", "failed", assistant("工具调用中的文字", { stopReason: "toolUse" })),
    ];
    expect(recentConversation(history(entries))).toEqual([{ role: "user", text: "清空后的背景" }]);
    expect(recentConversation(history([]))).toEqual([]);
  });

  test("bounds long messages and total text while prioritizing the newest content", () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(String(i), i ? String(i - 1) : null,
      user("旧内容".repeat(2000) + `最新结论 ${i}`)));
    const result = recentConversation(history(entries));
    expect(result.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(12_000);
    expect(result.every(message => message.text.length <= 4_000)).toBe(true);
    expect(result.at(-1)?.text).toEndWith("最新结论 7");
    expect(JSON.stringify(result)).not.toContain("最新结论 0");
  });

  test("honors budgets across text blocks without splitting surrogate pairs", () => {
    const result = recentConversation(history([entry("a", null, user([
      { type: "text", text: "较早内容" },
      { type: "text", text: "🙂".repeat(3000) + "结论" },
      { type: "text", text: "末尾" },
    ]))]));
    expect(result[0].text.length).toBeLessThanOrEqual(4_000);
    expect(result[0].text).toEndWith("结论\n末尾");
    expect(result[0].text.isWellFormed()).toBe(true);
    const almostFull = recentConversation(history([entry("b", null, user([
      { type: "text", text: "不应突破预算".repeat(100) },
      { type: "text", text: "x".repeat(3997) },
    ]))]));
    expect(almostFull[0].text).toHaveLength(3997);
  });
});
