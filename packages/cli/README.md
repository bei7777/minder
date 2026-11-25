# Minder CLI

Minder 是基于 Pi SDK 的本地个人助手，包含可撤销的文件修改、可审阅的 Markdown 记忆和本地行动收件箱。需要 Node.js 22.19 或更高版本。

安装发行包后运行 `minder`。向导会要求指定资料目录，并选择本机 Ollama 模型或 DeepSeek API。资料目录与 Minder 私有状态目录必须分开。Ollama 需要已安装且支持工具调用的模型；DeepSeek 可读取 `DEEPSEEK_API_KEY`。通过交互提示保存的密钥位于私有数据目录 credentials.json，采用本机文件权限保护。模型将收到对话和所调用工具返回的材料。

默认终端界面提供对话、File Diff、Undo、Memory Diff 和提醒规则。运行 `minder --help` 查看非交互命令。`minder verify` 用随机文件内容检查实际模型能否成功调用读取工具。离线配置可用 `minder init --root DIR --provider ollama --model MODEL --no-verify`，运行 `minder doctor --json` 查看已启用工具与验证状态。

`minder watch --feed URL` 负责监听资料目录、轮询订阅和投递至本地收件箱；保持该命令运行即可在聊天关闭后继续监听。`--score-model MODEL` 允许本机 Ollama 评分；未启用评分时，无明确规则的事件默认归档。`minder rules source URL 5` 将指定订阅设为立即提醒。`minder inbox` 查看卡片，`minder accept ID REV` 将当前草稿保存为已审阅并返回文字。外部发送渠道需要单独实现。

文件事务支持普通文件。基本内容和权限位可还原；特殊文件、ACL、扩展属性、目录树与外部进程直接写入不在当前可恢复范围内。推荐在用户拥有的本地资料目录运行。
