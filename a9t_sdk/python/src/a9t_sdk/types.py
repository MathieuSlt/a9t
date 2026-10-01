"""Result and parameter types for the A9T SDK."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass
class CreateRoomParams:
    name: str | None = None
    mode: Literal["read_only", "intervention"] = "intervention"
    max_capacity: int | None = None


@dataclass
class CreateRoomResult:
    room_ref: str
    name: str | None
    mode: str
    max_capacity: int | None
    raw: str


@dataclass
class UseRoomResult:
    # The room's room_ref (resolved when you joined by name).
    room_ref: str
    raw: str
    name: str | None = None
    mode: str | None = None
    participant_count: int | None = None
    max_capacity: int | None = None


@dataclass
class LastMessage:
    # First 200 characters of the message, on one line.
    preview: str
    sender_type: str
    sender_name: str | None
    created_at: str


@dataclass
class RoomSummary:
    room_ref: str
    name: str | None
    mode: str
    # "owner" or "member"
    role: str
    participant_count: int
    max_capacity: int | None
    connected_agents: int
    # True for the room this client is currently bound to.
    is_active_room: bool
    last_message: LastMessage | None


@dataclass
class ListRoomsResult:
    # Most recently active first.
    rooms: list[RoomSummary]
    raw: str


@dataclass
class Message:
    timestamp: str
    sender_type: str
    sender_id: str
    content: str
    # Message id, usable as a cursor. None when the server has no structured output.
    id: str | None = None


@dataclass
class GetMessagesResult:
    messages: list[Message]
    raw: str
    # Id of the newest message seen; pass as ``after`` to only get newer messages.
    next_cursor: str | None = None


@dataclass
class WaitForMessagesResult(GetMessagesResult):
    # True if no new message arrived before the timeout.
    timed_out: bool = False


@dataclass
class PostMessageResult:
    raw: str
    # The posted message. None when the server has no structured output.
    message: Message | None = None
