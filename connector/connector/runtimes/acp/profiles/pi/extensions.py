from ...domain.definitions import AcpError


class PiExtensions:
    def __init__(self, agent, verified_guarantees: frozenset[str]):
        self.agent, self.guarantees = agent, verified_guarantees

    async def get_operation(self, identity: dict) -> dict:
        if "durable_prompt_receipts" not in self.guarantees:
            raise AcpError("agent_receipts_unavailable", "该组件未通过持久回执验证。")
        return await self.agent.extension("aa/get_operation", identity)

    async def prepare(self, values: dict) -> dict:
        if "project_trust_before_resources" not in self.guarantees:
            raise AcpError(
                "agent_preflight_unavailable", "该组件未通过资源加载前的信任验证。"
            )
        return await self.agent.extension("aa/prepare_workspace", values)
