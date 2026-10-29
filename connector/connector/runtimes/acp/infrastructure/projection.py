from __future__ import annotations

from ..domain.definitions import fingerprint


class Projection:
    """Connection-local ACP v1 identities; never merge them across replays."""

    def __init__(self, session_id: str, epoch: str):
        self.session_id, self.epoch = session_id, epoch
        self.items: dict[str, dict] = {}
        self.message_index = 0
        self.current_kind = None

    def apply(self, update: dict) -> dict | None:
        native = update.get("_meta", {}).get("aa", {}).get("timelineItem")
        if native and update.get("aaProjectionVerified"):
            if not isinstance(native.get("id"), str) or native.get("type") not in {
                "message",
                "tool",
            }:
                raise ValueError("Invalid AA native projection identity")
            old = self.items.get(native["id"])
            if old and native["revision"] <= old["revision"]:
                return None
            item = {
                **native,
                "sessionId": self.session_id,
                "source": {**native["source"], "runtime": "acp"},
            }
            item["contentHash"] = "sha256:" + fingerprint(
                {
                    key: item[key]
                    for key in ("type", "status", "role", "content", "source")
                }
            )
            self.items[item["id"]] = item
            return item
        kind = update.get("sessionUpdate")
        if kind in {"agent_message_chunk", "agent_thought_chunk", "user_message_chunk"}:
            if self.current_kind != kind:
                self.message_index += 1
                self.current_kind = kind
            key = fingerprint([self.session_id, self.epoch, kind, self.message_index])
            old = self.items.get(key, {})
            content = update.get("content", {})
            if content.get("type") != "text":
                return None
            text = old.get("content", {}).get("text", "") + content.get("text", "")
            item = {
                "id": key,
                "sessionId": self.session_id,
                "type": "message",
                "role": "user" if kind == "user_message_chunk" else "assistant",
                "status": "running",
                "content": {
                    "kind": "markdown",
                    "format": "markdown",
                    "text": text,
                    "isThinking": kind == "agent_thought_chunk",
                },
            }
        elif kind in {"tool_call", "tool_call_update"}:
            self.current_kind = None
            tool_id = update["toolCallId"]
            key = fingerprint([self.session_id, self.epoch, "tool", tool_id])
            old = self.items.get(key, {})
            content = {
                **old.get("content", {}),
                **{
                    key: value
                    for key, value in update.items()
                    if key != "sessionUpdate"
                },
            }
            content = {
                **content,
                "kind": "tool_call",
                "title": content.get("title", "Agent tool"),
            }
            status = {
                "in_progress": "running",
                "completed": "done",
                "failed": "failed",
                "pending": "pending",
            }.get(update.get("status"), old.get("status", "pending"))
            item = {
                "id": key,
                "sessionId": self.session_id,
                "type": "tool",
                "role": "tool",
                "status": status,
                "content": content,
            }
        else:
            return None
        item["source"] = {"runtime": "acp", "epoch": self.epoch}
        item.update(
            orderSeq=old.get("orderSeq", len(self.items) + 1),
            revision=old.get("revision", 0) + 1,
            contentHash="sha256:"
            + fingerprint(
                {
                    key: item[key]
                    for key in ("type", "status", "role", "content", "source")
                }
            ),
        )
        self.items[key] = item
        return item

    def finish(self) -> list[dict]:
        result = []
        for item in self.items.values():
            if item["type"] == "message" and item["status"] == "running":
                item["status"] = "done"
                item["revision"] += 1
                item["contentHash"] = "sha256:" + fingerprint(
                    {
                        key: item[key]
                        for key in ("type", "status", "role", "content", "source")
                    }
                )
                result.append(dict(item))
        self.current_kind = None
        return result
