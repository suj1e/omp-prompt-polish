# AGENTS.md

omp 提示词润色插件：在 Tern 的 omp 输入框下方挂一个星形润色按钮，点击润色当前未发送草稿，可取消、可恢复原文。UI 文案使用中文。

## 常用命令

优先用 `just`（配方见 `justfile`）：`just verify`（check+test）、`just pack`、`just link` / `just use-package`（开发 link 与正式包切换）、`just smoke`（真实 UI 冒烟）、`just release X.Y.Z`（发版：bump+tag+push，CI 自动 npm publish）。


```sh
npm install        # 仅安装类型与测试依赖（@oh-my-pi/pi-coding-agent 等）
npm run check      # tsc --noEmit
npm test           # bun test
```

没有构建步骤：omp 直接加载 `src/index.ts` 的 TypeScript。`@oh-my-pi/*` 运行时由 omp 宿主提供（legacy-pi-compat 重定向），本仓库只把它们作为 devDependencies/peerDependencies。

改动代码后必须新开一个 omp 会话验证；运行中的会话不会热加载扩展。

## 开发与发布循环

```sh
omp plugin link .                    # 开发调试：本地 link，改代码后新开会话即生效
omp plugin uninstall omp-prompt-polish   # 结束调试：摘掉本地 link（uninstall 同时适用于 link 与 npm 安装）
omp install omp-prompt-polish        # 日常使用/发布后验证：装正式 npm 包
```

发版：改 `package.json` 版本 → push main → `git tag vX.Y.Z && git push origin vX.Y.Z`，GitHub Actions 自动跑 check+test 后 `npm publish --provenance`。注意新包名首个版本会先进 npm 的 staged review（registry 上短暂出现 `0.0.0-stage` 占位），审核通过后真实版本才可见。

本地 link 与 npm 安装同名冲突时，`omp install` 会被已存在的 link 挡住；先 `omp plugin uninstall` 再装。判断当前装的是哪种：`omp plugin list` 里 npm Plugins 段显示 `omp-prompt-polish@版本` 即正式包。

## 架构

- `src/index.ts` — TUI 集成。omp 19 移除了 `setEditorComponent`/`handleNativeEvent`，composer 工具栏不再有扩展插入点；改为 `ctx.ui.setWidget(key, factory, { placement: "belowEditor" })` 在输入框下方画一行按钮。节点用 `@oh-my-pi/pi-tui` 的 `jsx()` 构建，`actions.click` + `onAction` 收点击；`composer.addDecorator` 观察草稿编辑（空草稿结束恢复对），每次状态变化或文本变化后用 `setWidget` 重设同一 key 触发重绘。
- `src/drafts.ts` — 润色状态机（working / pending / original 快照）。请求身份（AbortController 引用）+ 草稿文本快照防止迟到结果覆盖用户输入；润色期间草稿被改成不同文本时结果进入 pending，需显式点击应用（19 不再暴露 revision，改回原文相同文本会直接应用）。
- `src/inference.ts` — `completeSimple` + 自建 Context（只含 system 指令与草稿），认证用 `ctx.modelRegistry.resolver(model, sessionId)`。`protectDraft` 把代码块、附件 chip（`[Image #N]`/`📄 #N` 等标记）、URL/路径替换为 `[[OMP_POLISH_N:K]]` 占位符，`restore` 严格校验数量/顺序后还原；chip 的 expansion 永不发给模型。
- `src/history.ts` — 从 `sessionManager.getLeafEntry()` 沿 `parentId` 回溯当前分支，取最近 6 条 user/已完成的 assistant 文本（总 12k / 单条 4k 字符预算，优先最新）。

## 约定

- 错误信息以 `润色失败：` 开头，`polishDraft` 会原样保留不再包装。
- 行为测试只写状态转换与边界（race、占位符完整性、预算），不 mock 模型 API 回声，不做源码结构断言。
- 恢复原文依赖自存快照（`Editor.setText` 会清 undo 历史），不要引入"切回润色稿"类缓存逻辑——按产品决定，恢复即丢弃。
- 不注册快捷键：物理键盘路径在 Tern/macOS 下不可靠（见 `LESSONS.md`），入口只有输入框下方的原生按钮。

## 验证

单测之外需要真实 UI 冒烟：

```sh
tern new tab --cwd <repo> -- <omp.exe> --no-session --no-extensions --no-skills \
  --no-rules --no-context-files --no-title --no-lsp -e <repo>/src/index.ts   # 调试指定版本（omp 19 起 --no-tools 会禁用扩展，不能与 -e 同用）
# 或不带 -e（验证发布包路径，插件自动发现）
tern send <pane> text '草稿内容'
tern ctl tree '.sf-dock'                  # 查看输入框文本与按钮 title
tern ctl tree '[data-role="omp.prompt-polish.primary"]'
```

点击用 cua-driver 的 UIA 后台 invoke（`run_steps` + `click`），不需要前台激活。注意 `tern send keys` 注入的是 pty 输入，只能验证 omp 侧逻辑，不等价于物理键盘。
