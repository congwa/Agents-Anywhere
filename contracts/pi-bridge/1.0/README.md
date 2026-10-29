# pi 本机 Bridge 1.0

契约源码：`pi-runtime/src/contracts/protocol.ts`。构建后运行 `node pi-runtime/lib/scripts/export-contracts.js` 更新 schema 和 SHA-256 manifest。

`aa.pi.v1.Bridge` 由唯一 Host 服务；每个请求包含 `runtimeId` 和 `sessionNamespace`。Python 的 `aa.pi.v1.Sync.ingestBatch` 使用 MeshCall 参数信封 `{ "batch": SyncBatch }`，见 `SyncRequest`。同步只有接收确认后才删除本地记录。

`reservePreparation` 返回 `{reserved:true}`，或明确未修改准备的 `{reserved:false,failure:{code,message}}`；超时、存储或传输失败仍通过错误返回，不能伪装为确定未预留。Server 保存拒绝终态并释放该操作的准备占用，后续查询和取消返回同一终态。

`resynchronizeSession` 接受会话身份与 `limit`（最多 1000），在 Host 的会话事件队列中捕获元数据、部分历史、状态、Notice 和能力，写入与实时事件相同的 outbox；只有这些记录收到 Connector ACK 后才返回 `{delivered:true}`。Host 重启时丢弃旧执行者尚未交付的状态及能力观察，保留历史、回合结束和交互裁决记录。

`initialize.features.orderedSessionSync=true` 表明上述有序同步端口可用；Connector 在启动时核验该能力，旧产物只使当前 pi 实例启动失败。

密钥通过 Connector 的私有 stdin 引导 Host，不进入命令行或 SDK worker 环境。Host、Connector 和将来的 NativeAttach 使用不同 Router 角色；当前没有发布 NativeAttach 写入服务。

分页游标是独立于业务 ID 的不透明字符串，长度上限为 1024；历史树游标包含来源 epoch、完整文件摘要及偏移。`session.close` 经 Connector 转发为 `closeSession`，操作结果须等待实际 worker 退出。位置选择在来源和版本校验通过后发布新的空闲状态与能力。

关闭进行中拒绝发送、恢复、选择模型或继续位置，返回 `session_closing`；同一所有者的并发关闭共享结果。关闭收尾核验实际 worker 与所有者身份，再释放会话绑定。普通供应商请求失败发布可重试的 `error` 状态，模型授权违规继续发布 `blocked`，发送能力与这些状态保持一致。

准备和会话绑定分别保存项目登记路径与实际执行目录：信任、资源检查和 SDK 使用真实路径，平台元数据继续使用项目登记路径，避免符号链接改变项目归属。选择基础能力是明确的资源禁用决定，正式装配不能提升为持久信任或再次要求授权。
