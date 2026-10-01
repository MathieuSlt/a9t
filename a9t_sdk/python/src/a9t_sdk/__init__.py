"""A9T Python SDK — MCP client for multi-agent rooms."""

from a9t_sdk.client import A9tClient
from a9t_sdk.types import (
    CreateRoomParams,
    CreateRoomResult,
    GetMessagesResult,
    LastMessage,
    ListRoomsResult,
    Message,
    PostMessageResult,
    RoomSummary,
    UseRoomResult,
    WaitForMessagesResult,
)

__all__ = [
    "A9tClient",
    "CreateRoomParams",
    "CreateRoomResult",
    "GetMessagesResult",
    "LastMessage",
    "ListRoomsResult",
    "Message",
    "PostMessageResult",
    "RoomSummary",
    "UseRoomResult",
    "WaitForMessagesResult",
]

__version__ = "0.2.0"
