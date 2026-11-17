import { MqttPushChannel, type MqttCredentials } from "./mqtt-push";
import { describeError } from "../orchestration/diagnostics";

/**
 * Cloud push channel for online mode (MQTT).
 *
 * Purpose: when another device (e.g. a phone) sends a message to an agent on this computer via the cloud, the server notifies over this long-lived connection,
 * and the desktop pulls it and hands it to the local agent. Being connected is also how the cloud decides "this computer is online".
 *
 * A push is only a "something new" signal; actual data is always pulled from the API by cursor:
 * lost pushes or ones missed while disconnected are filled in by one catch-up after reconnecting.
 */

export interface CloudPushOptions {
  /** Fetch fresh MQTT credentials before each connect; if unavailable or disabled on the server, retry with backoff; there is no fallback channel */
  credentials: () => Promise<MqttCredentials>;
  /** A task has new messages */
  onConversationChanged: (conversationId: string) => void;
  /** Called after every connect (including reconnects): fill in what was missed while disconnected */
  onConnected: () => void;
  /** The task itself changed (rename, members, status, etc.), not just new messages */
  onConversationUpdated?: (conversationId: string) => void;
  /** The account's agents or their online/ready state changed (computers going on/offline, a computer publishing new state) */
  onAgentsChanged?: () => void;
  /** The server confirmed the owner's request: detect only the corresponding Agent on this computer. */
  onAgentVerificationRequested?: (agentUserId: string) => void;
  /** Friends or friend requests changed (request received, accepted, removed) */
  onFriendsChanged?: () => void;
  onConversationControl?: (type: string, payload: unknown) => void;
  /** Other computers on the same account reading/setting local Agent models, and replies to requests sent from here */
  onAgentModelRelay?: (type: string, payload: unknown) => void;
  /** Execution progress of agents on other computers: start/end of a turn, a line of the activity feed (server only relays, doesn't persist) */
  onTurnProgress?: (payload: unknown) => void;
  /** Disconnected from the server. Other computers' execution progress is no longer trustworthy; the caller clears it */
  onDisconnected?: () => void;
  log: (event: string, data: Record<string, unknown>) => Promise<void> | void;
  /** Max reconnect interval after disconnect, default 30 seconds */
  maxRetryMs?: number;
}

interface Frame {
  type?: string;
  frameId?: number;
  payload?: { conversationId?: unknown; agentUserId?: unknown; seq?: unknown; messageId?: unknown };
}

/** An in-progress credential renewal; channel is the replacement connection being established */
interface Renewal { channel?: MqttPushChannel }

export class CloudPush {
  private mqtt: MqttPushChannel | undefined;
  private renewal: Renewal | undefined;
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = false;
  private paused = false;

  constructor(private readonly options: CloudPushOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.generation++;
    this.closeChannels();
  }

  /**
   * The computer is going to sleep: disconnect MQTT cleanly (the server marks this computer offline on disconnect and notifies other devices,
   * without waiting for keepalive timeout), and don't reconnect before resume(). During sleep, DarkWake runs the process briefly;
   * reconnecting then would make other devices see it online and dispatch work, only for it to freeze again.
   */
  pause(): void {
    if (this.paused || this.stopped) return;
    this.paused = true;
    const hadMqtt = Boolean(this.mqtt || this.renewal);
    clearTimeout(this.timer);
    this.generation++;
    this.closeChannels();
    void this.options.log("cloud-push-paused", { connected: hadMqtt });
    if (hadMqtt) this.options.onDisconnected?.();
  }

  /** Reconnect immediately after waking (skip backoff); onConnected will pull once after connecting */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.attempt = 0;
    if (!this.stopped && !this.mqtt && !this.renewal) this.connect();
  }

  /**
   * Send a frame to the server (e.g. local agent execution progress). If not connected, drop it and return false:
   * execution progress is only a live display; nothing missed during disconnects needs replay, the next report is authoritative after reconnect.
   */
  send(type: string, payload: Record<string, unknown>): boolean {
    return this.mqtt?.send(type, payload) ?? false;
  }

  private connect(): void {
    if (this.stopped || this.paused) return;
    const generation = ++this.generation;
    void this.options.credentials().then(credentials => {
      if (generation !== this.generation || this.stopped || this.paused) return;
      if (!credentials.enabled) {
        void this.options.log("cloud-mqtt-disabled", { attempt: this.attempt });
        this.retry();
        return;
      }
      const channel = this.createChannel(credentials);
      this.mqtt = channel;
      try { channel.start(); }
      catch (error) {
        channel.stop(); this.mqtt = undefined; this.retry();
        void this.options.log("cloud-mqtt-start-failed", { reason: describeError(error) });
      }
    }).catch(error => {
      if (generation !== this.generation || this.stopped || this.paused) return;
      void this.options.log("cloud-mqtt-credentials-failed", { attempt: this.attempt, reason: describeError(error) }); this.retry();
    });
  }

  /**
   * Credentials about to expire: connect and subscribe with new credentials first, then close the old connection. This isn't a disconnect in between,
   * so onDisconnected isn't called — otherwise in-flight pause/resume requests would be judged failed and other computers' busy state cleared.
   * The server pins the clientId per terminal; when the new connection comes online the broker kicks the old one, and that close isn't a disconnect either;
   * only a failed replacement connection is treated as a real disconnect.
   */
  private renew(current: MqttPushChannel): void {
    if (this.mqtt !== current || this.renewal || this.stopped || this.paused) return;
    const generation = this.generation;
    const renewal: Renewal = {};
    this.renewal = renewal;
    void this.options.credentials().then(credentials => {
      if (generation !== this.generation || this.renewal !== renewal) return;
      if (!credentials.enabled) { this.failRenewal(renewal, "disabled"); return; }
      const channel = this.createChannel(credentials, renewal);
      renewal.channel = channel;
      try { channel.start(); }
      catch { this.failRenewal(renewal, "start-failed"); }
    }).catch(() => {
      if (generation === this.generation) this.failRenewal(renewal, "credentials-failed");
    });
  }

  private failRenewal(renewal: Renewal, reason: string): void {
    if (this.renewal !== renewal) return;
    this.renewal = undefined;
    renewal.channel?.stop();
    this.mqtt?.stop();
    this.mqtt = undefined;
    void this.options.log("cloud-mqtt-renew-failed", { reason });
    this.options.onDisconnected?.(); this.retry();
  }

  private createChannel(credentials: MqttCredentials, renewal?: Renewal): MqttPushChannel {
    const channel: MqttPushChannel = new MqttPushChannel(credentials, {
      connected: () => {
        if (renewal && this.renewal === renewal) {
          this.renewal = undefined;
          const retired = this.mqtt;
          this.mqtt = channel;
          retired?.stop();
          void this.options.log("cloud-mqtt-renewed", {});
        }
        // Also pull once after renewal: pushes may have been missed in the handover gap between old and new connections
        if (this.mqtt === channel) { this.attempt = 0; this.options.onConnected(); }
      },
      message: raw => { if (this.mqtt === channel) this.handle(raw); },
      error: reason => { void this.options.log("cloud-mqtt-error", { reason }); },
      renew: () => this.renew(channel),
      closed: phase => {
        if (renewal && this.renewal === renewal) { this.failRenewal(renewal, `closed while ${phase}`); return; }
        if (this.mqtt !== channel) return;
        this.mqtt = undefined;
        // Kicked by the new connection during renewal: wait for the replacement result, not a disconnect
        if (this.renewal) { void this.options.log("cloud-mqtt-replaced", {}); return; }
        void this.options.log("cloud-mqtt-closed", { phase });
        this.options.onDisconnected?.(); this.retry();
      }
    });
    return channel;
  }

  private closeChannels(): void {
    this.renewal?.channel?.stop();
    this.renewal = undefined;
    this.mqtt?.stop();
    this.mqtt = undefined;
  }

  private handle(raw: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      void this.options.log("cloud-push-bad-frame", { raw: raw.slice(0, 500) });
      return;
    }
    // Execution progress comes several times per second, so don't log each one; the caller logs busy/idle changes
    if (frame.type === "TURN_PROGRESS") {
      this.options.onTurnProgress?.(frame.payload);
      return;
    }
    if (frame.type === "CONVERSATION_CONTROL" || frame.type === "CONVERSATION_CONTROL_ACCEPTED" || frame.type === "CONVERSATION_CONTROL_RESULT") {
      this.options.onConversationControl?.(frame.type, frame.payload);
      return;
    }
    if (frame.type === "AGENT_MODEL_REQUEST" || frame.type === "AGENT_MODEL_RESULT") {
      this.options.onAgentModelRelay?.(frame.type, frame.payload);
      return;
    }
    const conversationId = frame.payload?.conversationId;
    void this.options.log("cloud-push-frame", {
      type: frame.type,
      frameId: frame.frameId,
      conversationId,
      seq: frame.payload?.seq,
      messageId: frame.payload?.messageId
    });
    if ((frame.type === "MESSAGE_NEW" || frame.type === "CONVERSATION_UPDATED") && typeof conversationId === "string") {
      this.options.onConversationChanged(conversationId);
    }
    if (frame.type === "CONVERSATION_UPDATED" && typeof conversationId === "string") this.options.onConversationUpdated?.(conversationId);
    if (frame.type === "AGENTS_CHANGED") this.options.onAgentsChanged?.();
    if (frame.type === "AGENT_VERIFY_REQUEST" && typeof frame.payload?.agentUserId === "string") {
      this.options.onAgentVerificationRequested?.(frame.payload.agentUserId);
    }
    if (frame.type === "FRIENDS_CHANGED") this.options.onFriendsChanged?.();
  }

  private retry(): void {
    if (this.stopped || this.paused) return;
    clearTimeout(this.timer);
    const wait = Math.min(1_000 * 2 ** this.attempt, this.options.maxRetryMs ?? 30_000);
    this.attempt += 1;
    this.timer = setTimeout(() => this.connect(), wait);
    this.timer.unref?.();
  }
}
