# 本地分发与跨平台验收

将三个独立仓库按 `pi-minder/`、`dsh-plugin-minder/`、`minder/` 并排检出。开发机使用 Node.js 24.9 或更新版本和 pnpm 10.15.0；先在每个仓库执行 `pnpm install --frozen-lockfile`。以下命令在 `minder/` 运行。

| 命令 | 实际执行的检查 |
| --- | --- |
| `pnpm lab publish-local` | 构建核心、适配器及发行版。使用 pnpm 打包，检查归档中的 JS、许可证和 DSH 补丁，再通过本机 Verdaccio 发布。每个包按 SHA-512 验证。 |
| `pnpm lab publish-local --reuse <上次完整发布清单> @minder/cli` | 只构建升级版本的 CLI。从历史清单取出另外九个归档，逐一核对原始 SHA-512，再发布完整组合。 |
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
| `node tests/distribution/provider.mjs [已安装的 npm 项目目录] [--memory]` | 使用指定服务验证真实模型能否读取随机文件、调用受管写入工具、产生文件差异及按字节撤销。加入 `--memory` 会检查模型提出的一条待审记忆。 |

模型验收由操作者单独启动。设置 `MINDER_TEST_PROVIDER_FILE`、`MINDER_TEST_PROVIDER`、`MINDER_TEST_MODEL`，分别指向本机服务配置文件、服务标识和模型标识。配置缺失时命令返回非零。省略项目目录时，脚本使用当前发行版已通过 `pnpm lab test-kit` 验收的独立安装。运行前确认该服务可接收测试文本并可能按请求计费。脚本使用专用测试文件，检查请求体中的本机路径和认证头中的凭据是否泄漏。运行结束时清理测试资料，在 `.minder-dev/provider-check/run-*/evidence.json` 保存版本、成功调用的工具、请求次数和断言结果。

包清单写入 `.minder-dev/distribution/release.json`，包含版本、SHA-512、归档绝对路径、源码提交、工作区是否有待提交更改和打包环境。每组产物拥有独立注册表存储。发布候选版本时，从干净的固定提交构建，并同时保留发布清单及其指向的压缩包，供下一次升级验收使用。私有注册表登录信息和个人测试配置留在本机。

本机验收使用动态分配的回环端口，注册表进程随命令退出。第三方依赖通过 pnpm 配置的 HTTPS 注册表获取，也可以通过 `MINDER_LAB_UPLINK` 选择公开镜像。安装过程禁用依赖安装脚本。使用 Ollama 或获授权的模型配置时，可以用安装后的 `minder verify` 验证真实工具调用。

## 准备 npm 发布

从完整便携目录执行 `node scripts/public-pack.mjs .minder-dev/delivery`，输出目录中包含十个 npm 压缩包和一份 `packages.json`。公开包使用发布者的名称空间。CLI 名称为 `@bei7777/minder-cli`，三个核心包使用 `@bei7777/minder-core-snapshot`、`@bei7777/minder-core-memory` 和 `@bei7777/minder-core-firewall`。Pi 扩展与 DSH 插件保留独立名称。打包命令核对便携包的 SHA-512，更新公开包名称及 npm 依赖别名，并在重新解压后逐个比对文件。

执行 `pnpm lab test-public <输出目录>/packages.json`，通过本机注册表安装这批公开名称的压缩包，检查 CLI、三个 Pi 单独安装和三个 DSH 单独安装。发布者使用已启用双因素认证的 npm 账号，在官方注册表依次发布核心包、宿主扩展和 CLI。公开发布后须从官方注册表核对各版本的 `dist.integrity`，再从两个宿主执行安装和加载，另行确认目录搜索结果。

跨仓库 CI 通过 Actions 手工指定 Pi 和 DSH 仓库及完整提交编号。macOS、Linux、Windows 原生作业分别执行编译、核心测试、注册表安装、便携包验收、升级和宿主加载。第四个作业在 Windows runner 启动真正的 WSL2，检查 Linux 工作目录为 ext4、Windows 挂载卷为 9p 或 drvfs；它在两个卷上分别验证旧数据升级，另行执行跨卷快照和恢复。工作流见 [.github/workflows/distribution.yml](.github/workflows/distribution.yml)，已执行的版本和结果见 [0.1.4 验收记录](releases/0.1.4.md)。
