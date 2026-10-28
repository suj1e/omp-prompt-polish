import { describe, expect, test } from "bun:test";
import { Drafts } from "../src/drafts.ts";

function scenario(text = "原稿") {
  let revision = 0;
  let finish!: (text: string) => void;
  let fail!: (error: Error) => void;
  let signal: AbortSignal | undefined;
  const messages: string[] = [];
  let drafts: Drafts;
  const edit = (next: string) => { text = next; revision++; drafts.changed(text); };
  drafts = new Drafts({
    read: () => ({ text, revision: String(revision) }),
    write: edit,
    generate: (_text, nextSignal) => {
      signal = nextSignal;
      const deferred = Promise.withResolvers<string>();
      finish = deferred.resolve;
      fail = deferred.reject;
      return deferred.promise;
    },
    repaint() {},
    notify: message => messages.push(message),
  });
  return {
    drafts, edit, messages,
    text: () => text,
    get finish() { return finish; },
    fail: (error: Error) => fail(error),
    signal: () => signal,
  };
}

describe("draft pair transitions", () => {
  test("restoring rejects the old result and the next polish makes a fresh request", async () => {
    const s = scenario();
    const first = s.drafts.polish();
    s.finish("不满意的润色稿");
    await first;
    s.edit("手改润色稿");
    s.drafts.applyOrRestore();
    expect(s.text()).toBe("原稿");
    expect(s.drafts.hasPair).toBe(false);
    s.edit("手改原稿");
    const next = s.drafts.polish();
    expect(s.drafts.working).toBe(true);
    expect(s.text()).toBe("手改原稿");
    s.finish("重新生成的润色稿");
    await next;
    expect(s.text()).toBe("重新生成的润色稿");
    s.drafts.applyOrRestore();
    expect(s.text()).toBe("手改原稿");
  });

  test("an edit and reversal still require explicit application", async () => {
    const s = scenario();
    const request = s.drafts.polish();
    s.edit("临时修改");
    s.edit("原稿");
    s.finish("润色稿");
    await request;
    expect(s.text()).toBe("原稿");
    expect(s.drafts.ready).toBe(true);
    s.edit("最新草稿");
    s.drafts.applyOrRestore();
    expect(s.text()).toBe("润色稿");
    s.drafts.applyOrRestore();
    expect(s.text()).toBe("最新草稿");
  });

  test("a canceled request cannot land after a new request starts", async () => {
    const s = scenario();
    const old = s.drafts.polish();
    const oldFinish = s.finish;
    s.drafts.cancel();
    expect(s.signal()?.aborted).toBe(true);
    const next = s.drafts.polish();
    oldFinish("过期润色");
    await old;
    expect(s.text()).toBe("原稿");
    expect(s.drafts.working).toBe(true);
    s.finish("新润色");
    await next;
    expect(s.text()).toBe("新润色");
  });

  test("submission or session reset discards work even if transport resolves", async () => {
    const s = scenario();
    const request = s.drafts.polish();
    s.drafts.reset();
    s.edit("另一个会话的草稿");
    s.finish("迟到的润色");
    await request;
    expect(s.text()).toBe("另一个会话的草稿");
    expect(s.drafts.hasPair).toBe(false);
    expect(s.drafts.ready).toBe(false);
  });

  test("failed re-polish keeps the existing pair and current edits", async () => {
    const s = scenario();
    const first = s.drafts.polish();
    s.finish("润色稿");
    await first;
    s.edit("手改润色稿");
    const next = s.drafts.polish();
    s.fail(new Error("服务暂不可用"));
    await next;
    expect(s.text()).toBe("手改润色稿");
    s.drafts.applyOrRestore();
    expect(s.text()).toBe("原稿");
    expect(s.messages).toContain("服务暂不可用");
  });
});
