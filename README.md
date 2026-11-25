# Minder

Minder 使用 Pi SDK 在你选定的资料目录内工作。每次文件修改都可以查看差异和撤销，长期记忆保存为可审阅的 Markdown，重要事件进入收件箱。终端版和 macOS 桌面版使用相同的三个 Pi 扩展。

## 在 Mac 上使用

Apple 芯片 Mac 可以使用桌面版。打开 DMG，把 Minder 拖入“应用程序”，再从 Finder 打开。在设置中选择资料目录和模型即可开始对话。应用内置 Node.js。此映像使用本机 ad-hoc 签名，尚未经过 Apple 公证，下载后首次打开可能出现 Gatekeeper 提示。[下载 macOS 安装包](https://github.com/bei7777/minder/releases/download/desktop-v0.1.5/Minder-0.1.5-macos-arm64.dmg) · [桌面版使用与构建说明](desktop/README.md)

## 从便携发行包启动

终端版需要 Node.js 22.19 或更高版本。下载并解压归档，在包含 `INSTALL.md` 与 `package-lock.json` 的目录中执行以下命令。安装会从 npm 获取锁文件指定的第三方依赖，十个 Minder 包均随归档提供。[0.1.4 便携发行包](releases/minder-0.1.4.tar.gz) · [0.1.4 验收记录](releases/0.1.4.md)

```sh
npm run verify
npm ci --ignore-scripts
npx --offline minder
```

首次启动时向导会要求选择现有资料目录和模型。如果准备稍后配置模型，可以使用 `init --root <现有目录> --provider ollama --model <模型名> --no-verify`，随后进入终端工作台。配置好服务后，运行 `npx --offline minder verify` 验证一次真实的工具调用。

已有 Pi 格式的供应商配置文件时，可直接使用其中的供应商和模型标识。凭据文件应位于允许助手处理的资料目录之外。Minder 在自己的配置里保存该文件的路径。

```sh
npx --offline minder init --root "/资料目录" --provider-file "/私有目录/providers.json" --provider PROVIDER_ID --model MODEL_ID
```

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

开发依赖使用 pnpm 工作区，消费者安装已编译 npm 包。本地 tarball 验收使用回环 npm 注册表。`@minder/cli` 提供执行文件 `minder`。公有 npm 的无 scope 同名包属于其他项目，使用便携目录中的本机命令即可启动这里的 Minder。[开发计划与接口](DEVELOPMENT.md) · [安装和升级验收命令](DISTRIBUTION.md) · [CLI 使用说明](packages/cli/README.md)

```sh
pnpm lab publish-local
pnpm lab verify-release
pnpm lab test-hosts
pnpm lab demo record
```

三个仓库均采用 MIT 许可证。可单独获取 Pi 扩展、核心 API 和 DSH Bundle 的源码及宿主测试。[Pi 扩展与核心包](https://github.com/bei7777/pi-minder) · [DSH 插件](https://github.com/bei7777/dsh-plugin-minder)
