# omp-prompt-polish 快捷入口。`just --list` 查看全部。

default:
    @just --list

# 安装开发依赖（仅类型与测试）
setup:
    npm install

# TypeScript 类型检查
check:
    npm run check

# 行为测试（bun test）
test:
    npm test

# 类型检查 + 测试
verify: check test

# 预览将要发布的 npm 包内容
pack:
    npm pack --dry-run

# 开发调试：本地链接插件（改代码后新开 omp 会话生效）
link:
    omp plugin link .

# 结束调试：摘掉本地 link，改装正式 npm 包
use-package:
    omp plugin uninstall omp-prompt-polish
    omp install omp-prompt-polish

# 查看已安装插件（npm Plugins 段显示 @版本 即正式包）
list:
    omp plugin list

# 真实 UI 冒烟：新开 Tern tab 加载本仓库扩展，隔离其他插件。
# 附加参数原样传给 omp，例如：just smoke --thinking off
smoke *args:
    tern new tab --cwd "{{justfile_dir()}}" -- omp --no-session --no-extensions --no-skills \
        --no-rules --no-context-files --no-title --no-tools --no-lsp \
        -e "{{justfile_dir()}}/src/index.ts" {{args}}

# 发版：verify 通过后 bump 版本、打 tag 并推送，GitHub Actions 自动发布到 npm。
# 用法：just release 0.2.0
release VERSION: verify
    npm version {{VERSION}} --no-git-tag-version
    git add package.json
    git commit -m "chore: release v{{VERSION}}"
    git tag "v{{VERSION}}"
    git push origin main "v{{VERSION}}"
