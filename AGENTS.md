# AGENTS.md

omp 提示词润色插件：在 Tern 的 omp 原生输入框发送按钮旁加一个星星按钮，点击润色当前未发送草稿，可取消、可恢复原文。UI 文案使用中文。

## 常用命令

```sh
npm install        # 仅安装类型与测试依赖（@oh-my-pi/pi-coding-agent 等）
npm run check      # tsc --noEmit
npm test           # bun test
```

没有构建步骤：omp 直接加载 `src/index.ts` 的 TypeScript。`@oh-my-pi/*` 运行时由 omp 宿主提供（legacy-pi-compat 重定向），本仓库只把它们作为 devDependencies/peerDependencies。

改动代码后必须新开一个 omp 会话验证；运行中的会话不会热加载扩展。

## 架构

- `src/index.ts` — TUI 集成。`ctx.ui.setEditorComponent` 挂一层工厂：优先复用当前聚焦的 `CustomEditor`（保留附件 chips、atoms、宿主接线），链式保留上一个扩展的工厂；在 `describeLayout` 返回的 `omp.composer.bar` 里、send 按钮之前插入原生按钮节点；点击经 `handleNativeEvent` 的 `action` 事件分派。`clearDraft`/`onChange` 挂钩驱动状态。
- `src/drafts.ts` — 润色状态机（working / pending / original 快照）。请求身份（AbortController 引用）+ 草稿 revision（`textRevision:atomsRevision`）防止迟到结果覆盖用户输入；润色期间草稿被改时结果进入 pending，需显式点击应用。
- `src/inference.ts` — `completeSimple` + 自建 Context（只含 system 指令与草稿），认证用 `ctx.modelRegistry.resolver(model, sessionId)`。`protectDraft` 把代码块、附件 chip、URL/路径、atom 标签替换为 `[[OMP_POLISH_N:K]]` 占位符，`restore` 严格校验数量/顺序后还原；atom 的 expansion 永不发给模型。
- `src/history.ts` — 从 `sessionManager.getLeafEntry()` 沿 `parentId` 回溯当前分支，取最近 6 条 user/已完成的 assistant 文本（总 12k / 单条 4k 字符预算，优先最新）。

## 约定

- 错误信息以 `润色失败：` 开头，`polishDraft` 会原样保留不再包装。
- 行为测试只写状态转换与边界（race、占位符完整性、预算），不 mock 模型 API 回声，不做源码结构断言。
- 恢复原文依赖自存快照（`Editor.setText` 会清 undo 历史），不要引入"切回润色稿"类缓存逻辑——按产品决定，恢复即丢弃。
- 不注册快捷键：物理键盘路径在 Tern/macOS 下不可靠（见 `LESSONS.md`），入口只有原生按钮。

## 验证

单测之外需要真实 UI 冒烟：

```sh
tern new tab --cwd <repo> -- <omp.exe> --no-session --no-extensions --no-skills \
  --no-rules --no-context-files --no-title --no-tools --no-lsp -e <repo>/src/index.ts
tern send <pane> text '草稿内容'
tern ctl tree '.sf-dock'                  # 查看输入框文本与按钮 title
tern ctl tree '[data-role="omp.prompt-polish.primary"]'
```

点击用 cua-driver 的 UIA 后台 invoke（`run_steps` + `click`），不需要前台激活。注意 `tern send keys` 注入的是 pty 输入，只能验证 omp 侧逻辑，不等价于物理键盘。
