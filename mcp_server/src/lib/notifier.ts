import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

type Listener = () => void;

/**
 * Wakes wait_for_messages callers when a message is inserted in their room.
 *
 * One Supabase Realtime subscription on `messages` for the whole process
 * (service role, so every room), fanned out to per-room listeners. Listeners
 * then read the new rows from the database: the event only says "look now".
 * While the channel is not subscribed, callers fall back to polling.
 */
export class MessageNotifier {
  private readonly listeners = new Map<string, Set<Listener>>();
  private channel: RealtimeChannel | null = null;
  private live = false;

  constructor(private readonly supabase: SupabaseClient) {}

  start(): void {
    this.channel = this.supabase
      .channel("mcp-server:messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const roomId = (payload.new as { room_id?: string }).room_id;
          if (roomId) this.notify(roomId);
        },
      )
      .subscribe((status, err) => {
        const wasLive = this.live;
        this.live = status === "SUBSCRIBED";
        if (this.live !== wasLive) {
          console.error(
            `Message notifier ${this.live ? "subscribed" : `not subscribed (${status})`}`,
            err?.message ?? "",
          );
        }
        // Inserts made while the channel was down were never delivered.
        if (this.live && !wasLive) this.notifyAll();
      });
  }

  async stop(): Promise<void> {
    if (this.channel) await this.supabase.removeChannel(this.channel);
    this.channel = null;
    this.live = false;
  }

  /** True while inserts are being delivered; otherwise callers should poll. */
  get isLive(): boolean {
    return this.live;
  }

  /** Call `listener` on every insert in `roomId` until the returned function is called. */
  subscribe(roomId: string, listener: Listener): () => void {
    let set = this.listeners.get(roomId);
    if (!set) {
      set = new Set();
      this.listeners.set(roomId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(roomId);
    };
  }

  private notify(roomId: string): void {
    for (const listener of this.listeners.get(roomId) ?? []) listener();
  }

  private notifyAll(): void {
    for (const set of this.listeners.values()) {
      for (const listener of set) listener();
    }
  }
}
