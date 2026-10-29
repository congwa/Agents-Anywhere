# pi Runtime 实现记录

实现位于 `feat/con+be/pi-runtime` 独立 worktree，基于 `34f7cbf5`。产品版本保持 2.1.0。本记录说明当前代码和直接检查，设计目标仍见主方案及客户端方案。

## 已落地

- `connector/connector/runtimes/pi/`：Provider、环境完整性校验、只影响本实例的启动失败、Host 进程监督、薄 Runtime 适配和 MeshCall 同步。
- `pi-runtime/`：工作区预览、项目信任、单次预留、异步创建、创建中 UI 回答、独立会话 worker、审批回执、原始工具参数冻结、最终模型请求守卫、运行配额、可靠 outbox、原生位置记录及 OS 写锁。
- `server/agent_server/core/runtime_workflows.py`、`services/runtime_workflows.py`、`infra/repositories/runtime_workflows.py`、`api/runtime_workflows.py`：用户/设备/实例/项目绑定，持久化操作，预分配平台会话，HTTP 202 查询/回答/取消及位置接口。
- `server/migrations/versions/v2_45.py`：工作流表及结束事件幂等回执。重复创建在数据库中复用同一平台身份；预留的会话 ID 使用事务锁，避免并发分配。
- `contracts/pi-bridge/1.0`、`contracts/runtime-workflows/1.1`、`contracts/protocol/1.1`：输入 schema、对话结果、同步信封及校验清单；原协议 1.0 JSON 产物字节保持不变。
- Web / Electron：能力驱动的工作区准备、作用域模型目录、创建进度、创建中回答/取消、会话内通用对话、业务失败保留请求、原生历史及继续位置入口。
- Android / iOS：准备、创建中交互、工具审批和通用对话；原样保留空文本、预填和多行内容。Android 交互通道独立于创建协程，iOS 在准入前保留新建页面。
- Electron 复制本地构建的 Node + Host 产物；未改造共享登录、本机绑定和根门禁。

## 运行边界

| 能力 | 当前行为 |
| --- | --- |
| 多工作目录 / 多会话 | 一个 Host，多独立 worker；按 worker 数、并行回合数和运行时间限制 |
| 项目信任 | 默认基础能力；受保护资源在决定之后加载；本次授权不改全局默认 |
| 工具审批 | 冻结实际参数；回答绑定请求版本、owner generation、父工具及分支/权限范围 |
| 模型与恢复 | 固定物理模型策略；不静默 fallback；原生分支选择不符时要求明确重选 |
| 原生 JSONL | 只读发现与投影；单次校准最多 1000 条，保持 partial，不删除已有条目；不通过构造 SessionManager 扫描原生历史 |
| 流式/原生关联 | 原生 reservation marker + 平台/原生身份校验；复制历史不复用其他会话的条目 ID |
| 继续位置 | 仅已管理 SDK 会话可选择；关闭执行者后，通过 epoch、文件摘要、位置版本比较再交换；Web / Electron 已有入口 |
| 第三方原生 TUI | 历史只读；不接管其通用提问和写入，不宣称已部署 NativeAttach |
| 扩展范围 | SDK 公共 UI 对话与工具事件；任意 TUI 自定义组件、动态路由、原生命令、附件和 steer 没有发布能力 |
| 平台 | macOS / Linux 产物；Windows 显示该 Runtime 不可用，尚未实现 Job 监督后端 |

## 已执行的检查

- TypeScript Host/worker 编译、Web 类型检查、Electron renderer 类型检查。
- Android `:app:compileDebugKotlin`。
- iOS ClientCore 源文件使用 `swiftc -typecheck -default-isolation MainActor -swift-version 5` 通过；改动 SwiftUI 文件语法解析通过。
- SDK 功能检查：信任先于项目资源、创建中的原样多行回答、回答幂等、本地模型 HTTP、Timeline、关闭后零 worker、离线原生投影、复制历史身份隔离和只读扫描。
- SDK 工具边界检查：审批 A 后，后续 handler 改为 B 被拒绝，最终执行参数仍是 A；同目录会话使用独立进程，配额和跨进程写锁检查通过。
- 生产 `ModelGuard` 检查：正常请求通过；扩展晚换模型、晚换推理强度、payload 换模型和推理强度均未发出请求。
- Python → 本机 MeshCall Router → 打包 Host → 隔离 SDK 预览进程。
- HTTP 工作流集成：独立 PostgreSQL 执行至 v2_45；HTTP 202、创建中回答、重复创建同一会话、输入冲突、账号隔离、本地 SDK HTTP 和 Timeline ACK。该检查使用内存 Runtime 清单和 RPC 入口适配，不代表已在真实部署中完成四端验收。
- 现有 Server 协议、能力及架构检查 40 项、Connector 相关检查 82 项、Web 检查 415 项、Electron main 检查 157 项通过。

`swift build --package-path ios` 在清单阶段被本机 PackageDescription 解析失败阻断，错误涉及现有的 `defaultIsolation`、`swiftLanguageModes` 和平台枚举。使用直接 ClientCore 类型检查绕过该工具入口，未改动清单或产品版本。

## 2026-10-29 审查问题修复

- Connector 转发 `session.close` 到已存在的关闭用例；通过 HTTP 调用验证 worker 关闭后可恢复，恢复中的扩展提问仍有独立回答入口。
- 显式基础模式在正式装配和恢复时保持禁用项目资源；不会被后续持久信任记录提升。SDK 回归使用加载即抛错的项目扩展，验证基础模式创建和异常恢复都不加载它。
- 继续位置选择与恢复启动共用会话锁；来源、文件摘要和位置版本均通过后，保存干净位置、关闭旧交互，并发布空闲状态和能力。冲突失败保持阻塞，成功后实际请求可继续。
- 项目登记路径与真实执行目录分别保存。符号链接下新建、同步、关闭恢复及重连不改变项目归属；原生来源通过真实文件路径去重，避免把管理中的历史再次导入为只读会话。
- Bridge 分页游标独立于业务 ID，允许最多 1024 字符；已重新生成 schema 和校验清单。实际历史超过 500 条时，第二页按 Host 返回的游标读取，条目不重不漏。
- Android 新会话详情初始化及设置弹窗使用准备结果的模型目录；只有未携带工作区准备的普通 Runtime 继续请求全局目录。
- 同步模式统一为 `events`；启动和重连回填元数据、最多 1000 条部分历史、状态、Notice 和能力。外部原生 TUI 后续写入通过显式同步读取。

本轮检查：SDK 创建/恢复/工具/模型边界/worker 隔离探针、打包后的 Python → MeshCall → SDK 检查、Bridge SHA-256 清单验证均通过；Connector 定向检查 72 项、Server 协议/能力/架构检查 40 项通过，Android `:app:compileDebugKotlin` 通过。HTTP 集成使用真实 Connector 顶层分发器、生产通知映射和 Server 通知处理器，完成工具审批后实际写文件、继续对话、HTTP 关闭恢复、符号链接项目绑定及重连回填并检查 PostgreSQL Timeline。Server 到 Connector 的控制传输仍使用进程内适配器，模型端点为本机受控 HTTP 服务。

## 后续并发与客户端问题修复

- 关闭操作登记独立的进行中状态，SDK 退出和事件清空期间阻止发送、恢复、模型及位置选择；并发关闭共享同一结果，收尾核验 worker 和 owner generation，不再无条件清掉会话绑定。worker 自身也拒绝关闭后的新 prompt/select/boot。
- Web/Electron 的回答、取消和查询全部核验账号、服务范围与代际；切换账号时清除交互错误和请求中状态，旧回包不能覆盖新操作。Android 固定捕获服务器、用户和 token，回答/取消/刷新/恢复的结果按代际与操作 ID 发布，清理和发布在同一状态锁中执行。
- 供应商请求失败与模型授权违规分别发布 `error` 和 `blocked`；普通 HTTP 500 后可以通过 Server 的状态与能力校验继续发送，授权违规的发送能力仍不可用。
- Web/Electron 的历史位置弹窗以会话及 owner generation 为生命周期范围，新的执行者会重建弹窗状态，恢复运行后可以再次关闭。

本轮实际检查：SDK 关闭/恢复并发、HTTP 500 后继续发送、异常恢复和历史分页探针通过；模型与工具边界探针、worker 隔离探针及打包后的 Connector 桥检查通过。HTTP 集成通过真实 Server 服务、Connector 顶层分发器和通知处理器验证供应商错误后的下一次请求。Web 415 项、Electron renderer 436 项、Electron main 157 项现有检查通过，Web/Electron 类型与协议检查通过，Connector 定向检查 72 项通过，Android Kotlin 编译通过。

新增 `web-next/scripts/verify-runtime-workflows.mjs` 与 Electron renderer 的同名脚本，使用实际 React hook/组件及受控响应验证：切换账号后的取消、回答和查询，无论旧请求成功或失败，都不会覆盖新账号状态，也不会解除新请求的 pending；关闭一次并更换 owner 后，关闭按钮重新出现。两端脚本均通过并已加入 CI。探针使用 jsdom、UI 包装替身和受控 API 回包；HTTP 集成仍使用进程内 Server→Connector 控制适配器及本机模型端点。

## 流式投影、接纳恢复与兼容性修复

- 助手的开始、增量和结束事件沿同一 SDK 响应流绑定到原生 reservation，不再依赖事件对象相同；待发布增量按条目 ID 合并，结束时清除残留增量，原生 entry 落盘后更新来源及内容指纹，防止完成状态被旧增量覆盖，也保证来源更新能写入 Server。
- 创建记录保存消息身份、请求指纹及原生会话身份；Host 重启和查询核验 worker 的持久接纳回执。匹配回执恢复确定结果，指纹或身份冲突、只有 prepared 记录时继续保持未知，不创建 worker，也不重发原消息。
- 模型目录和请求守卫共享格式判定，支持标准 OpenAI Completions、OpenRouter 的嵌套推理字段及 OpenAI Responses；未支持的编码和不能传递推理强度的配置保持不可用，兼容配置参与目录指纹。
- 历史扫描隔离无法读取或解析的文件，通过清单和 ping 返回诊断；Connector 记录诊断，并在完整回填中隔离单个历史来源失败，连接错误仍向上返回，显式同步异常会话也仍返回失败。
- iOS 以携带完整工作流事实的领域错误区分确定未接纳与未知；确定失败后清除对应操作引用、解除阻塞并保留草稿，未知或已接纳但元数据不可读时继续保留引用。DTO 和该错误位于 Domain，API 保持资源调用职责。

本轮直接验证：慢速流式回答先出现部分内容，随后以同一 ID 更新为完整正文及 `done`，关闭后历史身份不变；实际 SDK 接纳后、Host 写入前的崩溃快照能恢复，冲突、prepared-only 和迟到回执均按证据处理，恢复 worker 数为 0、模型请求总数为 1。OpenRouter 高推理、关闭推理及 payload 篡改探针通过；打包后的 Python/MeshCall 桥在坏头、坏正文与正常历史并存时继续完成回填；Connector 相关现有检查 228 项通过。

HTTP 集成使用实际 Server 服务、Connector 顶层分发器、SDK 和独立 PostgreSQL，验证创建中回答、工具审批后写文件、继续对话、关闭与恢复、供应商失败后再发送、重连回填；数据库中的 3 条助手消息均为 `done` 且保留原生 entry 身份。Server→Connector 控制转发使用进程内适配器，模型端点为本机受控 HTTP 服务。iOS 的 `bash ios/scripts/verify-runtime-workflows.sh` 编译 ClientCore 实际源文件及模型探针，验证四种确定终态解除不确定标记、保留草稿，以及未知和已接纳但缺少元数据时保留操作引用。

新增 `pi-runtime/scripts/verify-admission-recovery.mjs` 已接入 CI；现有流式、模型边界、Connector 及 Server 探针增加对应直接验证，均位于 `scripts/`。

## 生命周期与恢复的领域边界

本轮将六项修复按状态所有者落实，避免 API、Python 适配器、UI 各自推导执行结果。

| 范围 | 领域规则 | 应用协调 | 基础设施职责 |
| --- | --- | --- | --- |
| Server 创建与准备 | `core/runtime_workflows.py` 定义明确未预留的拒绝事实及终态识别 | `RuntimeWorkflowService` 协调预留、分配会话、创建及查询；未知结果继续使用原身份恢复 | Repository 端口将拒绝终态与本操作准备占用的释放放在同一事务中；不释放其他操作的占用 |
| Pi 准备准入 | `domain/preparations.ts` 纯策略核验版本、选择及既有绑定 | Host 在决定成功后保存预留，缺失所有者元数据仍返回未知错误 | 只读 SDK 预览提供目录定义；存储失败保持错误，不伪装成未预留 |
| Pi 执行生命周期 | `domain/session-lifecycle.ts` 定义 worker 退出事实、所有者匹配及中断状态 | Host 以会话事件队列处理事实，拒绝旧 worker/代际的迟到事件，取消旧交互并保存阻塞状态和能力 | WorkerProxy 只观察进程与预期关闭事实，Supervisor 释放进程登记，不替应用层决定业务状态 |
| Pi 目录版本 | `domain/catalog.ts` 区分内容指纹与递增 revision | 唯一 Host 为各工作区登记目录观察，给预览和正式 SDK 装配赋予平台版本 | `CatalogRevisions` 串行、原子持久化版本；从已保存的旧目录恢复版本下限，避免 Android 将新目录误判为旧值 |
| Pi 同步 | 当前状态与旧执行者观察属于不同事实 | Host 在同一会话事件队列捕获回填，随后在队列外等待 ACK，避免网络等待占住领域转换 | 实时和回填共用有界 outbox；重启丢弃旧状态/能力观察，保留历史和回合事实；Python 只转发同步用例，不另行发布快照 |
| Android 创建绑定 | 接纳消息与绑定正式会话是两个阶段 | Coordinator 在读取并核验 `AgentSession` 身份后才清理引用；Controller 将 API 返回映射成会话领域值 | HTTP 和账号隔离存储提供端口；全局对话框只提交“打开已创建会话”的意图，失败可重试，旧账号结果不能完成新账号绑定 |

迁移声明同步为 `v2_45` / 数据库 schema `2.45`，产品版本不变；正式 `create_app()` lifespan 已验证能启动、关闭。无 Alembic 标记但已有完整工作流表与事件回执表的数据库会按实际列结构识别为 `v2_45`，不再重复建表；只存在部分新结构时拒绝自动识别。

确定拒绝的数据流是：`Host 领域预留决定 → reserved=false → Server 拒绝终态与释放本操作占用 → HTTP 202/GET/取消返回相同终态 → 客户端保留草稿`。预留 ACK 丢失的数据流是：`Runtime 已预留 → Server 保留未知与占用 → GET 使用同一身份重新观察/预留 → 幂等恢复正式创建`；两条链路通过真实 HTTP、PostgreSQL、Connector 顶层分发和 SDK 产物验证，丢失 ACK 不会变成可重新创建的确定失败。

SDK worker 被杀死时，实际探针验证旧交互关闭、Host 保持存活并转为阻塞、位置选择能力可用；随后以未确认 outbox 重启 Host 并阻塞接收 ACK，回填不会提前返回，也不会重放旧 `running` 覆盖新恢复状态。普通关闭仍按原关闭流程完成。目录探针验证内容不变与并发预览保持版本、内容改变时递增、重启保持版本，以及旧哈希 revision 的下限迁移。

Android 的 `python3 android/scripts/verify-runtime-workflows.py` 编译实际 Coordinator，验证读取元数据失败、恢复查询、错误会话身份、成功绑定和账号切换期间的迟到绑定；HTTP、持久存储和会话读取端口使用受控实现。`:app:compileDebugKotlin` 同时验证 Controller、全局恢复按钮与 App 导航接线。

CI 的 pi job 增加独立 PostgreSQL、正式 Server lifespan、预留失败/ACK 丢失恢复及递增目录检查；Bridge schema/manifest 已重新生成。源文件仍未修改 `tests/` 中的既有断言。

本轮验证结果：

- 正式 Server lifespan、打包后的 Connector/MeshCall/SDK 与 HTTP/PostgreSQL 工作流探针通过；Server 的无版本数据库识别、架构边界与协议专项共 24 项通过。
- Server 首次全量检查为 983 通过、14 跳过、3 失败；其中无版本数据库重复建表问题已修复。保留两条旧断言后，以明确的 `-k` 排除它们重跑，结果为 984 通过、14 跳过、2 未选中；没有改 CI 来屏蔽这些断言，完整 Server 检查尚非全绿。
- 两条未改断言分别是 `server/tests/test_database_migrations.py:1017` 固定要求 `v2_44/2.44`，以及 `server/tests/test_runtime_config.py:627` 固定要求模型/权限目录 RPC 不含 `sessionId`；当前统一目录端口已按会话查询，并由 Runtime 默认实现回退到全局目录。按用户提供的 Tests Directory Policy 保留测试文件，更新这些期望需要单独授权。
- Connector 相关现有检查 228 项通过；SDK 流式与异常退出/有序回填、关闭恢复、接纳回执、目录版本、模型/工具边界及进程隔离探针通过。Android Kotlin 编译及实际 Coordinator JVM 探针通过；Web/Electron 协议检查与工作流账号隔离探针通过。

上述模型验证使用受控响应与本机 HTTP 端点；Server→Connector 控制转发为进程内适配器，SDK、进程锁、正式 Server 生命周期和 PostgreSQL 均为实际实现。产品版本与 `tests/` 文件保持不变。

## 继续扩大兼容范围的独立工作

原生 TUI 协作扩展 / NativeAttach 写入接管、Windows Job 后端、动态模型路由、附件、steer、任意终端组件、移动端分支位置选择仍需各自落地；它们目前不发布可用能力。工作流服务端记录及客户端操作引用均已持久化；引用按账号和服务地址隔离，重启后仅查询和恢复回答入口，不重发创建请求，也不存储提示词或认证信息。
