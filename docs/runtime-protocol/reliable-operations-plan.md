# 可复用 Runtime 操作与 MeshCall 接入计划

状态：待实施。本文为架构及分阶段交付计划，不代表功能已经完成。

日期：2026-10-23。

## 1. 目标和范围

建立统一的可靠操作生命周期，首先接入工作区创建，随后接入工作区改名；后续其他操作复用同一套接收、执行、回执、恢复和展示机制。新增操作应主要增加类型化参数、能力声明和 Runtime 处理器，不再复制操作表、轮询、ACK 和重试逻辑。

“任意操作”指可以注册新的操作类型。执行范围仍由版本化契约、能力、账号和设备授权约束，不接受客户端任意指定 Python 方法、Runtime 方法或脚本执行。

本期沿用项目当前依赖的 MeshCall 0.3.0，完善 Connector 与 DSH 插件之间的接入。Server 与 Connector 暂时保留现有 WebSocket RPC，通过薄适配器调用同一个操作服务。未来迁移这条通道到 MeshCall 时只替换传输适配器，不重写操作生命周期。

本期不迁移 Timeline、普通工作区快照同步、终端流或原生 Codex/Claude 协议。Codex/Claude 仍通过各自 SDK/原生接口执行；不为了形式统一增加进程内 MeshCall 跳转。

## 2. 当前基础与要补齐的部分

已有基础：

- Server `project_operations` 保存项目创建请求、结果及客户端确认。
- Connector `project.create/project.operation` 与 `sync_state_*` 保存设备侧创建回执。
- DSH `Bridge.createWorkspace` 已经通过 MeshCall 调用原生 Registry。
- DSH 历史同步已经使用 MeshCall 幂等键、调用返回确认和 checkpoint。

需要补齐：

- 操作逻辑分散在 API、项目 repository 与 RPC 分支，需形成业务可复用的模块。
- 缺少持久调度、设备端独立执行和按原生能力恢复的完整链路。
- DSH `createWorkspace` 当前误标为 `@query`，且业务 requestId 未传入 MeshCall `idempotency_key`。
- MeshCall 去重缓存不承担跨 Router 重启的业务防重；持久回执不能移除。

## 3. 调用链和状态所有权

```text
Web / Desktop / Android / iOS
  → 业务 API（创建项目、未来的改名等）
  → Server OperationService + PostgreSQL 操作记录
  → 持久 Dispatcher
  → 传输适配器（当前 WebSocket RPC，未来可换 MeshCall）
  → Connector OperationExecutor + JSON 回执
  → Runtime OperationHandler
      ├─ DSH：MeshCall OperationsService → 本地执行器与回执 → Registry
      ├─ Codex：原生 SDK / 协议
      └─ Claude：原生 SDK / 文件元数据能力允许的操作
  → 执行结果逐层持久保存并确认
  → 原生清单同步更新项目投影
  → 客户端展示结果并确认已读
```

Server 保存账号可查询的请求与最终结果；Connector 保存设备侧接收和执行进度；DSH 插件保存其独立进程内原生执行的回执。每一跳只在自己的记录持久化后确认接收。设备端 ACK 不等于执行完成，执行完成也不等于客户端已经读到结果。

项目名称、根目录和成员事实仍由原生清单同步提供。操作成功后触发来源刷新，不能由操作框架直接伪造一份项目清单。

## 4. 目录组织

以下为目标位置；实施时按实际职责增量创建，不预建空目录和无调用方的抽象。

```text
contracts/runtime-operations/1.0/
  README.md                    生命周期、幂等、ACK、恢复与兼容规则
  schemas/                     信封、状态、错误及各操作参数/结果
  fixtures/                    契约示例，遵循仓库现有 contracts 布局

server/agent_server/
  core/operations.py           API/传输无关的状态和值类型
  services/operations/
    service.py                 提交、恢复查询、确认、结束追踪
    dispatcher.py              持久调度、重连恢复、租约与退避
    ports.py                   repository、设备传输、业务回调接口
  services/project_operations.py
                               工作区创建/改名的授权、参数及投影就绪判断
  infra/repositories/operations.py
                               PostgreSQL 操作记录、原子状态更新
  infra/operation_transport.py  现有 Connector RPC 的薄适配
  api/operations.py            通用查询、确认等 HTTP 映射
  api/projects.py              保留业务入口，委托应用服务
  migrations/versions/v2_N.py   实施时采用下一个未使用编号

connector/connector/
  runtime_protocol/operations.py
                               类型化请求/结果、处理器和恢复能力契约
  operations/
    executor.py                接收、防重、独立执行与资源串行
    recovery.py                重启恢复、结果核对及重试决策
    store.py                   回执存储接口与 JSON 实现
  server/operation_rpc.py      WebSocket RPC → 执行器的薄适配
  runtimes/{codex,claude,dsh}/operations/workspaces.py
                               对应 Runtime 的创建/改名处理器

dsh-bridge-next/src/host/dsh-runtime/operations/
  service.ts                   MeshCall 服务、类型化 Schema 和错误映射
  executor.ts                  插件侧接收、执行与恢复
  store.ts                     插件侧 JSON 回执
  workspaces.ts                原生 Registry 创建/改名及核对

web-next/src/features/operations/
desktop-workbench/renderer/src/features/operations/
                               类型、API 和通用状态展示/恢复逻辑
```

Android 按现有 `api/`、业务 controller 和 UI 职责拆分；iOS 按 API、Domain、Business、Repository 现有分层接入，不照搬 Web 目录。各端以同一契约保持行为一致。

依赖约束：

- Server services 只依赖 core 和 ports，不依赖 FastAPI、具体 Store 或 MeshCall。
- Connector `operations/` 不导入某个 Runtime 的实现；由组合入口注册处理器。
- Runtime 处理器不导入 Server API 或数据库 repository，也不自行发送服务端方法名。
- MeshCall 服务仅做校验、调用上下文与业务服务转接，不包含可靠执行状态机。
- 通用执行器不出现 `if operation == workspace.create/rename` 之类的业务分支。

## 5. 统一契约

### 5.1 操作身份

每个请求包含：`operationId`、`type`、`operationVersion`、来源绑定、`target`、类型化 `input`、Server 签发并校验的创建/过期时间、可选原生版本前置条件。过期限制新的原生执行，不禁止查询已有结果。

- 初始类型为 `workspace.create`；后续增加 `workspace.rename`。
- 外部 `requestId` 用于账号级提交防重；Server 分配的 operationId 贯穿所有执行层。
- MeshCall 的 `idempotency_key` 使用稳定的 operationId，重连或重试不重新生成。
- 同一 operationId 必须绑定相同的语义参数摘要；不同参数返回冲突。
- 摘要采用契约规定的规范化 JSON 算法，只包含执行语义字段；不依赖各语言默认 JSON 序列化顺序。
- 来源绑定包含用户所属 Server/账号命名空间、connectorId、runtimeId、runtime 类型及配置代次。切换账号、重建实例或改变原生存储位置不得复用旧操作。
- WebSocket 连接 epoch 用于准入和拒绝旧连接，不作为操作 ID，也不因重连更换业务身份。

### 5.2 生命周期与确认

执行状态使用 `queued / accepted / running / reconciling / succeeded / failed / unknown`，传输尝试、投影状态和确认字段独立保存，避免把一个 status 同时用于四种含义。

| 语义 | 含义 |
| --- | --- |
| queued | Server 已持久接收，等待投递或核对设备是否接收 |
| accepted | 设备执行方已持久接收 |
| running | 已进入可能产生原生副作用的阶段 |
| reconciling | 正在查询/恢复原生结果 |
| succeeded | 原生成功有明确证据，结果已保存 |
| failed | 有明确失败证据；不能仅凭超时判定 |
| unknown | 存在执行可能性，目前无法确认结果 |
| resultReceivedAt | 上游已持久保存结果，可以停止主动回传 |
| clientAcknowledgedAt | 用户端已经获取结果，退出待处理提示 |
| trackingClosedAt | 用户明确结束追踪；不改写原生执行事实 |
| projectionState | 领域投影尚在同步、已经就绪或需要核对 |

合法转换由契约固定：结果未知可在核对后转为成功/失败；重试与迟到回包不能将已确认成功降级为 pending/unknown。结束追踪后迟到的结果仍可入账，但不自动重开已关闭提示。

`accepted` 必须在本地持久化成功后返回。RPC 调用取消或页面关闭只停止等待，已接受的任务由独立 worker 持有，不跟随连接协程取消。显式取消是另一个能力；没有原生取消支持时不能承诺撤销。

### 5.3 MeshCall 服务

DSH 插件增加类型化 `aa.dsh.v2.Operations` 服务，提供 `submit`、`get` 和明确语义的结果接收确认方法。`submit` 在持久接收后尽快返回操作状态，实际执行与调用寿命解耦。

- `submit` 为 `@mutates`，调用携带 operationId 对应的幂等键；持久防重完成后再声明其重复提交语义。
- `get` 为 `@query`；状态订阅可后续增加，轮询为第一期基础能力。
- 现有 `Bridge.createWorkspace` 在兼容期间委托同一执行器，不保留另一套创建逻辑；修正其只读标记。
- Connector `BridgeClient` 扩展调用 options，明确传递 `idempotency_key`；正文 requestId 不能代替 MeshCall 调用选项。
- 同步更新 Hub 角色权限、插件挂载、服务发现与生成客户端。权限仅授予已有合法调用方，不让本机客户端绕过 Server 账号授权执行云端操作。
- 服务信封与参数以共享契约约束；采用现有工具支持的客户端生成流程，生成产物做一致性检查，避免复制宽泛 `Record<string, unknown>` 后绕过类型校验。

## 6. 可恢复性与并发

### 6.1 Server

将项目专用记录迁移为通用 operations，保留现有操作 ID、请求身份、结果和确认。操作记录本身兼作待投递队列，不额外复制一份同义 outbox。

- 提交事务同时保存请求和待调度状态；Dispatcher 采用行锁/原子领取、有限租约、attempt generation 和 nextAttemptAt，支持多 Server 实例。
- 业务提交入口不再同步等待 30 秒原生执行；提交后即可返回 operationId。
- 连接断开不清除任务，重连后优先查询同一 operationId；没有设备接收证据时可重复提交同一工单。
- 租约过期不意味着原生未执行。旧结果通过 attempt/version 校验，不能覆盖较新状态；结果保留审计证据。
- 账号、设备撤销、Runtime 配置变化和操作能力在接收及派发时重新校验。

### 6.2 Connector 和 DSH 插件

本地继续使用 JSON 持久化，不引入 SQLite。复用现有原子写入、刷盘和存储路径原语；通用操作记录放在专用操作命名空间/目录，避免每次状态变更重写全部历史 checkpoint。

- 关键阶段先写盘再确认，包含接收、开始原生调用、保存最终结果。
- 同一 operationId 的并发请求合并等待，参数不匹配拒绝。
- 重启先扫描未完成工单；accepted 且确定尚未执行的继续执行，running/unknown 进入 recover。
- 不能把 MeshCall 的 60 秒缓存当作永久去重；Router、Connector 和 DSH 插件分别重启后仍应使用持久回执。
- Connector 接收记录与 DSH 原生执行记录按同一 operationId 关联，各自只确认本层持久接收和结果，避免两边独立发起一次新的创建。
- 明确单进程所有权、跨异步任务互斥及落盘失败处理；可靠操作禁止静默降级到内存回执。

### 6.3 不同操作的恢复策略

处理器声明实际能力：`native_idempotency / query_by_operation / conditional_set / manual`，并提供 `validate / execute / recover`，必要时提供资源键和版本前置条件校验。能力来自已验证的原生 API，不从方法名推测。

- 原生幂等：复用同一键续执行，保存同一个原生结果。
- 原生操作查询：按稳定原生请求身份核对结果。
- 条件设置：原生支持版本条件更新时，在前置条件仍满足时安全恢复。
- 无恢复能力：保持 unknown，提供核对和结束追踪；不自动生成新操作重做。

仅凭“存在同名/同目录项目”不能认定创建成功。同样，仅发现名称等于目标值不能证明由本次改名造成；若业务只要求目标状态已满足，须在结果中明确表达，不能伪造原生执行回执。

### 6.4 改名的顺序约束

未来改名按 `(来源, nativeProjectId)` 串行，创建按来源及原生约束形成资源键。不同资源仍允许有限并发。

- 同一项目两次改名按明确顺序执行；自动重试不得绕过队列。
- 一次改名结果未知时，后续同资源改名先暂停核对，避免迟到的旧操作覆盖新名称。
- 同时考虑原生 UI/其他进程修改：优先使用原生 revision/CAS；原生没有条件更新能力时，仅本地串行不能保证外部并发安全，应明确冲突边界，无法安全恢复时转 unknown。
- 不静默合并或丢弃中间操作；如果以后增加“只保留最后一次”的产品语义，另行定义 superseded 状态和对用户的反馈。

## 7. 投影和各端复用

客户端通用操作模块负责提交中的防重复、状态查询、重开恢复、结果 ACK、未知结果说明及结束追踪。创建/改名组件只负责自己的参数表单与领域成功反馈。

- 原生创建成功而项目投影未出现：显示“已创建，正在同步”。
- 原生改名成功但清单仍旧：等待该来源的后续清单确认目标字段；不能仅凭旧项目记录存在就判定投影就绪。
- 执行失败与投影延迟分开展示；后者不能提示用户重新创建。
- 结果回包在切页、退出账号或新草稿产生后不得污染新上下文。
- 客户端确认只控制待处理提示，不清除防重身份，也不改变执行结果。

## 8. 兼容、迁移与保留

- 对现有 `/projects/operations`、`project.create/project.operation` 提供有限兼容映射，业务逻辑只保留一份。记录移除兼容入口的版本条件。
- 将现有项目创建操作转换为 `workspace.create`；历史 pending/unknown 不能直接映射为“确定未执行”，应保守进入核对。
- 旧 Connector 缺少新协议时明确要求升级，不回退到可能重复创建的旧路径。
- 为大小、队列数量、来源并发、重试频率和结果保留设置上限；结果接收后可清理大字段，防重 tombstone 保留至少覆盖协议允许的重试窗口。过期 ID 明确拒绝，不能当新操作再次执行。
- 审计记录保留 operationId、类型、来源、阶段、尝试与错误码；敏感路径和输入不无差别打印，凭据不进入操作参数或回执。
- migration 使用实施时最新的 `v2_N`，不修改已发布迁移；版本号按当时主线与接口范围统一调整所有端，不预先固定发布号。
- 回退优先停止新派发并保留回执。存在未核对操作时，不降级到不识别其身份的执行器。

## 9. 分阶段交付

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| 1. 契约与边界 | 固定身份、状态、ACK、恢复能力及目录；声明 workspace.create 和 rename 扩展形状 | 各层职责、错误和兼容策略可以独立评审，无现有行为变化 |
| 2. 通用持久执行 | 实现 Server 调度、Connector 执行器/回执，将创建分支迁入处理器 | 不再由 HTTP/RPC 路由编排业务生命周期；重启可继续查询同一操作 |
| 3. MeshCall DSH 接入 | 实现插件操作服务和回执；传递幂等键；旧创建方法委托统一执行器 | Router/Connector/插件分别重启后，同一操作不会盲目重复创建 |
| 4. 创建端到端与四端 | 接入 Codex 实际恢复能力、Claude 不支持能力说明、投影就绪及统一恢复 UI | 原生结果、Server 状态、客户端反馈一致；未知结果有可用出口 |
| 5. 改名验证复用 | 先接入原生确实支持改名的 Runtime，增加版本校验与资源顺序约束 | 新增改名无需新增另一套操作表、投递循环、ACK 或恢复页面；明确不支持端 |

Server ↔ Connector 的 MeshCall 整体迁移放在后续独立工作中，届时补齐跨网络认证、在线租约、多实例路由、实例定向、撤销、限流与连接恢复，不能直接把本机 Router 对公网开放。

## 10. 验证与交付边界

遵循用户目录政策，不新建或修改任何 `tests/` 内文件。使用已有检查、编译、类型检查、契约一致性检查，以及系统临时目录/忽略 QA 目录中的直接功能探针。

验证覆盖：正常创建；重复提交与参数冲突；Server 保存后尚未派发时退出；设备接收后退出；原生完成而结果未落盘时退出；结果/ACK 丢失；Router、Connector、DSH 分别重启；同一项目连续改名与外部修改；来源配置变化；账号切换；投影延迟；存储不可写。恢复能力不足的场景应稳定进入 unknown，不能以自动重做冒充恢复。

按受影响路径运行现有 Server/Connector/DSH/Web/Desktop 检查；Server 检查只连接确认用途的一次性测试库。Android/iOS 做对应编译和可用的直接验证，真实 Runtime 与真机验收单独记录。若现有准入要求必须新增或修改 `tests/` 内文件，先报告冲突并取得用户明确授权。

交付分别说明契约/源码、自动检查、受控故障注入和真实 Runtime 的完成情况；不以模拟回执替代真实原生恢复验收。首个实现不宣称“所有操作 exactly once”，按每种原生能力报告实际保证。
