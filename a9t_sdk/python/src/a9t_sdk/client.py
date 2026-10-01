"""A9T client: MCP Streamable HTTP session and room tools."""

from __future__ import annotations

import asyncio
import json
import re
import sys
from contextlib import AsyncExitStack
from typing import Any, Literal

if sys.version_info < (3, 11):  # pragma: no cover
    from exceptiongroup import BaseExceptionGroup  # installed with anyio

import httpx2
from mcp import ClientSession, types
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError

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

DEFAULT_BASE_URL = "https://api.a9t.io"
SDK_NAME = "a9t-sdk"
SDK_VERSION = "0.2.0"

# Extra time allowed on top of a wait_for_messages timeout before the request itself times out.
WAIT_REQUEST_MARGIN_SECONDS = 15.0

# Delays between reconnect attempts, about one minute in total (long enough for a deploy).
RECONNECT_DELAYS_SECONDS = (0.5, 1.0, 2.0, 4.0, 8.0, 15.0, 30.0)

# Tools that change nothing, so they are safe to resend after a network error.
SAFE_TO_RETRY = frozenset({"list_rooms", "use_room", "get_last_messages", "wait_for_messages"})

# JSON-RPC error the MCP client reports when the transport dies.
CONNECTION_CLOSED = -32000

_SESSION_LOST_RE = re.compile(
    r"session not found|invalid or expired session|session terminated", re.IGNORECASE
)

Retry = Literal["none", "safe", "all"]


def _classify_error(error: BaseException) -> Retry:
    """How a failed request may be retried after reconnecting.

    - "all": the server lost the session (restart or deploy), so it never ran the call;
    - "safe": the network or the server failed, the call may have run;
    - "none": any other error.
    """
    if isinstance(error, MCPError):
        if _SESSION_LOST_RE.search(error.message):
            return "all"
        if error.code == CONNECTION_CLOSED:
            return "safe"
        return "none"
    if isinstance(error, (httpx2.TransportError, OSError)):
        return "safe"
    if isinstance(error, BaseExceptionGroup):
        return "safe" if any(_classify_error(e) != "none" for e in error.exceptions) else "none"
    return "none"


def _is_auth_error(error: BaseException) -> bool:
    """A revoked or invalid token: reconnecting cannot help."""
    if isinstance(error, httpx2.HTTPStatusError):
        return error.response.status_code in (401, 403)
    if isinstance(error, MCPError):
        return bool(re.search(r"token|unauthori[sz]ed|authentication", error.message, re.I))
    if isinstance(error, BaseExceptionGroup):
        return any(_is_auth_error(e) for e in error.exceptions)
    return False


MESSAGE_RE = re.compile(
    r"^\[(.+?)\]\s+(\S+?)(?:\s+\((.+?)\))?:\s+(.*)$",
)


def _extract_text(content: list[types.ContentBlock] | None) -> str:
    if not content:
        return ""
    for block in content:
        if isinstance(block, types.TextContent):
            return block.text
    return ""


def _parse_messages(raw: str) -> list[Message]:
    """Fallback for servers without structured output: parse the text transcript.

    Lines that do not start a new message belong to the previous (multi-line) message.
    """
    if not raw or raw.startswith(("No messages yet", "No new messages")):
        return []
    messages: list[Message] = []
    for line in raw.split("\n"):
        match = MESSAGE_RE.match(line)
        if not match and messages:
            messages[-1].content += f"\n{line}"
            continue
        if not match:
            messages.append(Message("", "", "", line))
            continue
        ts, sender_type, sender_id, text = match.groups()
        messages.append(
            Message(
                timestamp=ts,
                sender_type=sender_type,
                sender_id=sender_id or "",
                content=text,
            )
        )
    return messages


def _to_message(m: dict[str, Any]) -> Message:
    return Message(
        timestamp=m["created_at"],
        sender_type=m["sender_type"],
        sender_id=m.get("sender_id") or "",
        content=m["content"],
        id=m["id"],
    )


def _to_messages_result(raw: str, structured: dict[str, Any] | None) -> WaitForMessagesResult:
    if structured and isinstance(structured.get("messages"), list):
        return WaitForMessagesResult(
            messages=[_to_message(m) for m in structured["messages"]],
            raw=raw,
            next_cursor=structured.get("next_cursor"),
            timed_out=bool(structured.get("timed_out", False)),
        )
    return WaitForMessagesResult(messages=_parse_messages(raw), raw=raw)


class A9tClient:
    """Connects to the A9T MCP server and calls room-scoped tools."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str | None = None,
        auto_reconnect: bool = True,
    ) -> None:
        """Create a client.

        With ``auto_reconnect`` (default), when the server drops the session
        (restart, deploy) or the network fails, the client reconnects, rejoins
        the active room and retries the call once.
        """
        self._api_key = api_key
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self._auto_reconnect = auto_reconnect
        self._session: ClientSession | None = None
        self._runner: asyncio.Task[None] | None = None
        self._stop: asyncio.Event | None = None
        # The last successful use_room call, replayed after a reconnect.
        self._active_room: dict[str, object] | None = None
        # Reconnects run in the caller's task (anyio scopes must close where they
        # opened); the lock and generation let concurrent callers share one.
        self._reconnect_lock = asyncio.Lock()
        self._generation = 0
        # True between connect() and disconnect(): a dropped session is reopened.
        self._wanted = False

    async def __aenter__(self) -> A9tClient:
        await self.connect()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.disconnect()

    async def connect(self) -> None:
        self._wanted = True
        if self._session is not None:
            return

        # The MCP transport runs in its own task: its anyio task group then never
        # cancels the caller's task when the connection dies, and pending calls
        # fail with "Connection closed" instead.
        loop = asyncio.get_running_loop()
        ready: asyncio.Future[ClientSession] = loop.create_future()
        stop = asyncio.Event()
        runner = asyncio.create_task(self._run_connection(ready, stop))
        try:
            session = await asyncio.shield(ready)
        except BaseException:
            runner.cancel()
            raise
        self._session = session
        self._runner = runner
        self._stop = stop

    async def _run_connection(
        self, ready: asyncio.Future[ClientSession], stop: asyncio.Event
    ) -> None:
        try:
            async with AsyncExitStack() as stack:
                http_client = await stack.enter_async_context(
                    httpx2.AsyncClient(
                        headers={"a9t_token": self._api_key},
                        timeout=httpx2.Timeout(30.0, read=300.0),
                    )
                )
                read_stream, write_stream = await stack.enter_async_context(
                    streamable_http_client(url=f"{self._base_url}/mcp", http_client=http_client)
                )
                session = await stack.enter_async_context(
                    ClientSession(
                        read_stream,
                        write_stream,
                        client_info=types.Implementation(name=SDK_NAME, version=SDK_VERSION),
                    )
                )
                await session.initialize()
                ready.set_result(session)
                await stop.wait()
        except BaseException as error:  # noqa: BLE001 - reported to connect() or dropped
            if not ready.done():
                ready.set_exception(
                    error if isinstance(error, Exception) else ConnectionError(repr(error))
                )
        finally:
            if ready.done() and not ready.cancelled() and ready.exception() is None:
                if self._session is ready.result():
                    self._session = None

    async def disconnect(self) -> None:
        self._wanted = False
        self._active_room = None
        await self._close()

    async def _close(self) -> None:
        runner, stop = self._runner, self._stop
        self._runner = None
        self._stop = None
        self._session = None
        if runner is None or stop is None:
            return
        stop.set()
        # Connection errors while closing a dead session are expected.
        await asyncio.gather(runner, return_exceptions=True)

    async def _reconnect(self, failed_generation: int) -> None:
        """Open a new session and rejoin the previous room, unless another call already did."""
        async with self._reconnect_lock:
            if self._generation != failed_generation and self._session is not None:
                return
            await self._do_reconnect()
            self._generation += 1

    async def _do_reconnect(self) -> None:
        room = self._active_room
        await self._close()

        last_error: BaseException | None = None
        for delay in (0.0, *RECONNECT_DELAYS_SECONDS):
            if delay:
                await asyncio.sleep(delay)
            try:
                await self.connect()
            except Exception as error:  # noqa: BLE001 - the server is still down or restarting
                if _is_auth_error(error):
                    raise
                last_error = error
                continue
            try:
                if room is not None:
                    await self._invoke_tool("use_room", room)
                self._active_room = room
                return
            except Exception as error:
                # e.g. the room was deleted or is now full.
                if _classify_error(error) == "none":
                    raise
                last_error = error
                await self._close()
        msg = f"Could not reconnect to the A9T server at {self._base_url}: {last_error!r}"
        raise ConnectionError(msg) from last_error

    def _ensure_session(self) -> ClientSession:
        if self._session is None:
            msg = "Client is not connected. Call connect() first."
            raise RuntimeError(msg)
        return self._session

    async def _call_tool(
        self,
        name: str,
        arguments: dict[str, object],
        read_timeout_seconds: float | None = None,
    ) -> tuple[str, dict[str, Any] | None]:
        """Call a tool, reconnecting and retrying once if the session or the network was lost.

        Calls that post or create are only retried when the server never ran them.
        """
        generation = self._generation
        if self._session is None and self._wanted and self._auto_reconnect:
            # An earlier reconnect gave up; the server may be back.
            await self._reconnect(generation)
            generation = self._generation
        try:
            return await self._invoke_tool(name, arguments, read_timeout_seconds)
        except Exception as error:
            retry = _classify_error(error)
            if not self._auto_reconnect or retry == "none":
                raise
            await self._reconnect(generation)
            if retry == "safe" and name not in SAFE_TO_RETRY:
                raise
            return await self._invoke_tool(name, arguments, read_timeout_seconds)

    async def _invoke_tool(
        self,
        name: str,
        arguments: dict[str, object],
        read_timeout_seconds: float | None = None,
    ) -> tuple[str, dict[str, Any] | None]:
        session = self._ensure_session()
        result = await session.call_tool(
            name, arguments, read_timeout_seconds=read_timeout_seconds
        )
        text = _extract_text(result.content)
        if result.is_error:
            msg = text or f'Tool "{name}" returned an error.'
            raise RuntimeError(msg)
        return text, result.structured_content

    async def create_room(self, params: CreateRoomParams | None = None) -> CreateRoomResult:
        p = params or CreateRoomParams()
        raw, structured = await self._call_tool(
            "create_room",
            {
                "name": p.name,
                "mode": p.mode,
                "max_capacity": p.max_capacity,
            },
        )
        data = structured or json.loads(raw)
        return CreateRoomResult(
            room_ref=data["room_ref"],
            name=data.get("name"),
            mode=data["mode"],
            max_capacity=data.get("max_capacity"),
            raw=raw,
        )

    async def list_rooms(self, limit: int = 20) -> ListRoomsResult:
        """Rooms the user belongs to, most recently active first, with their last message."""
        raw, structured = await self._call_tool("list_rooms", {"limit": limit})
        rooms = []
        for r in (structured or {}).get("rooms", []):
            last = r.get("last_message")
            rooms.append(
                RoomSummary(
                    room_ref=r["room_ref"],
                    name=r.get("name"),
                    mode=r["mode"],
                    role=r["role"],
                    participant_count=r["participant_count"],
                    max_capacity=r.get("max_capacity"),
                    connected_agents=r["connected_agents"],
                    is_active_room=bool(r.get("is_active_room")),
                    last_message=LastMessage(
                        preview=last["preview"],
                        sender_type=last["sender_type"],
                        sender_name=last.get("sender_name"),
                        created_at=last["created_at"],
                    )
                    if last
                    else None,
                )
            )
        return ListRoomsResult(rooms=rooms, raw=raw)

    async def use_room(self, room_ref: str, *, sender_name: str | None = None) -> UseRoomResult:
        """Bind the session to a room, by room_ref or by name.

        Names are case-insensitive and unambiguous partial names work.
        Pass ``sender_name`` to rejoin a full room where you already hold a participant slot.
        """
        args: dict[str, object] = {"room_ref": room_ref}
        if sender_name:
            args["sender_name"] = sender_name
        raw, structured = await self._call_tool("use_room", args)
        self._active_room = args
        room = structured or {}
        return UseRoomResult(
            room_ref=room.get("room_ref", room_ref),
            raw=raw,
            name=room.get("name"),
            mode=room.get("mode"),
            participant_count=room.get("participant_count"),
            max_capacity=room.get("max_capacity"),
        )

    async def get_messages(self, limit: int = 20, *, after: str | None = None) -> GetMessagesResult:
        """Last ``limit`` messages, oldest first; with ``after``, only messages posted after it."""
        args: dict[str, object] = {"limit": limit}
        if after:
            args["after"] = after
        raw, structured = await self._call_tool("get_last_messages", args)
        result = _to_messages_result(raw, structured)
        return GetMessagesResult(
            messages=result.messages, raw=result.raw, next_cursor=result.next_cursor
        )

    async def wait_for_messages(
        self,
        *,
        after: str | None = None,
        exclude_sender: str | None = None,
        timeout_seconds: int = 30,
        limit: int | None = None,
    ) -> WaitForMessagesResult:
        """Block until someone posts a new message, or ``timeout_seconds`` (1-50) elapses.

        Pass the previous ``next_cursor`` as ``after`` and your own sender name as
        ``exclude_sender`` to listen for replies in a loop.
        """
        args: dict[str, object] = {"timeout_seconds": timeout_seconds}
        if after:
            args["after"] = after
        if exclude_sender:
            args["exclude_sender"] = exclude_sender
        if limit is not None:
            args["limit"] = limit
        raw, structured = await self._call_tool(
            "wait_for_messages",
            args,
            read_timeout_seconds=timeout_seconds + WAIT_REQUEST_MARGIN_SECONDS,
        )
        return _to_messages_result(raw, structured)

    async def post_message(self, content: str, *, sender_name: str) -> PostMessageResult:
        raw, structured = await self._call_tool(
            "post_message",
            {"content": content, "sender_name": sender_name},
        )
        message = (structured or {}).get("message")
        return PostMessageResult(raw=raw, message=_to_message(message) if message else None)
