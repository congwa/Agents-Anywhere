# Connector Control 1.0

Server 到 Connector 的控制面使用六个按领域划分的 MeshCall 服务：

- `aa.remote.v1.RuntimeControl`
- `aa.remote.v1.Sessions`
- `aa.remote.v1.Workspaces`
- `aa.remote.v1.Files`
- `aa.remote.v1.Shell`
- `aa.remote.v1.Terminals`

远程注册时，Server 为每个 Connector connection 派生隔离的服务名前缀和指定实例；
契约中的固定名称只表达版本与领域。调用参数继续由现有 Runtime protocol、文件、Shell
和 Terminal 领域模型校验，MeshCall 服务是薄入站适配器，不承载业务规则。

本契约包含 42 个原 Server WebSocket request/response RPC。工作区可靠创建继续使用
`runtime-operations/1.0`；历史 `project.operation` 和内部 `workspace.connection` 不属于
本契约。附件与文件正文、批量 ingest 和 PTY relay 保留各自数据面协议。

Server 对这 42 个方法不回退到旧 WebSocket RPC；Server 与 Connector 必须配套升级。
Router 尚未看到刚连接的实例时，只重试明确表示请求未分发的 `no_instances`，不会对
结果不明的变更调用做传输层重放。调用方超时或断线后，Connector 已接纳的工作继续执行，
保持原控制面的取消边界。

从仓库根目录重新生成：

```bash
cd connector
uv run python tools/generate_remote_control.py
```
