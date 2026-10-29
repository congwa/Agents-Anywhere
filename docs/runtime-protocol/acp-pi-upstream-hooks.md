# Pi ACP 上游钩子调查（历史方案）

当前实现已采用统一能力端口与 Pi 组合适配层：OpenMA 已有公开能力直接委托，缺失能力由 AA 补充，不再等待本表中的上游钩子才开展源码实现。下文保留原始调查背景，现行结构见 [实施约定](acp-runtime-integration-plan.md)。

2026-10-29 核对 [openma/pi-acp v0.1.8](https://github.com/openma-ai/pi-acp/releases/tag/v0.1.8) 与 main 提交 `ffea89d285ea6d8219a4b86f23429f4ebf5e644e`。这是本次核对快照，不代表后续版本已满足要求。

公开的 `PiAcpAgentOptions` 可接收 settings、可选 ModelRuntime 与 requestIds，但资源／会话装配与绑定方法为内部实现。仅有模型对象注入不能完成资源信任、消息回执、最终请求守卫和所有权收尾，因此 AA Pi ACP Profile 保持 `pi_acp_upstream_hooks_pending`。

| 必须公开的行为 | AA 使用方式 | 必须观察的结果 |
| --- | --- | --- |
| 资源装配前的配置与扩展工厂 | 选择基础／本次／持久信任，装配受控扩展 | 未决定信任时受保护项目代码不执行；reload 重新遵守策略 |
| 会话级 ModelRuntime 与最终请求守卫 | 在所有扩展换模和 payload 转换之后检查模型、强度、端点 | 被晚修改的请求不触达受控端点 |
| prompt 元数据与接纳观察 | 稳定 clientMessageId、摘要、持久回执和查询 | ACK 丢失后查询同一操作，不重复模型请求 |
| 会话打开、替换、释放生命周期 | 获取原生写锁，检查恢复位置，实际释放后关闭 | 异常退出与取消不留下第二写入者 |
| 命名空间方法与能力元数据注册 | 提供 AA 准备、回执、来源及恢复扩展 | 只能在已核验保证下宣告对应能力 |

建议上游只增加可选构造依赖与生命周期端口，默认行为保持兼容；具体 TypeScript 签名由正式上游 API 决定，AA `profiles/pi` 与未来 `pi-acp-agent` 吸收差异。不要把本表当成已经存在的 API。

最小受控验收需包括：初始化前资源副作用计数、handler 后参数变化、before_agent_start 晚换模、首次与后续 prompt 接纳后断线、原生会话替换／关闭锁释放、初始化表单远程回答。通用受控 ACP Peer 已验证 Connector 侧语义，不能作为上述 Pi 执行侧验证的替代。

本次没有修改上游源码或已安装包，也没有提交上游 PR。正式上游版本满足行为后，记录确切版本和来源提交，再实现并核验 AA Pi Agent 入口。
