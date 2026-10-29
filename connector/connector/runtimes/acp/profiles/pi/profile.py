from ...domain.definitions import AgentProfile

PI_PROFILE = AgentProfile(
    id="pi",
    title="Pi",
    permission_options=(
        ("ask", "写入与命令审批"),
        ("ask_all", "全部工具审批"),
        ("readonly", "只读"),
    ),
    required_guarantees=frozenset(
        {
            "project_trust_before_resources",
            "durable_prompt_receipts",
            "frozen_tool_parameters",
            "final_model_request_guard",
            "native_writer_lease",
            "stable_native_identity",
        }
    ),
    # AA owns the SDK lifecycle; activation requires signed release acceptance.
    release_ready=False,
    unavailable_reason="pi_acp_release_acceptance_pending",
)
