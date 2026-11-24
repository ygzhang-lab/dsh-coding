# AGENTS.md — DSH Coding 编程智能体维护指南

面向智能体与维护者的通用指令与仓库入口。使用者看 [README](README.md)；为什么这样设计见 [docs/DETAIL.md](docs/DETAIL.md)。

**按目录阅读**（上游 `agent-instructions` 会在触碰对应目录文件时自动注入子文件；也可以主动读）：

- 改 `src/` 下任何代码前：先读 [src/AGENTS.md](https://github.com/ygzhang-lab/dsh-coding/blob/main/src/AGENTS.md)（DSH 契约表、约束 1-23、src 模块表、调试表）。
- 改 `test/` 前：读 [test/AGENTS.md](https://github.com/ygzhang-lab/dsh-coding/blob/main/test/AGENTS.md)（测试矩阵、验证步骤）。
- 改 `scripts/` 前：读 [scripts/AGENTS.md](https://github.com/ygzhang-lab/dsh-coding/blob/main/scripts/AGENTS.md)（构建流程与挂载调试）。

## 会话边界：一次会话只跑一个任务

一个 Coding 会话只服务一个任务；换任务请新开会话，不要在同一个会话里接着做第二个任务。

原因：`coding_handoff` 的 constraints / decisions / findings / acceptance / tasks 等列表字段只追加，只有 `goal` 与 `delivered` 会覆盖；复用会话时，上一个任务的 `acceptance` 仍会满足新任务进入 verify / deliver 的门禁，等于用旧证据放行新任务。`coding_handoff({ reset: true })` 只重置验证重试预算，不清空交接记录。

## 0. 不可违背的硬规则（速览，完整条款见 src/AGENTS.md）

1. 门禁只用 `deny`，不要改成 `ask`（审批语义）。详见 src/AGENTS.md 约束 1。
2. `tools.restrict` 裁剪与 `tools/pre-execute`/guard 拒绝必须双层并存。详见 src/AGENTS.md 约束 2。
3. 子代理白名单只写在预设组合里，不继承父级限制，也不经 `agentOptions` 传递。详见 src/AGENTS.md 约束 4。
4. 不新增自定义 Session 事件类型；新状态放进整值 checkpoint 或 `ctx.sessionProjections`。详见 src/AGENTS.md 约束 5。
5. 所有监听与注册（含客户端 `locale`/Definition）都包在 `ctx.effect` 里。详见 src/AGENTS.md 约束 6。
6. worker 路由只能是 `auto` 或显式 `provider/model`：`auto` 在派发时解析为主代理当前模型且仍过 `assertWorkerModel`；解析失败即派发失败，不得静默回退或替换成别的路由。详见 src/AGENTS.md 约束 7。

## 1. 环境与命令

- Node.js ≥ 24.9.0（`.node-version` 已锁定）
- pnpm 12+
- DSH 0.2.2-rc.5（本插件按该版本的实际契约实现，见 src/AGENTS.md 的契约表）

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # 生成 lib/*.js、lib/types/**、lib/client.js
pnpm test        # 先 build，再 node --test test/*.test.mjs
```

**测试跑的是构建产物 `lib/*.js`，不是源码。** 改完 `src/` 必须先 `pnpm build` 再跑测试，否则测的是旧代码；测试矩阵与验证步骤细节见 [test/AGENTS.md](test/AGENTS.md)。

## 2. 目录总览

- `src/` —— 插件源码（含浏览器半 `src/client/`）；src 模块表见 [src/AGENTS.md](src/AGENTS.md)。
- `test/` —— node:test 用例（跑构建产物）。
- `scripts/` —— 构建流程与挂载调试脚本。
- `docs/` —— 设计文档。
- `locale/` —— 界面文案。
- 根文件 —— `cordis.patch.yml`、`package.json`、`README.md`。

## 3. 构建产物

| 入口                  | 产物              | 说明                                                          |
| --------------------- | ----------------- | ------------------------------------------------------------- |
| `dsh-coding`          | `lib/index.js`    | Host 设置服务；同时导出 `Config` 与 `configSchema`            |
| `dsh-coding/preset`   | `lib/preset.js`   | 预设运行时                                                    |
| `dsh-coding/editor`   | `lib/editor.js`   | `apply_patch`                                                 |
| `dsh-coding/verifier` | `lib/verifier.js` | `run_verification`                                            |
| `dsh-coding/client`   | `lib/client.js`   | 浏览器模块表：`window.__ModuleLoader__.load({ id, factory })` |

宿主代码只编译、不打包，所有 `@deepseek-ai/*` 保持外部引用，运行时由 DSH 安装目录解析；客户端用 esbuild 打包为 CJS，再由脚本包一层模块表工厂，React 由宿主模块表提供。`scripts/build.mjs` 先写临时目录、全部成功后才替换 `lib/`，构建失败不会留下半成品。

## 4. 发布

```bash
pnpm typecheck && pnpm build && pnpm test
pnpm pack --dry-run   # 检查 files 是否包含 lib/locale/docs/icon/patch
pnpm publish          # prepublishOnly 会再跑一遍 typecheck/build/test
```

本地安装调试：把工作区挂进正在用的 profile（默认 `desktop`）**照 [scripts/AGENTS.md](scripts/AGENTS.md) 的「本地 profile 挂载」三步做**——`link:` 依赖 + `dsh.profile.bundles` + `node_modules` 软链；profile 配置由 HMR 监听，改完自动重组合；改 `lib/` 里的代码后要重启。`desktop` profile 被 App 独占，CLI 的 `dsh plugin --profile desktop ...` 会拒绝执行，不要在这上面绕路；也不要去逆向 `app.asar` 的安装实现。同一路径的 `link:` 不需要「先移除再安装」，重组合/重载即可换到新产物。

## 5. 跨平台注意事项

项目在 macOS 上开发，Windows 上继续维护时注意以下已实测的差异：

1. **shell 调用按平台分叉**：`src/verification.ts` 的 `shellArgv()` 在 Windows 上返回 `['cmd.exe','/d','/s','/c',command]`，其它平台返回 `['/bin/sh','-c',command]`。任何断言 `argv` 前缀的测试都必须按 `process.platform` 推导期望值，不要硬编码 `/bin/sh`。
2. **DSH 沙箱会拦截子进程管道**：在 DSH 的 `workspace-write` 文件沙箱下，`pnpm build`（esbuild）与 `pnpm test`（`node --test` 为每个测试文件起子进程）会以 `spawn EPERM` 失败，因为子进程需要管道 stdio。这不是代码缺陷：在普通终端运行，或在 DSH 中对该命令提权后运行。
3. **`src/system-language.ts` 只有 macOS 分支**：读取 `AppleLanguages` 的探测仅 macOS 生效，其它平台返回空数组并回退到宿主的 locale 解析；改语言逻辑时不要假设该模块在 Windows 有输出。
4. **路径处理一律用 `node:path`**：不要拼接 `/` 或假设大小写不敏感；测试里的固定路径字符串（如 `/tmp/fixture`）只作为传入假 provider 的不透明值。
5. 文档与代码注释使用中文，标识符、命令、报错原文保持原样。
