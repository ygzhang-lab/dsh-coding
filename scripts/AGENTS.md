# scripts/AGENTS.md — 构建与隔离挂载探针

本文件只服务 `scripts/` 下的改动。构建产物表、发布步骤与跨平台说明见根 [AGENTS.md](../AGENTS.md)。

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
