# 通用 ACP Runtime

此目录是 Connector 的 ACP 防腐层。`domain` 保持纯领域对象，`application` 编排端口，`infrastructure/acp` 使用官方 Python SDK，`profiles` 登记 Agent 特有保证。生产协议仅启用 v1；SDK 的可选扩展开关不代表 ACP v2。

Pi Profile 已登记但不可创建，原因为上游尚缺必要公开扩展点。禁止通过安装后修改依赖绕过发布门禁。旧 `runtimes/pi` 保留。

组件目录与会话使用同一命名空间的协调数据库，发行目录不可变。正式发布源与信任公钥尚未配置；受控探针临时生成自己的密钥，不属于生产信任。

在 `connector/` 运行：

```sh
uv run python scripts/verify-acp-runtime.py
uv run python scripts/verify-acp-processes.py
uv run python scripts/verify-acp-components.py
uv run python scripts/verify-acp-packaging.py
```

探针不调用真实模型，不安装全局软件，不修改共享 Pi 目录。完整边界与当前缺口见仓库 `docs/runtime-protocol/acp-runtime-implementation.md`。
