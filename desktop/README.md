# Minder for macOS

[下载 Apple 芯片版 0.1.5](https://github.com/bei7777/minder/releases/download/desktop-v0.1.5/Minder-0.1.5-macos-arm64.dmg) · [安装与真实模型验收记录](../releases/desktop-0.1.5.md)

在 Apple 芯片 Mac 上打开 DMG，将 Minder 拖进“应用程序”，然后在 Finder 中双击 Minder。应用内置 Electron、Node.js、SQLite FTS5、Pi 和三个 Minder 扩展。使用者只需在设置里选择资料目录和模型。供应商配置保存在本机，支持选择已有的 Pi 供应商 JSON，也可以连接本机 Ollama。

在“设置 → 模型与目录”选择资料目录和模型，点击“保存设置”后可以直接输入任务。使用 Enter 发送，Shift + Enter 换行。再次保存同一连接会保留当前会话、输入草稿和模型验证结果。“验证模型连接”会要求模型实际读取一份临时验证文件。

“设置 → 内置能力”可以查看三个扩展并打开对应的工作记录。

| 能力 | 在 Minder 中的作用 |
| --- | --- |
| 文件快照 | 保存助手通过受管工具修改的普通文件，逐项查看差异，检查冲突并撤销一次任务的文件变更。 |
| 白盒记忆 | 将助手提议记住的事实、临时状态和会话摘要交给用户审阅，接受后以 Markdown 保存。 |
| 注意力防火墙 | 应用运行期间监听资料目录，按照优先级、冷却时间和免打扰时段分派事件，在收件箱提供可带回对话的行动草稿。 |

桌面版随附三个 Pi 扩展。DeepSeek Harness 用户可另行安装相应 DSH 插件，把相同的核心功能接到自己的 DSH 环境。[Pi 扩展](https://github.com/bei7777/pi-minder) · [DSH 插件](https://github.com/bei7777/dsh-plugin-minder)

## 从源码构建

需要 Apple 芯片 Mac、Node.js 24.9 或以上版本、npm 和可用的 macOS 签名与磁盘映像命令。检出发行版仓库，在仓库根目录执行以下命令即可构建桌面应用。

```sh
cd desktop
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
npm run package:mac
npm run test:mac
```

`package:mac` 默认读取仓库内的 `releases/minder-0.1.4.tar.gz`。桌面版 0.1.5 使用的运行时版本和归档 SHA-256 固定在 `desktop/package.json` 的 `minderRuntime` 字段中。构建器核对归档、CLI、三个核心包、三个 Pi 扩展及其锁文件，安装生产依赖后使用归档内的类型声明编译桌面代码，再用 esbuild 将前端编译为浏览器可执行的单个 ESM 文件。已有解压目录时，可以运行 `npm run package:mac -- /path/to/delivery`，构建器会把该目录与正式发行归档逐项比对。Electron ZIP 使用官方 npm 包附带的校验值。

构建成功后，`../.minder-dev/macos/latest.json` 记录相对于该目录的应用路径、DMG 路径、映像 SHA-256、签名方式和七个 npm 包的 SHA-512。每次构建拥有独立目录。macOS 验收会校验映像和完整应用签名，实际调用包内 SQLite FTS5，通过 Finder 使用的 Launch Services 启动应用，并在独立配置中操作设置页面。

## 签名

本地构建默认使用 ad-hoc 签名。使用 Developer ID Application 证书时，将证书的完整名称赋给 `MINDER_MAC_SIGN_IDENTITY`。签名方式和 Apple 公证是独立的验证步骤。当前构建脚本仅完成签名和本机验证，未提交 Apple 公证。通过浏览器下载的未公证应用可能触发 Gatekeeper 提示。分发方可在发布前使用自己的 Apple 开发者账号完成公证并将票据装订到映像，然后重新计算发布文件的 SHA-256。

## 来源与许可证

Minder 的桌面代码与 Finder 图标采用仓库根目录的 MIT 许可证。窗口与 Pi 宿主的职责划分参考了 PI-Desktop 的 Electron 主进程、preload 和 Pi Host。0.1.5 的界面也参考了该项目的侧栏主导航和底部设置入口、按主题切换的设置区、输入框与发送控件的组合，以及分开渲染对话正文和工具活动的做法。Minder 的交互、样式和图标独立实现。参考版本采用 LGPL-3.0。[PI-Desktop 固定提交](https://github.com/vastsa/PI-Desktop/tree/649c3456af65d6a105c750a94e57b272d4cf77e9) · [侧栏组件](https://github.com/vastsa/PI-Desktop/blob/649c3456af65d6a105c750a94e57b272d4cf77e9/apps/desktop/src/components/SidebarNavigation.tsx) · [设置页](https://github.com/vastsa/PI-Desktop/blob/649c3456af65d6a105c750a94e57b272d4cf77e9/apps/desktop/src/features/settings/SettingsPage.tsx) · [输入框](https://github.com/vastsa/PI-Desktop/blob/649c3456af65d6a105c750a94e57b272d4cf77e9/apps/desktop/src/components/Composer.tsx) · [对话正文](https://github.com/vastsa/PI-Desktop/blob/649c3456af65d6a105c750a94e57b272d4cf77e9/apps/desktop/src/features/chat/transcript/TranscriptProse.tsx)

Electron 采用 MIT 许可证，内含 Chromium 及其他项目的声明。应用在 `Contents/Resources/app/third-party/` 保留 Electron 的许可证及 `LICENSES.chromium.html`，并随生产依赖保留各 npm 包附带的许可证。应用图标源文件为 `assets/icon.svg`，构建时使用 resvg 和 macOS 的 `iconutil` 生成 Finder 图标。

Markdown 显示使用 Marked 18.0.11 和 DOMPurify 3.5.0。应用将这两个包随前端代码分发，分别在 `third-party/marked-LICENSE.txt` 保留 Marked 的 MIT 许可证及版权声明，在 `third-party/dompurify-LICENSE.txt` 保留 DOMPurify 的 Apache-2.0 许可证。两份文件分别来自上述版本随附的 `LICENSE`。
