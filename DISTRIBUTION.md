# 本地分发与跨平台验收

将三个独立仓库按 `pi-minder/`、`dsh-plugin-minder/`、`minder/` 并排检出。开发机使用 Node.js 24.9 或更新版本和 pnpm 10.15.0；先在每个仓库执行 `pnpm install --frozen-lockfile`。以下命令在 `minder/` 运行。

| 命令 | 实际执行的检查 |
| --- | --- |
| `pnpm lab publish-local` | 构建核心、适配器及发行版。使用 pnpm 打包，检查归档中的 JS、许可证和 DSH 补丁，再通过本机 Verdaccio 发布。每个包按 SHA-512 验证。 |
| `pnpm lab publish-local @minder/core-snapshot pi-minder-snapshot dsh-plugin-minder-snapshot` | 仅归档指定包，用于单独研究 snapshot 的发包流程。运行整体验收前须恢复完整清单。 |
| `pnpm lab test-install` | 在干净目录通过 npm 安装 CLI，调用 npm 生成的启动命令，并核对 lockfile 中各个 Minder 依赖的完整性摘要。 |
| `pnpm lab test-hosts` | 以当地注册表中安装的 Pi 扩展和真实 Pi SDK 执行宿主测试；调用 DSH 仓库的 `test:installed` 命令使用独立宿主配置加载正式包。 |
| `pnpm lab test-init` | 以全新的资料目录和个人配置运行 CLI 初始化、检查所选模型和三组实际工具。离线流程将模型连接保存为待验证。 |
| `pnpm lab demo record` | 全新安装 CLI，以真实项目文档完成 File Diff 和 Undo，审阅并检索 Markdown 记忆，从本机 Atom 订阅接收行动卡。记录文件为本次运行目录的 `home/minder.cast` 和 `home/demo.json`。 |
| `pnpm lab verify-release` | 在同一个全新 npm 安装目录连续执行安装、初始化与演示验收。 |
| `pnpm lab kit`、`pnpm lab test-kit` | 生成十个 tarball 的便携目录，搬到独立目录验证 SHA-512，只用普通 npm 安装并执行 CLI。成功后将第三方依赖锁文件写回 `.minder-dev/delivery/`。 |
| `pnpm lab test-upgrade <上次发布清单的绝对路径>` | 先安装上次正式产物，生成配置、文件事务和待审记忆，再升级并验证可读、可审阅和可撤销。也接受依赖已在本机注册表中的旧版 CLI 压缩包。首次发布没有升级基线。 |
| `pnpm lab run -- --help` | 在独立安装目录执行 CLI 及传入参数。各次 run 共用 `.minder-dev/distribution/user/` 中的配置和资料，可连续执行初始化、对话和审阅。 |
| `pnpm exec node tests/distribution/quiet-rate.mjs` | 监听实际 TypeScript 编译写入的文件，并接收一条显式要求提醒的发行公告。分别计算普通构建活动的静默率和高优公告的投递率，逐项证据保存在本地运行目录。执行期间保持同一包的其他构建暂停。 |

包清单写入 `.minder-dev/distribution/release.json`，包含版本、SHA-512、归档绝对路径、源码提交、工作区是否有待提交更改和打包环境。每组产物拥有独立注册表存储。发布候选版本时，从干净的固定提交构建，并同时保留发布清单及其指向的压缩包，供下一次升级验收使用。私有注册表登录信息和个人测试配置留在本机。

本机注册表绑定动态分配的回环端口，进程随命令退出。Minder 包只能发布到该回环地址。第三方依赖通过 pnpm 已配置的 HTTPS 注册表获取，也可以通过 `MINDER_LAB_UPLINK` 设置公开镜像。安装运行时禁用依赖安装脚本，检查平台用户从编译产物启动的能力。真实模型验证可在具备 Ollama 或获授权的 API Key 的机器上用安装后的 `minder verify` 执行。

跨仓库 CI 由仓库所有者通过 Actions 手工指定另外两个仓库及提交启动。矩阵实际执行 macOS、Linux 和 Windows 签出、编译、核心测试、注册表安装、演示与宿主加载。本机 WSL 验收另需在 WSL 原生文件系统和 `/mnt/c` 的独立工作区分别执行三仓库构建和测试，核对 Windows 占用文件、junction 和跨卷复制结果。工作流和验收命令描述待执行的检查；通过状态应取自实际作业结果。
