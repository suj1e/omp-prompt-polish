# LESSONS.md

开发 omp 插件（Tern 原生 UI 集成）过程中踩过的坑，按主题记录。原因写清楚，避免下次重查源码。

## Tern 原生输入框集成

- **想往 composer 工具栏加按钮，没有现成扩展点。** `ctx.ui.setWidget` 只能渲染在输入框上方/下方占一整行；`registerComposerShape` 只是外观布局。可行路径是 `ctx.ui.setEditorComponent` 挂自定义编辑器工厂，在 `CustomEditor.describeLayout` 返回的布局里找到 `role: "omp.composer.bar"` 的 row，把按钮节点插到 `omp.composer.send` 之前；点击以 `handleNativeEvent` 收到 `{type:"action", act}` 结束。v18.13.1 源码 `packages/tui/src/prompt/custom-editor.ts` 的 `describeLayout` 是权威。
- **编辑器工厂必须复用当前编辑器，不能 new。** `setEditorComponent` 换编辑器时宿主只保留文本（`setText(previousText)`），附件 chips、atoms、各种宿主接线都会丢。工厂里先 `tui.getFocused()`，是 `CustomEditor` 就直接用；同时用 `ctx.ui.getEditorComponent()` 链式保留上一个扩展的工厂，避免覆盖别人的编辑器。
- **`onChange` 要在工厂返回之后再挂。** 宿主在 `setEditorComponent` 内部同步调用工厂并做一系列接线，工厂内挂的钩子可能被后续赋值覆盖；`install()` 里工厂调用完、拿到 `editor` 引用后再包装 `onChange` 最稳。
- **spinner 带 label 会在界面渲染出一行文字。** 原生 `spinner` 节点的 `label` 是可见文案不是无障碍标签，做纯图标进度时不要传。
- **扩展只在会话启动时加载。** 改完代码必须新开 omp 会话；`--no-extensions` 只关自动发现，`-e` 显式路径仍然生效。

## 草稿与附件

- **`Editor.setText` 会清空 undo 历史。** "恢复原文"必须自己存快照；依赖 Ctrl+Z 一定丢。也正因此，润色写回后用户没法用撤销回到润色前，快照是唯一途径。
- **附件在草稿里是原子 chip token（`atoms: label → expansion`）。** 直接把草稿文本发给模型，模型改写或移动 token 就会丢附件；expansion（文件内容、base64）更不能发。做法：label 替换为 `[[OMP_POLISH_N:K]]` 占位符，回复严格校验"每个占位符恰好出现一次且顺序一致"后再还原，任何丢失/重复/篡改直接拒绝写回。草稿里用户自己写了同形占位符也要兼容（namespace 递增）。
- **并发保护用两个身份。** 请求身份：`AbortController` 引用相等，防取消/重置后迟到结果落地。草稿身份：`textRevision:atomsRevision` 组合，润色期间用户改过草稿就不直接覆盖，转 pending 等用户显式应用（应用时当前最新草稿保存为可恢复原文）。

## 模型调用

- **`ctx.runEphemeralTurn` 不适合纯改写。** 它带主会话上下文与 provider hooks、默认去重并截断回复到 4 KiB；`tools:false` 在 Cursor 上还会被拒。独立 `completeSimple(model, context, {apiKey: ctx.modelRegistry.resolver(model, sessionId), toolChoice:"none"})` + 自建 Context 更可控。
- **认证不要自己读 key。** `ctx.modelRegistry.resolver(model, sessionId)` 返回 resolver，走 omp 的 OAuth 刷新/轮换策略；裸 `getApiKey` 拿到的是一次性字符串。
- **给润色单独的 provider lineage。** `sessionId: "prompt-polish:"+uuid` 避免和主会话共享 provider 状态。

## 快捷键（已移除）

- **`tern send <pane> keys ctrl+alt+p` 能触发，不代表物理键盘能触发。** 它注入的是 pty 输入，只验证了 omp 侧 `registerShortcut` 的逻辑；用户实测物理按键不通——Tern 自己的 keymap 层（defaults/preset/user 层叠加）完全可能在按键到达 pty 之前消费掉 `ctrl+alt+p`，macOS 上 Alt 还是 Option 字符输入。教训：**快捷键必须用真实键盘路径验证（cua-driver `hotkey` 或人工），pty 注入只能验证程序侧。** 按用户决定已整体移除快捷键，入口只留原生按钮。

## 测试与工具链

- **`tern capture <pane> --surfaces` 是看 omp 启动报错的最快方式。** 一次启动把 `--json` 误传给了 omp，`tern ls` 只看到 exited:1，capture 直接给出原始报错。
- **`tern focus <pane>` 文档说聚焦，实测没切到目标 tab；`tern ctl tab <N>` 才可靠。** 用 UIA 自动化（cua-driver）时还要注意 `run_steps` 的 observe 是对窗口的 diff，切 tab 后旧的 since 基线会失效。
- **cua-driver 的 UIA 后台 invoke 对 Tern 原生 surface 按钮有效**，不需要前台激活窗口；`get_window_state` 的 `query` 过滤 + `element_token` 点击足够做端到端冒烟。
- **npm 上的 `@oh-my-pi/pi-coding-agent` 只是类型/开发依赖。** omp 二进制运行时用自己捆绑的同名模块，扩展里的 `@oh-my-pi/*` 导入会被 legacy-pi-compat 重定向到宿主实例，不会因为本地 node_modules 版本细微差异跑出双份模块；peerDependencies 声明 `>=18.13.1 <19` 即可。
- **Windows 用户 PATH 持久化后当前 shell 不继承。** `setx`/`SetEnvironmentVariable` 只影响新进程；已在跑的会话要子进程里重读 `[Environment]::GetEnvironmentVariable("Path","User")` 拼回 `PATH`。

## 发布（npm）

- **npm 新包名首个版本会进 staged review。** `npm publish` 立即 exit 0，但 registry 上先只出现 `0.0.0-stage` 占位包（README 写着 "awaiting a staged release"），maintainer 已是自己账号；审核通过后（本次约 2 分钟）真实版本才出现且 latest 指向它。不要看到占位包就误判成被抢注。
- **omp 的插件子命令是 `uninstall`，没有 `unlink`。** `unlink` 是 Tern 的（`tern plugin unlink`），两边记混会白跑一趟。本地 link 与 npm 安装同名时 `omp install` 会被挡，先 `omp plugin uninstall <name>` 再装。
- **工作流：调试 `omp plugin link .`，交付后切回正式包**（uninstall link → `omp install omp-prompt-polish`），避免长期挂本地 link 测不到用户真实安装路径。验证发布包要开不带 `-e` 的 omp 会话，让插件自动发现加载。

## 产品迭代（用户反馈）

- 处理中不要显示文字说明，只留转圈图标（title 提示保留"取消润色"）。
- "恢复原文"即用户不满意，丢弃本次润色结果，按钮回到星星；不做"切回润色稿"缓存——那是初版过度设计，用户撤回时并不想再见到旧结果。
- 入口越少越好：一个按钮（+一度做过的小箭头选项菜单、差异面板、第二个快捷键，最终全部移除）。差异查看功能随之删除。
