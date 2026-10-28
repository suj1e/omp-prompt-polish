import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { node, row, type NativeNode } from "@oh-my-pi/pi-tui";
import type { NativeEditorLayout } from "@oh-my-pi/pi-tui/components/editor";
import { Drafts } from "./drafts.ts";
import { polishDraft } from "./inference.ts";

const ACTION = "omp-prompt-polish.";

export default function promptPolish(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let editor: CustomEditor | undefined;
  let repaint = () => {};
  const drafts = new Drafts({
    read: () => ({
      text: editor?.getText() ?? "",
      revision: `${editor?.textRevision}:${editor?.atomsRevision}`,
    }),
    write: text => { editor?.setText(text); repaint(); },
    generate: (text, signal) => {
      if (!context || !editor) throw new Error("输入框尚未就绪。");
      return polishDraft(context, text, new Map(editor.atoms), signal);
    },
    repaint: () => repaint(),
    notify: (message, type) => context?.ui.notify(message, type),
  });

  function enabled(): boolean {
    const state = editor?.composerState();
    const text = editor?.getText() ?? "";
    return Boolean(text.trim()) && !/^\s*\//.test(text) &&
      !state?.shell && !state?.viewing?.length &&
      !editor?.pasteInFlight && state?.dictation !== "recording" && state?.dictation !== "transcribing";
  }

  async function primary(): Promise<void> {
    if (drafts.working) { drafts.cancel(); return; }
    if (!enabled()) return;
    if (drafts.ready || drafts.hasPair) drafts.applyOrRestore();
    else await drafts.polish();
  }

  function run(): void {
    void primary().catch(error => context?.ui.notify(error instanceof Error ? error.message : String(error), "error"));
  }

  function controls(): NativeNode {
    const available = enabled();
    const title = drafts.working ? "取消润色" : drafts.ready ? "润色已完成 · 点击应用，保留当前原稿" :
      drafts.hasPair ? "恢复原文" :
      available ? "润色提示词" : "输入提示词后润色（命令、语音录入和子代理视图除外）";
    const icon = drafts.ready ? "check" : drafts.hasPair ? "undo" : "sparkle";
    return row([
      node("row", {
        role: "omp.prompt-polish.primary", align: "center", title, aria: title,
        tone: drafts.working || drafts.ready ? "accent" : available ? undefined : "muted",
        actions: available || drafts.working ? { click: `${ACTION}primary` } : undefined,
      }, [drafts.working ? node("spinner", {}, undefined, "busy") :
        node("icon", { name: icon }, undefined, "icon")], "primary"),
    ], { role: "omp.prompt-polish", align: "center", gap: "xs" });
  }

  function watchEditorChanges(): void {
    if (!editor) return;
    const change = editor.onChange;
    editor.onChange = text => { drafts.changed(text); change?.(text); };
  }

  function install(ctx: ExtensionContext): void {
    context = ctx;
    if (ctx.mode !== "tui" || ctx.agent.kind !== "main" || !ctx.ui.supportsEditor) return;
    if (editor) return;
    const previousFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keys) => {
      // Keep the live editor's attachments, atoms, and any earlier editor extension.
      const focused = tui.getFocused();
      const target = focused instanceof CustomEditor ? focused :
        previousFactory?.(tui, theme, keys) ?? new CustomEditor(tui, theme, keys);
      editor = target;
      repaint = () => { target.invalidate(); tui.requestRender(); };
      const describe = target.describeLayout?.bind(target);
      let cached: { layout: NativeEditorLayout; control: NativeNode; result: NativeEditorLayout } | undefined;
      let controlKey = "";
      let control: NativeNode;
      target.describeLayout = (input, cx) => {
        const layout = describe?.(input, cx) ?? { role: "omp.editor", children: [input], caret: "input" };
        const key = `${enabled()}:${drafts.working}:${drafts.ready}:${drafts.hasPair}`;
        if (!control || key !== controlKey) { control = controls(); controlKey = key; }
        if (cached?.layout === layout && cached.control === control) return cached.result;
        let inserted = false;
        const children = layout.children.map(child => {
          if (!("k" in child) || child.k !== "row" || child.p?.role !== "omp.composer.bar") return child;
          const parts = [...(child.c ?? [])];
          const send = parts.findIndex(part => "k" in part &&
            (part.p?.role === "omp.composer.send" || part.p?.role === "omp.composer.stop"));
          parts.splice(send < 0 ? parts.length : send, 0, { ...control, key: "prompt-polish" });
          inserted = true;
          return { ...child, c: parts };
        });
        if (!inserted) children.push({ ...control, key: "prompt-polish" });
        const result = { ...layout, children };
        cached = { layout, control, result };
        return result;
      };
      const handle = target.handleNativeEvent.bind(target);
      target.handleNativeEvent = event => {
        if (event.type === "action" && event.act === `${ACTION}primary`) {
          run();
          return;
        }
        handle(event);
      };
      const clear = target.clearDraft.bind(target);
      target.clearDraft = historyText => { drafts.reset(); clear(historyText); };
      return target;
    });
    watchEditorChanges();
  }

  pi.setLabel("提示词润色");
  pi.on("session_start", (_event, ctx) => install(ctx));
  pi.on("session_switch", (_event, ctx) => { drafts.reset(); context = ctx; });
  pi.on("session_branch", (_event, ctx) => { drafts.reset(); context = ctx; });
  pi.on("session_tree", (_event, ctx) => { drafts.reset(); context = ctx; });
  pi.on("session_shutdown", () => drafts.reset());
  pi.on("input", () => { drafts.reset(); });
}
