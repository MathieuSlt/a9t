import type { SupabaseClient } from "@supabase/supabase-js";

import type { MessageNotifier } from "./notifier.js";

const MESSAGE_COLUMNS = "id, sender_type, sender_id, content, created_at";

/** Delay between polls while wait_for_messages is blocking and Realtime is down. */
const WAIT_POLL_INTERVAL_MS = 1500;

/** With Realtime up, still re-read this often in case an event was lost. */
const WAIT_SAFETY_REFETCH_MS = 15_000;

export interface MessageRow {
  id: string;
  sender_type: string;
  sender_id: string | null;
  content: string;
  created_at: string;
}

interface Cursor {
  id: string;
  createdAt: string;
}

export type MessagesResult =
  | { ok: true; messages: MessageRow[]; cursor: string | null }
  | { ok: false; error: string };

/**
 * Human-readable transcript, one line per message.
 * The line format is kept stable for agents and older SDKs that read the text.
 */
export function formatMessages(messages: MessageRow[]): string {
  return messages
    .map((m) => {
      const suffix = m.sender_id ? ` (${m.sender_id})` : "";
      return `[${m.created_at}] ${m.sender_type}${suffix}: ${m.content}`;
    })
    .join("\n");
}

/** Last `limit` messages of a room, oldest first. */
export async function getLatestMessages(
  supabase: SupabaseClient,
  roomId: string,
  limit: number,
): Promise<MessagesResult> {
  const { data, error } = await supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getLatestMessages query error:", error.message);
    return { ok: false, error: "Failed to fetch messages." };
  }
  const messages = ((data ?? []) as MessageRow[]).reverse();
  return { ok: true, messages, cursor: messages.at(-1)?.id ?? null };
}

async function resolveCursor(
  supabase: SupabaseClient,
  roomId: string,
  messageId: string,
): Promise<Cursor | null> {
  const { data } = await supabase
    .from("messages")
    .select("id, created_at")
    .eq("room_id", roomId)
    .eq("id", messageId)
    .maybeSingle();
  return data ? { id: data.id, createdAt: data.created_at } : null;
}

async function fetchAfter(
  supabase: SupabaseClient,
  roomId: string,
  cursor: Cursor | null,
  limit: number,
): Promise<MessageRow[] | null> {
  let query = supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("room_id", roomId);
  if (cursor) query = query.gt("created_at", cursor.createdAt);
  const { data, error } = await query
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("fetchAfter query error:", error.message);
    return null;
  }
  return (data ?? []) as MessageRow[];
}

/** Up to `limit` messages posted after the message `afterId`, oldest first. */
export async function getMessagesAfter(
  supabase: SupabaseClient,
  roomId: string,
  afterId: string,
  limit: number,
): Promise<MessagesResult> {
  const cursor = await resolveCursor(supabase, roomId, afterId);
  if (!cursor) {
    return { ok: false, error: `Unknown cursor: no message ${afterId} in this room.` };
  }
  const rows = await fetchAfter(supabase, roomId, cursor, limit);
  if (!rows) return { ok: false, error: "Failed to fetch messages." };
  return { ok: true, messages: rows, cursor: rows.at(-1)?.id ?? afterId };
}

/** Resolves after `ms`, when `wake` is called, or when `signal` aborts. */
function sleepUntilWoken(
  ms: number,
  signal: AbortSignal | undefined,
  onWake: (wake: () => void) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    onWake(done);
  });
}

export interface WaitOptions {
  /** Only return messages after this message id; defaults to the current latest message. */
  afterId: string | null;
  limit: number;
  timeoutMs: number;
  /** Ignore messages from this sender (typically the caller's own sender_name). */
  excludeSender: string | null;
  signal?: AbortSignal;
}

/**
 * Block until at least one new message (not from `excludeSender`) arrives,
 * the timeout elapses, or the request is cancelled.
 *
 * Realtime inserts wake the wait; the database is only read again then (or
 * every WAIT_SAFETY_REFETCH_MS). If Realtime is down, it polls every
 * WAIT_POLL_INTERVAL_MS instead.
 */
export async function waitForMessages(
  supabase: SupabaseClient,
  notifier: MessageNotifier,
  roomId: string,
  opts: WaitOptions,
): Promise<MessagesResult & { timedOut?: boolean }> {
  // Listen before the first read, so an insert landing in between is not missed.
  let pending = false;
  let wake: (() => void) | null = null;
  const unsubscribe = notifier.subscribe(roomId, () => {
    pending = true;
    wake?.();
  });

  try {
    let cursor: Cursor | null;
    if (opts.afterId) {
      cursor = await resolveCursor(supabase, roomId, opts.afterId);
      if (!cursor) {
        return { ok: false, error: `Unknown cursor: no message ${opts.afterId} in this room.` };
      }
    } else {
      const { data } = await supabase
        .from("messages")
        .select("id, created_at")
        .eq("room_id", roomId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      cursor = data ? { id: data.id, createdAt: data.created_at } : null;
    }

    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      pending = false;
      const rows = await fetchAfter(supabase, roomId, cursor, opts.limit);
      if (!rows) return { ok: false, error: "Failed to fetch messages." };

      const last = rows.at(-1);
      if (last) cursor = { id: last.id, createdAt: last.created_at };

      const visible = opts.excludeSender
        ? rows.filter((m) => m.sender_id !== opts.excludeSender)
        : rows;
      if (visible.length > 0) {
        return { ok: true, messages: visible, cursor: cursor?.id ?? null, timedOut: false };
      }
      // A full page of filtered-out messages: keep reading without sleeping.
      if (rows.length === opts.limit) continue;

      const remaining = deadline - Date.now();
      if (remaining <= 0 || opts.signal?.aborted) {
        return { ok: true, messages: [], cursor: cursor?.id ?? null, timedOut: true };
      }
      // An insert arrived while reading: read again right away.
      if (pending) continue;

      const interval = notifier.isLive ? WAIT_SAFETY_REFETCH_MS : WAIT_POLL_INTERVAL_MS;
      await sleepUntilWoken(Math.min(interval, remaining), opts.signal, (done) => {
        wake = done;
      });
      wake = null;
    }
  } finally {
    unsubscribe();
  }
}
