import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface RoomInfo {
  id: string;
  roomRef: string;
  name: string | null;
  mode: string;
  max_capacity: number | null;
  agent_count: number;
  participant_count: number;
}

export function createSupabaseClient(
  url: string,
  serviceRoleKey: string
): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

export async function getRoomId(
  supabase: SupabaseClient,
  roomRef: string
): Promise<RoomInfo | null> {
  const { data, error } = await supabase
    .from("rooms")
    .select("id, room_ref, name, mode, max_capacity, agent_count, participant_count")
    .eq("room_ref", roomRef)
    .maybeSingle();

  if (error || !data) return null;
  return {
    id: data.id,
    roomRef: data.room_ref,
    name: data.name,
    mode: data.mode,
    max_capacity: data.max_capacity,
    agent_count: data.agent_count,
    participant_count: data.participant_count ?? 0,
  };
}

export async function isRoomFull(
  supabase: SupabaseClient,
  roomId: string
): Promise<{ full: boolean; participantCount: number; maxCapacity: number | null }> {
  const { data, error } = await supabase
    .from("rooms")
    .select("max_capacity, participant_count")
    .eq("id", roomId)
    .single();

  if (error || !data)
    return { full: true, participantCount: 0, maxCapacity: null };

  const max = data.max_capacity as number | null;
  const count = (data.participant_count as number) ?? 0;

  if (max === null) return { full: false, participantCount: count, maxCapacity: null };
  return { full: count >= max, participantCount: count, maxCapacity: max };
}

/**
 * Sessions whose last heartbeat is older than this are ignored: they were left
 * behind by a crash or a deploy (the server heartbeats every minute, and the
 * cleanup-stale-agents cron job deletes them after the same delay).
 */
const STALE_SESSION_MS = 3 * 60 * 1000;

/**
 * Returns true if this session is among the first `max_capacity` live agent
 * sessions (by connected_at). Used to enforce capacity after it has been reduced.
 */
export async function isSessionWithinCapacity(
  supabase: SupabaseClient,
  roomId: string,
  sessionId: string
): Promise<boolean> {
  const { data: room } = await supabase
    .from("rooms")
    .select("max_capacity")
    .eq("id", roomId)
    .single();

  if (!room) return false;
  const max = room.max_capacity as number | null;
  if (max === null) return true;

  const { data: agents } = await supabase
    .from("room_agents")
    .select("session_id")
    .eq("room_id", roomId)
    .gte("last_heartbeat", new Date(Date.now() - STALE_SESSION_MS).toISOString())
    .order("connected_at", { ascending: true })
    .limit(max);

  if (!agents) return false;
  return agents.some((a) => a.session_id === sessionId);
}

/**
 * True if `participantId` (an agent sender_name or a user id) already holds a
 * participant slot in the room, i.e. has posted there before.
 */
export async function isRoomParticipant(
  supabase: SupabaseClient,
  roomId: string,
  participantId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("room_participants")
    .select("id")
    .eq("room_id", roomId)
    .eq("participant_id", participantId)
    .maybeSingle();
  return data != null;
}

export async function registerRoomAgent(
  supabase: SupabaseClient,
  roomId: string,
  sessionId: string
): Promise<boolean> {
  const { error } = await supabase
    .from("room_agents")
    .upsert(
      { room_id: roomId, session_id: sessionId, last_heartbeat: new Date().toISOString() },
      { onConflict: "room_id,session_id" }
    );
  return !error;
}

export async function removeRoomAgent(
  supabase: SupabaseClient,
  roomId: string,
  sessionId: string
): Promise<void> {
  await supabase
    .from("room_agents")
    .delete()
    .eq("room_id", roomId)
    .eq("session_id", sessionId);
}

export interface CreateRoomParams {
  name?: string | null;
  mode?: string;
  maxCapacity?: number | null;
}

export interface CreateRoomResult {
  id: string;
  roomRef: string;
  name: string | null;
  mode: string;
  maxCapacity: number | null;
}

export async function createRoom(
  supabase: SupabaseClient,
  params: CreateRoomParams,
  userId: string
): Promise<{ ok: true; room: CreateRoomResult } | { ok: false; error: string }> {
  const { name = null, mode = "intervention", maxCapacity = null } = params;

  const { data, error } = await supabase
    .from("rooms")
    .insert({
      created_by: userId,
      name,
      mode,
      max_capacity: maxCapacity ?? 10,
    })
    .select("id, room_ref, name, mode, max_capacity")
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Failed to create room." };
  }

  return {
    ok: true,
    room: {
      id: data.id,
      roomRef: data.room_ref,
      name: data.name,
      mode: data.mode,
      maxCapacity: data.max_capacity,
    },
  };
}

export interface UserRoom {
  roomId: string;
  roomRef: string;
  name: string | null;
  mode: string;
  role: string;
  participantCount: number;
  maxCapacity: number | null;
  agentCount: number;
  lastMessage: {
    content: string;
    senderType: string;
    senderName: string | null;
    createdAt: string;
  } | null;
}

/** Rooms the user is a member of, most recently active first (list_user_rooms RPC). */
export async function listUserRooms(
  supabase: SupabaseClient,
  userId: string,
  limit: number
): Promise<UserRoom[] | null> {
  const { data, error } = await supabase.rpc("list_user_rooms", {
    p_user_id: userId,
    p_limit: limit,
  });
  if (error) {
    console.error("list_user_rooms error:", error.message);
    return null;
  }
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    roomId: r.room_id as string,
    roomRef: r.room_ref as string,
    name: (r.name as string | null) ?? null,
    mode: r.mode as string,
    role: r.role as string,
    participantCount: (r.participant_count as number | null) ?? 0,
    maxCapacity: (r.max_capacity as number | null) ?? null,
    agentCount: (r.agent_count as number | null) ?? 0,
    lastMessage: r.last_message_at
      ? {
          content: r.last_message_content as string,
          senderType: r.last_message_sender_type as string,
          senderName: (r.last_message_sender_name as string | null) ?? null,
          createdAt: r.last_message_at as string,
        }
      : null,
  }));
}

const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

export type RoomLookup =
  | { ok: true; room: RoomInfo }
  | { ok: false; error: string };

/**
 * Find a room by room_ref, or else by name among the user's rooms: an exact
 * (case-insensitive) name first, then a unique partial match. Ambiguous names
 * return the candidates so the agent can ask which one was meant.
 */
export async function findRoom(
  supabase: SupabaseClient,
  userId: string,
  query: string
): Promise<RoomLookup> {
  const byRef = await getRoomId(supabase, query.trim());
  if (byRef) return { ok: true, room: byRef };

  const rooms = await listUserRooms(supabase, userId, 200);
  if (!rooms) return { ok: false, error: "Failed to look up your rooms." };

  const wanted = normalizeName(query);
  const named = rooms.filter((r) => r.name);
  const exact = named.filter((r) => normalizeName(r.name!) === wanted);
  const candidates = exact.length > 0
    ? exact
    : named.filter((r) => normalizeName(r.name!).includes(wanted));

  if (candidates.length === 1) {
    const room = await getRoomId(supabase, candidates[0].roomRef);
    return room ? { ok: true, room } : { ok: false, error: `Room not found: ${query}` };
  }
  if (candidates.length > 1) {
    const list = candidates
      .slice(0, 10)
      .map((r) => `- "${r.name}" (room_ref: ${r.roomRef})`)
      .join("\n");
    return {
      ok: false,
      error: `Several of your rooms match "${query}". Ask the user which one, then call use_room with its room_ref:\n${list}`,
    };
  }
  return {
    ok: false,
    error: `No room found with the id or name "${query}". Call list_rooms to see the rooms you can join.`,
  };
}
