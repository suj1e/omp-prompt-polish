import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { polishDraft, protectDraft, readPolishResponse } from "../src/inference.ts";

type Reply = Parameters<typeof readPolishResponse>[0];
const response = (overrides: Partial<Reply> = {}): Reply => ({
	stopReason: "stop",
	content: [{ type: "text", text: "改写后的草稿" }],
	...overrides,
});

describe("protectDraft", () => {
	test("leaves ordinary prose available for editing", () => {
		const protectedDraft = protectDraft("帮我 看看这个问题。Keep it casual.");
		expect(protectedDraft.placeholders).toEqual([]);
		expect(protectedDraft.text).toBe("帮我 看看这个问题。Keep it casual.");
		expect(protectedDraft.restore("帮我看看这个问题。Keep it casual.")).toBe("帮我看看这个问题。Keep it casual.");
	});

	test("protects present labels without sending expansions or absent atoms", () => {
		const atoms = new Map([
			["custom #1", "SECRET FILE CONTENT"],
			["custom #10", "data:image/png;base64,SECRET"],
			["absent label", "ANOTHER SECRET"],
			["", "EMPTY LABEL SECRET"],
		]);
		const draft = "看看 custom #10 和 custom #1，再看看 custom #10。";
		const protectedDraft = protectDraft(draft, atoms);
		expect(protectedDraft.placeholders).toHaveLength(3);
		expect(protectedDraft.text).not.toContain("custom");
		expect(protectedDraft.text).not.toContain("SECRET");
		expect(protectedDraft.text).not.toContain("absent label");
		expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
		expect(protectedDraft.restore(protectedDraft.text.replace("看看", "请查看"))).toBe(draft.replace("看看", "请查看"));
	});

	test("gives repeated identical content separate placeholders", () => {
		const protectedDraft = protectDraft("`same` then `same` then [Paste #1] then [Paste #1]");
		expect(protectedDraft.placeholders).toHaveLength(4);
		expect(new Set(protectedDraft.placeholders).size).toBe(4);
		expect(protectedDraft.restore(protectedDraft.text)).toBe("`same` then `same` then [Paste #1] then [Paste #1]");
	});

	test("protects omp markers and legacy attachment links without swallowing prose", () => {
		const draft = "看 [Image #1, 800x600]，对照 [Video #2]，引用 [Paste #3, +30 lines] 和 [Paste #4, 1024 chars] attachment://1。继续改写这句话。";
		const protectedDraft = protectDraft(draft);
		expect(protectedDraft.placeholders).toHaveLength(5);
		expect(protectedDraft.text).not.toContain("800x600");
		expect(protectedDraft.text).not.toContain("attachment://");
		expect(protectedDraft.text).toContain("继续改写这句话。");
		expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
	});

	test("protects native compact chip variants", () => {
		const draft = "\u{1f4f7} #1 \u{1f3ac} #2 \u{1f4c4} #3 \uf03e #4 \uf008 #5 \uf15c #6 img #7 vid #8 txt #9";
		const protectedDraft = protectDraft(draft);
		expect(protectedDraft.placeholders).toHaveLength(9);
		expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
	});

	test("does not treat ordinary bracketed text as an attachment", () => {
		const draft = "[Image description and normal words] [Paste this later] [Image #1 ordinary prose]";
		const protectedDraft = protectDraft(draft);
		expect(protectedDraft.text).toBe(draft);
		expect(protectedDraft.placeholders).toHaveLength(0);
	});

	test("retains fenced code byte for byte including nested fences and CRLF", () => {
		const code = "````ts\r\nconst x = `literal`;\r\n```\r\n[Image #1]\r\n````";
		const draft = `请检查：\r\n${code}\r\n但不要执行。`;
		const protectedDraft = protectDraft(draft);
		expect(protectedDraft.placeholders).toHaveLength(1);
		expect(protectedDraft.text).not.toContain("const x");
		expect(protectedDraft.text).toContain("但不要执行。");
		expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
	});

	test("retains tilde and unclosed fences through the end of the draft", () => {
		for (const draft of ["前文\n  ~~~sh\necho hello\n  ~~~~\n后文", "前文\n```ts\nconst unfinished = 1;\n"]) {
			const protectedDraft = protectDraft(draft);
			expect(protectedDraft.placeholders).toHaveLength(1);
			expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
		}
	});

	test("matches complete inline delimiter runs and leaves unmatched backticks editable", () => {
		const draft = "请检查 ``a `b` c`` 和 `src/main.ts`，保留这个未闭合的 ` 标记。";
		const protectedDraft = protectDraft(draft);
		expect(protectedDraft.placeholders).toHaveLength(2);
		expect(protectedDraft.text).not.toContain("a `b` c");
		expect(protectedDraft.text).toContain("保留这个未闭合的 ` 标记。");
		expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
	});

	test("does not let inline code consume a separate fenced block", () => {
		const draft = "未闭合 `\n```js\nconsole.log(1);\n```\n后文";
		const protectedDraft = protectDraft(draft);
		expect(protectedDraft.placeholders).toHaveLength(1);
		expect(protectedDraft.text).toContain("未闭合 `");
		expect(protectedDraft.text).toContain("后文");
		expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
	});

	test("retains practical URLs and paths while leaving punctuation editable", () => {
		const literals = [
			"https://example.com/a_(b)?x=1&y=2#section",
			"src/main.ts",
			"../config.json",
			"/var/log/app.log",
			"C:\\work\\file.ts",
			"\\\\server\\share\\file.txt",
			"~/project/settings.json",
			"file:///C:/project/readme.md",
		];
		for (const literal of literals) {
			const draft = `请检查 ${literal}，谢谢。`;
			const protectedDraft = protectDraft(draft);
			expect(protectedDraft.text).not.toContain(literal);
			expect(protectedDraft.text).toEndWith("，谢谢。");
			expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
		}
		const draft = "See (https://example.com/a(b)). Then edit src/main.ts.";
		const protectedDraft = protectDraft(draft);
		expect(protectedDraft.text).toBe(`See (${protectedDraft.placeholders[0]}). Then edit ${protectedDraft.placeholders[1]}.`);
		expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
	});

	test("retains quoted paths containing spaces", () => {
		const draft = '修改 "C:\\My Project\\file.ts" 和 \'../my project/config.json\'，保持行为。';
		const protectedDraft = protectDraft(draft);
		expect(protectedDraft.placeholders).toHaveLength(2);
		expect(protectedDraft.text).not.toContain("My Project");
		expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
	});

	test("merges overlapping labels and code without losing bytes", () => {
		const draft = "`label with src/file.ts` ababa";
		const protectedDraft = protectDraft(draft, new Map([["label with", "secret"], ["aba", "secret"], ["bab", "secret"]]));
		expect(protectedDraft.placeholders).toHaveLength(2);
		expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
	});

	test("isolates user supplied placeholder names and restores in one pass", () => {
		const draft = "保留 [[OMP_POLISH_0:0]] 和 [[OMP_POLISH_1:0]]，再保留 `code`。";
		const protectedDraft = protectDraft(draft);
		expect(protectedDraft.placeholders).toHaveLength(3);
		expect(protectedDraft.placeholders[0]).toBe("[[OMP_POLISH_2:0]]");
		expect(protectedDraft.restore(protectedDraft.text)).toBe(draft);
	});

	test("rejects missing, repeated, changed, malformed, invented and reordered placeholders", () => {
		const protectedDraft = protectDraft("保留 `first` 和 `second`。");
		const [first, second] = protectedDraft.placeholders as readonly [string, string];
		const invalid = [
			protectedDraft.text.replace(first, ""),
			protectedDraft.text + first,
			protectedDraft.text.replace(first, first.replace(":0", ":99")),
			protectedDraft.text.replace(first, first.slice(0, -1)),
			protectedDraft.text.replace(first, first.replace("OMP", "omp")),
			protectedDraft.text + "[[OMP_POLISH_0:99]]",
			protectedDraft.text + "[[OMP_POLISH_0BROKEN]]",
			`${second} ${first}`,
			"模型忘记了所有受保护内容",
		];
		for (const text of invalid) expect(() => protectedDraft.restore(text)).toThrow("润色失败：");
	});

	test("rejects invented placeholders even when the original had none", () => {
		expect(() => protectDraft("普通文字").restore("普通文字 [[OMP_POLISH_0:0]]")).toThrow("润色失败：");
	});
});

describe("readPolishResponse", () => {
	test("uses only visible text and preserves internal whitespace", () => {
		expect(readPolishResponse(response({ content: [
			{ type: "thinking", thinking: "do not expose" },
			{ type: "redactedThinking", data: "opaque" },
			{ type: "text", text: "  请保留\n" },
			{ type: "text", text: "  缩进。  " },
		] }))).toBe("请保留\n  缩进。");
	});

	test("rejects empty replies, including thinking-only responses", () => {
		for (const content of [[], [{ type: "text" as const, text: " \n\t " }], [{ type: "thinking" as const, thinking: "hidden" }]]) {
			expect(() => readPolishResponse(response({ content }))).toThrow("空白内容");
		}
	});

	test("rejects failed and incomplete stop reasons even with plausible text", () => {
		expect(() => readPolishResponse(response({ stopReason: "error", errorMessage: "服务不可用" }))).toThrow("润色失败：服务不可用");
		expect(() => readPolishResponse(response({ stopReason: "error" }))).toThrow("模型服务返回错误");
		expect(() => readPolishResponse(response({ stopReason: "length" }))).toThrow("被截断");
		expect(() => readPolishResponse(response({ stopReason: "toolUse" }))).toThrow("没有正常完成");
	});

	test("keeps provider cancellation recognizable as AbortError", () => {
		try {
			readPolishResponse(response({ stopReason: "aborted" }));
			throw new Error("expected cancellation");
		} catch (error) {
			expect(error).toBeInstanceOf(DOMException);
			expect((error as DOMException).name).toBe("AbortError");
		}
	});

	test("rejects unexpected tool calls instead of accepting accompanying prose", () => {
		expect(() => readPolishResponse(response({ content: [
			{ type: "text", text: "看起来像润色稿" },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo no" } },
		] }))).toThrow("非文本内容");
	});
});

describe("polishDraft preconditions", () => {
	test("reports a missing model without calling the model API", async () => {
		await expect(polishDraft({ model: undefined } as ExtensionContext, "草稿", new Map(), new AbortController().signal))
			.rejects.toThrow("请先选择一个模型");
	});

	test("preserves the original abort reason before touching context", async () => {
		const controller = new AbortController();
		const reason = new Error("cancel this exact operation");
		controller.abort(reason);
		await expect(polishDraft({} as ExtensionContext, "草稿", new Map(), controller.signal)).rejects.toBe(reason);
	});
});
