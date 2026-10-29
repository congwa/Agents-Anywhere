"""Platform workflow 1.1. Runtime-specific payloads stay behind the adapter boundary."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Identity = str


def is_reservation_rejection(state: dict[str, Any]) -> bool:
    return (
        state.get("failureStage") == "reservation"
        and state.get("phase") == "rejected"
        and state.get("platformSessionCreated") is False
        and state.get("messageAccepted") is False
    )


def reservation_rejection(failure: dict[str, Any]) -> dict[str, Any]:
    return {
        "phase": "rejected",
        "revision": 1,
        "failureStage": "reservation",
        "platformSessionCreated": False,
        "created": False,
        "messageAccepted": False,
        "interactions": [],
        "canRespond": False,
        "canCancelInitialization": False,
        "failure": {"code": failure["code"], "message": failure["message"]},
    }


class PrepareWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connectorId: str = Field(min_length=1, max_length=160)
    runtimeId: str = Field(min_length=1, max_length=160)
    projectId: str = Field(min_length=1, max_length=160)
    clientPreparationId: str = Field(min_length=1, max_length=160)


class BeginCreationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preparationId: str = Field(min_length=1, max_length=160)
    createOperationId: str = Field(min_length=1, max_length=160)
    expectedRevision: int = Field(ge=0, le=9007199254740991)
    catalogRevision: int = Field(ge=0, le=9007199254740991)
    selections: dict[Literal["model", "permission"], str | None]
    clientMessageId: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=1000000)
    title: str | None = Field(default=None, max_length=4096)


class WorkflowInteractionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    interactionId: str = Field(min_length=1, max_length=160)
    requestRevision: int = Field(ge=0)
    ownerGeneration: str = Field(min_length=1, max_length=160)
    responseOperationId: str = Field(min_length=1, max_length=160)
    actionId: str = Field(min_length=1, max_length=160)
    input: Any = None


class WorkflowView(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocolVersion: Literal["1.1"] = "1.1"
    id: str
    kind: Literal["preparation", "creation"]
    connectorId: str
    runtimeId: str
    projectId: str
    sessionId: str | None = None
    state: dict[str, Any]


class PositionSelectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fileEntriesDigest: str = Field(min_length=1, max_length=160)
    sourceEpoch: str = Field(min_length=1, max_length=160)
    positionRevision: int = Field(ge=0, le=9007199254740991)
    leafId: str | None


class CloseRuntimeSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ownerGeneration: str = Field(min_length=1, max_length=160)
    closeOperationId: str = Field(min_length=1, max_length=160)
