import type { ExtensionAPI, ExtensionContext, ExtensionTheme } from "@oh-my-pi/pi-coding-agent";
import { jsx, type JSXNode } from "@oh-my-pi/pi-tui";
import { Drafts } from "./drafts.ts";
import { polishDraft } from "./inference.ts";

const ACTION = "omp.prompt-polish.primary";
const WIDGET = "omp.prompt-polish";
/** Drafts omp runs itself (slash command, shell/Python, /btw side question) are not polishable. */
const MODE_SIGIL = /^\s*(?:!!?|\$\$?|\?)[ \t]?/;

interface Look {
  readonly title: string;
  readonly glyph: string;
  readonly tone?: "accent" | "muted";
  readonly busy?: boolean;
  readonly clickable: boolean;
}

export default function promptPolish(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let removeDecorator: (() => void) | undefined;
  let installed = false;
  let lastSeen: string | undefined;
  let resetQueued = false;

  const drafts = new Drafts({
    read: () => ({ text: context?.ui.getEditorText() ?? "" }),
    write: text => { context?.ui.setEditorText(text); refresh(); },
    generate: (text, signal) => {
      const ctx = context;
      if (!ctx) throw new Error("输入框尚未就绪。");
      return polishDraft(ctx, text, new Map(), signal);
    },
    repaint: () => refresh(),
    notify: (message, type) => context?.ui.notify(message, type),
  });

  function look(text: string): Look | undefined {
    if (drafts.working) return { title: "取消润色", glyph: "", busy: true, clickable: true };
    if (drafts.ready) {
      return { title: "润色已完成 · 点击应用，保留当前原稿", glyph: "✔", tone: "accent", clickable: true };
    }
    if (drafts.hasPair) return { title: "恢复原文", glyph: "↶", clickable: true };
    if (!text.trim()) return undefined;
    if (/^\s*\//.test(text) || MODE_SIGIL.test(text)) {
      return { title: "命令、Shell 输入和语音录入时不可用", glyph: "✦", tone: "muted", clickable: false };
    }
    return { title: "润色提示词", glyph: "✦", clickable: true };
  }

  async function primary(): Promise<void> {
    if (drafts.working) { drafts.cancel(); return; }
    if (!look(context?.ui.getEditorText() ?? "")?.clickable) return;
    if (drafts.ready || drafts.hasPair) drafts.applyOrRestore();
    else await drafts.polish();
  }

  function view(theme: ExtensionTheme): JSXNode {
    const state = look(context?.ui.getEditorText() ?? "");
    if (!state) return jsx("col", { hidden: true });
    const tone = state.tone;
    return jsx("row", {
      role: WIDGET,
      justify: "end",
      align: "center",
      gap: "xs",
      children: [
        jsx("row", {
          key: "primary",
          role: "omp.prompt-polish.primary",
          align: "center",
          gap: "xs",
          title: state.title,
          aria: state.title,
          tone,
          actions: state.clickable ? { click: ACTION } : undefined,
          onAction: (act: string) => {
            if (act !== ACTION) return;
            void primary().catch(error => context?.ui.notify(error instanceof Error ? error.message : String(error), "error"));
          },
          children: state.busy
            ? jsx("spinner", { key: "busy", style: "dots", tone: "accent" })
            : jsx("text", { key: "glyph", text: `   ${state.glyph}`, tone }),
        }),
      ],
    });
  }

  /** Re-set the widget so it re-reads the draft and the state machine's flags. */
  function refresh(): void {
    const ctx = context;
    if (!ctx?.ui.composer) return;
    ctx.ui.setWidget(WIDGET, (_ui, theme) => view(theme), { placement: "belowEditor" });
  }

  /** An emptied draft ends the restore pair; the decorator runs inside a paint, so defer the reset. */
  function watchDraft(text: string): void {
    if (text === lastSeen) return;
    lastSeen = text;
    if (!text.trim() && !resetQueued && (drafts.working || drafts.ready || drafts.hasPair)) {
      resetQueued = true;
      queueMicrotask(() => {
        resetQueued = false;
        if (context && !context.ui.getEditorText().trim()) drafts.reset();
      });
    }
    queueMicrotask(() => refresh());
  }

  function install(ctx: ExtensionContext): void {
    context = ctx;
    if (ctx.mode !== "tui" || ctx.agent.kind !== "main" || !ctx.ui.composer) return;
    if (installed) { refresh(); return; }
    installed = true;
    lastSeen = ctx.ui.getEditorText();
    removeDecorator = ctx.ui.composer.addDecorator(text => {
      watchDraft(text);
      return [];
    });
    refresh();
  }

  pi.setLabel("提示词润色");
  pi.on("session_start", (_event, ctx) => install(ctx));
  pi.on("session_switch", (_event, ctx) => { drafts.reset(); context = ctx; refresh(); });
  pi.on("session_branch", (_event, ctx) => { drafts.reset(); context = ctx; refresh(); });
  pi.on("session_tree", (_event, ctx) => { drafts.reset(); context = ctx; refresh(); });
  pi.on("session_shutdown", (_event, ctx) => {
    drafts.reset();
    ctx.ui.setWidget(WIDGET, undefined);
    removeDecorator?.();
    removeDecorator = undefined;
    installed = false;
    lastSeen = undefined;
  });
  pi.on("input", () => { drafts.reset(); });
}
