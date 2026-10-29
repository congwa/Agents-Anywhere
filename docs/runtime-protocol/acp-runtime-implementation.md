# ACP Runtime 实现记录

记录日期：2026-10-29。当前工作树为 `Agents-Anywhere-acp-agent-composition`，分支为 `feat/con+be/acp-agent-composition`。基于上游 `e5c0179d`，参考分支 `feat/con+be/pi-runtime` 的源码提交 `b8575565` 以 `d6e5f5a5` 整体移入；没有搬入原工作树中未提交的 `tests/` 改动。产品版本不变。

## 本轮源码实现

- Web、Electron、Android、iOS 的准备、异步创建、初始化交互、结构化表单与按账号隔离的恢复引用直接复用参考分支源码。
- `AcpAgentApplication` 只依赖 `AgentCapabilityPort`；生命周期、配置、消息、命令和回执经统一端口调用，不导入 Pi 或 OpenMA SDK。
- `PiCapabilities` 组合 OpenMA 的提示转换、历史回放、工具分类、命令目录及语法，与 AA 的工作区信任、持久接纳回执、工具审批、最终请求守卫和原生写锁。
- 会话配置在四端复用已有结构化表单；Web/Electron 使用同一份弹窗源码，Android 和 iOS 通过既有设置入口打开。Server 保留配置读取／更新能力，配置读取不要求取得会话写控制。
- 已创建会话的附件路径接入 ACP：图片作为图片块，文件先校验再提供本机内容路径；命令复用现有四端命令界面。准备式创建的首条附件仍未接入，Web/Electron 明确保留附件草稿。
- 能力随绑定状态进入持久 outbox；四端按有效能力决定入口，不按 Pi 或 DSH 名称分支。

按用户最新要求，本轮只搬移和修改源码，不运行编译、测试、探针或其他校验。下方历史表格记录参考工作树较早阶段的情况，不代表当前分支的校验结果；当前已实现部分以上述源码说明为准。

## 迁移前的阶段记录

以下是参考工作树早期的阶段记录。当前源码已改为组合适配结构；Pi Profile 的组件门禁为 `pi_acp_release_acceptance_pending`，安装并选中符合要求的签名组件后由 `AcpProvider` 装配运行。正式发布源、公钥与跨平台组件发行仍未配置。

| 范围 | 已实现 | 后续仍需实现或验证 |
| --- | --- | --- |
| 领域边界 | Profile、绑定、准备、创建、消息、交互、配置、历史准入、组件模型分层 | 用实际新增 Agent 检验 Profile 扩展边界 |
| ACP 传输 | 官方 Python SDK `agent-client-protocol==0.12.1`，stdio v1，初始化权限与表单，配置更新 | Pi 增强回执、命名空间服务端；v2 保持关闭 |
| 准备与创建 | 会话式准备接管、预留、过期关闭、初始化回答与取消、确定失败／未知分别保存 | Pi 无会话预检和资源信任实现 |
| 消息 | 稳定 ID、输入摘要冲突、v1 完成接纳证据、未知不自动重投 | 增强早期 ACK 与重启后的 Agent 回执查询 |
| 执行与关闭 | 会话独立进程、并发配额、异常退出收敛、关闭前本地排队请求拒绝 | 实际 Pi 写锁、恢复位置及关闭验收 |
| 交互 | 持久化、版本／代际、重复回答幂等、受限表单、关闭失效 | 原生第三方 TUI 请求适配、认证与子 Agent 结构化控制 |
| 配置 | 完整快照、内容摘要、单调 revision、部分成功保留真实状态 | Pi 最终模型／推理强度／端点守卫；会话设置完整 UI |
| 同步 | SQLite 事务 outbox、有序重试、ACK 后删除、文本／思考／工具投影、最终条目保留身份 | 完整来源回放替换的 Server 持久化用例、计划与用量投影、只读原生发现 |
| 恢复 | 重启阻塞旧执行者、失效交互、保存接纳或未知事实、禁止未知消息重投 | 重新连接实际 Agent、核验历史与配置后恢复写入、分支 token |
| 附件与高级操作 | 未实现能力明确拒绝，不丢弃附件 | 附件转换、MCP、steer、排队、原生命令及身份切换 |
| 组件 | 签名清单、受信源端口、不可变安装、激活、回退、会话引用保护、可重复打包 | 正式公钥／发布源、六目标真实组件、升级策略 UI、操作引用清理、共享数据迁移 |
| 三平台 | POSIX 监督进程组；Windows 挂起启动、Job 分配后恢复；跨平台 CI 探针任务 | Linux/Windows 实际执行结果和六架构产物；Windows 原生锁与复杂路径验收 |
| 四端 | 创建通用配置、结构化表单、配置与组件 API 客户端 | 组件管理可见页面、完整会话配置页面与四端业务验收 |

来源替换契约是预留的独立契约，当前没有发布对应事件，不代表 Server 已经支持来源删除或完整替换。当前本地历史快照明确为 partial，不把缓存当作完整原生历史。

## 关键实现路径

- Connector：`connector/connector/runtimes/acp/`；既有 Runtime 协议新增配置端口，`RuntimeInstance` 显式转发，分发器支持配置与组件路由。
- 契约：新增 `contracts/acp-runtime/1.0`、`contracts/runtime-workflows/1.2`；保留旧 1.1 文件。工作流 schema 由 Server 导出，ACP schema 由 Connector 导出，避免双重生成源。
- Server：`core/agent_components.py`、`core/runtime_workflows.py`、`services/runtime_workflows.py`、`api/runtime_workflows.py`、`api/connector_runtimes.py`。本次 ACP 增量使用已有操作 JSON 存储，没有新增数据库 schema。
- Web/Electron：`runtime-forms.ts`、`structured-agent-fields.tsx`、创建工作流面板与 composer；表单使用现有组件库，JSON Schema 校验保留类型，空 enum 值用 UI 索引映射。
- Android：`AgentForm.kt`、`StructuredAgentFields.kt`、创建／会话交互入口、`RuntimeWorkflowApi`。
- iOS：`AgentForm.swift`、`StructuredAgentFields.swift`、创建／会话交互入口、`V2RuntimeWorkflowAPI`。

## 可复现的直接检查

Connector 目录：

```sh
uv run ruff check connector/runtimes/acp scripts/*acp*.py
uv run python scripts/verify-acp-runtime.py
uv run python scripts/verify-acp-processes.py
uv run python scripts/verify-acp-components.py
uv run python scripts/verify-acp-packaging.py
uv run pytest -q
```

Server 路由边界探针（受控 service ports，不冒充真实数据库业务链路）：

```sh
cd server
PYTHONPATH=. uv run python scripts/verify_acp_api.py
```

| 检查 | 本机观察结果 |
| --- | --- |
| 官方 SDK → 受控 Peer → SQLite/outbox | 初始化回答、工具权限、结构化表单、流式更新、重复提交、ACK 保留和异常退出通过；没有真实模型请求 |
| 组件与打包 | 临时 Ed25519 签名、篡改拒绝、不可变安装、激活／回退、会话固定旧组件及引用保护通过；两次打包字节一致；临时私钥未进入组件 |
| macOS arm64 进程 | 主动关闭及父进程被杀后，Agent 与后代进程均退出 |
| HTTP 路由 | 设备授权拒绝不转发 RPC；配置 false／空字符串保留；数字冒充布尔值拒绝；超时提示查询原更新操作 |
| Connector 全量现有测试 | 更新两处过时 Provider 清单断言后，1278 通过；用户明确授权只修改这两处测试 |
| Web / Electron | 类型检查与 protocol:check 通过 |
| Android | `:app:compileDebugKotlin` 通过 |
| iOS | 表单领域文件类型检查、修改的 SwiftUI/API 文件语法解析通过；本机只有 CommandLineTools，无法执行完整 Xcode 构建 |
| Server 启动 | 一次性 PostgreSQL 迁移至 v2_45，正式 create_app lifespan 启动通过；架构检查 2 通过 |
| Server 全量现有测试 | 984 通过、14 跳过、2 失败；失败是迁移版本仍断言 v2_44，以及目录 RPC 的旧预期未包含 sessionId。没有修改这两处 Server 测试，也没有跳过它们 |

CI 新增三操作系统的 ACP 协调探针矩阵；这里只记录本机 macOS 的结果，不把工作流定义当成远端运行结果。

执行者组件引用在启动前持久化，确认进程关闭后才释放。重启遗留但尚未核验释放的执行者引用保守阻止组件删除；不能按 PID、TTL 或删除锁文件强行清理。该引用的重启核验收敛仍需随完整 Agent 恢复用例实现。

## 继续实施顺序

1. 完善通用恢复、来源替换、组件状态页面及高级能力用例；保持能力门禁。
2. 等待上游正式公开所需钩子，固定版本与提交，实施 `pi-acp-agent` 全部增强。
3. 生成六个平台架构的固定组件，核验原生进程／写锁和共享数据兼容。
4. 完成四端受控业务链路与完整 Pi 首发验收后，才配置正式公钥／发布源并开放入口。

本次不提交或推送代码、不发上游 PR、不发布组件，不调用真实供应商。完整计划的剩余项不能仅归因于上游；上表明确列出了仍可独立推进的通用工作。
