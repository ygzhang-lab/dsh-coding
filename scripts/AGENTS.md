# scripts/AGENTS.md — 构建与隔离挂载探针

本文件只服务 `scripts/` 下的改动。构建产物表、发布步骤与跨平台说明见根 [AGENTS.md](../AGENTS.md)。

## scripts/ 的目标与成功标准

这个目录只服务两件事：一是让构建产物可复现（`pnpm build` 每次都从 `src/` 生成同一份 `lib/`），二是让本地挂载与隔离探针不碰用户 profile，并且结论别人能照着命令重跑出来。

成功标准：探针只在临时 `DSH_HOME` 里跑并把关键事实打印出来，挂载步骤逐字可复制，改动生效规则写得能直接判断「要不要重启」。

违反这条会把用户的开发环境搞坏：去逆向 `app.asar` 的安装流程，或拿真实的 `desktop` profile 再起一个 Host，会和正在运行的 App 共用同一份 profile 的存储与文件锁，轻则插件加载到旧产物，重则 profile 写坏。所以下面每个命令都写清它动的是哪个目录。

## 隔离挂载探针

`scripts/mount-probe.mjs` 在临时 `DSH_HOME` 下创建 `base + dsh-coding` 的探测 profile，启动真实 Host，读取预设花名册并像会话控制器一样 `mount` Coding 预设，打印可见工具与 `settings.describe()` 命名空间；不动用户 profile。

以下为 macOS 写法，Windows 把路径换成 `D:\...` 形式（`ln -sfn` 用目录联接或直接复制）：

```bash
H=/tmp/dsh-probe-home && rm -rf "$H" && mkdir -p "$H/profiles/probe/node_modules"
cat > "$H/profiles/probe/package.json" <<'JSON'
{ "name": "dsh-profile-probe", "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-coding"] } },
  "dependencies": { "dsh-coding": "link:/绝对路径/dsh-coding" } }
JSON
printf '[]\n' > "$H/profiles/probe/cordis.yml"
printf '[]\n' > "$H/profiles/probe/cordis.patch.yml"
ln -sfn /绝对路径/dsh-coding "$H/profiles/probe/node_modules/dsh-coding"

DSH_HOME="$H" ELECTRON_RUN_AS_NODE=1 \
  DSH_INSTALL_DIR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh" \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" scripts/mount-probe.mjs
```

探针额外打印三项关键事实：`prompt context coding:language`（语言提示段）、`projection dshCodingStage`（卡片数据源是否注册）、`after agent-preset/selected`（选中 Coding 后投影是否 `active: true`）。

## 本地插件开发 profile 挂载（开发用）

1. 检查 DSH 正在使用的 profile（默认 `desktop`），如果已安装 NPM 版本的 DSH Coding 插件，就先把他卸载。
2. 检查 DSH 正在使用的 profile（默认 `desktop`），如果已通过 link 方式挂载此插件项目，就忽略下方的操作（无需重复挂载）。否则就把工作区挂载进正在使用的 profile（默认 `desktop`），`link:` 直接读本仓库产物，改完不重装。**照下面三步做，不要去逆向 `app.asar` 的安装流程、不要读整个 `node_modules`、不要用真实 `desktop` profile 再起一个 Host**（会和正在运行的 App 共用同一份 profile 的存储与文件锁）。

前置：项目侧依赖与产物就位（`lib/` 是构建产物，缺了挂上也起不来）。

```bash
cd /绝对路径/dsh-coding && pnpm install --prefer-offline && pnpm build
```

`desktop` profile 由 Electron App 独占，`dsh plugin --profile desktop ...` 会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`），所以要么走 GUI「插件 → 添加插件」填绝对路径，要么按等价的三步改文件：

```bash
P="$HOME/.dsh/profiles/desktop"
B="$P/.backup-mount-$(date +%Y%m%d-%H%M%S)" && mkdir -p "$B" && cp "$P"/{package.json,pnpm-lock.yaml,cordis.patch.yml} "$B"/
cd "$P" && pnpm add "link:/绝对路径/dsh-coding"          # 1. 依赖 + node_modules 软链 + lockfile
node -e 'const fs=require("fs"),m=JSON.parse(fs.readFileSync("package.json","utf8"));const b=m.dsh.profile.bundles;if(!b.includes("dsh-coding"))b.push("dsh-coding");fs.writeFileSync("package.json",JSON.stringify(m,null,2)+"\n")'  # 2. 选中 bundle（幂等）
[ -L "$P/node_modules/dsh-plugin-coding" ] && [ ! -e "$P/node_modules/dsh-plugin-coding" ] && rm "$P/node_modules/dsh-plugin-coding"  # 3. 只删「悬空」的旧软链
```

要点：

- 三处必须同时成立：`dependencies` 里的 `link:` 绝对值、`dsh.profile.bundles` 里的名字、`node_modules/dsh-coding` 软链。只改其一不会挂载。
- `cordis.patch.yml` 不用动：bundle 自带 `- id: dsh-coding` 的默认行，GUI 里保存配置才会写入。
- `pnpm add` 会警告 link 依赖的 peerDependencies 不由 profile 解析，属正常：本项目自带 `@deepseek-ai/*` 开发依赖。
- 写 profile 在会话工作区之外，DSH 沙箱会拒绝；需要对该命令提权（`danger-full-access`）。
- 顺手验证：跑上面「隔离挂载探针」那一节，它证明 link 后的产物能真实挂载，且不碰用户 profile。
- **生效规则**（隔离 Host 实测 + `dsh-hmr` 代码）：
  - 增删 bundle、改配置：`package.json` 与 `cordis.patch.yml` 被单独 `watchConfig`，改动触发 `reconcileProfile`（重读各 bundle 层）。实测：给运行中的 Host 加 bundle 后调 reconcile，`dsh-coding` 与 5 个 `preset-dsh-coding*` 条目直接起来，`restartReason` 为空——**不用重启**。
  - 改 `src/` → `pnpm build`：`hmr` 在 base bundle 里配的是 `root: []`，不监听文件，**不会自动生效，重启 DSH**（README 对「卸载/更新」也是同一条）。
  - 兜底：改完没生效就重启 DSH，别在「为什么不刷新」上耗时间。
- 回滚：删掉 `dependencies` 与 `bundles` 里的那两行，或还原备份目录。
