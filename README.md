# Minder

在个人资料目录内工作，并把文件修改、长期记忆和需要关注的事件分别留给用户审阅。默认发行版集成三个独立 Pi 扩展，日常使用需要 Node.js 22.19 或以上版本。

## 从本地仓库运行

将 `pi-minder`、`dsh-plugin-minder` 和 `minder` 放在同一父目录。在 pi-minder 内运行 `pnpm install --frozen-lockfile`、`pnpm build`；在本仓运行相同两个命令。然后执行：

```sh
node packages/cli/lib/bin.js
```

指定已安装的本地模型并验证：

```sh
node packages/cli/lib/bin.js init --root ./notes --provider ollama --model qwen3:8b
node packages/cli/lib/bin.js doctor --json
node packages/cli/lib/bin.js ask "请列出这次任务的约束。"
```

使用已存在的资料目录，并将示例模型名换为本机的模型。Minder 默认将个人数据保存在 `~/.minder`；可通过 `MINDER_HOME` 指向专用目录。只使用本地功能时，可在初始化命令中加入 `--no-verify`，界面会记录模型仍待验证。

## 分发和验收

开发依赖使用 pnpm 工作区；消费者安装已编译 npm 包。本地 tarball 验收使用回环 npm 注册表，详见 [开发计划](DEVELOPMENT.md) 与 [CLI 使用说明](packages/cli/README.md)。`@minder/cli` 提供执行文件 `minder`。公有 npm 的同名无 scope 包属于其他项目，请使用本项目生成的归档或经授权发布的 scope。

```sh
pnpm lab publish-local
pnpm lab verify-release
pnpm lab test-hosts
pnpm lab demo record
```

同级两仓提供 Pi 扩展、DSH Bundle、核心 API 和实际宿主测试。开源许可为 MIT。
