class PiPreparation:
    """AA Pi prepares resources without allocating a native session file."""

    async def prepare(self, context):
        return await context["client"].extension(
            "aa/prepare_workspace",
            {
                "preparationId": context["scopeId"],
                "cwd": context["workspace"].canonical_path,
            },
        )

    async def activate(self, context, session_id):
        return await context["client"].open_session(
            context["workspace"].canonical_path,
            aa={
                "preparationId": context["preparationTicket"],
                "platformSessionId": session_id,
                "ownerGeneration": context["generation"],
            },
        )
