import { connect, type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import { describeError } from "../orchestration/diagnostics";

export interface MqttCredentials {
  enabled: boolean;
  terminalId: string;
  brokerUrl: string;
  clientId: string;
  username: string;
  password: string;
  subscriptions: string[];
  reportTopic: string;
  expiresAt: number;
  keepAliveSeconds: number;
}

/**
 * One clean session; CloudPush owns retries and fetches fresh credentials each time.
 * Before the credentials expire the channel asks CloudPush to renew instead of closing itself,
 * so CloudPush can connect the replacement first and retire this one without a disconnect.
 */
export class MqttPushChannel {
  private client: MqttClient | undefined;
  private ready = false;
  private stopped = false;
  private renewal: NodeJS.Timeout | undefined;
  private sequence = 0;
  private phase: "connecting" | "subscribing" | "ready" = "connecting";
  constructor(private readonly credentials: MqttCredentials, private readonly callbacks: {
    connected: () => void;
    message: (raw: string) => void;
    /** phase: which step it stopped at when disconnected. When the peer drops directly (e.g. rejected subscription) there's no error event; this shows where it got stuck */
    closed: (phase: "connecting" | "subscribing" | "ready") => void;
    /** reason goes only into logs: error name, message, and cause chain, no credentials */
    error: (reason: string) => void;
    renew: () => void;
  }) {}

  start(): void {
    const c = this.credentials;
    if (!c.brokerUrl.startsWith("mqtts://") || c.expiresAt <= Date.now() || !c.subscriptions?.length)
      throw new Error("Invalid MQTT credentials");
    const client = connect(c.brokerUrl, {
      clientId: c.clientId, username: c.username, password: c.password,
      protocolVersion: 4, clean: true, keepalive: c.keepAliveSeconds,
      reconnectPeriod: 0, connectTimeout: 15_000, rejectUnauthorized: true,
      queueQoSZero: false, resubscribe: false
    });
    this.client = client;
    client.on("connect", () => {
      if (this.stopped) return;
      this.phase = "subscribing";
      const topics = Object.fromEntries(c.subscriptions.map(topic => [topic, { qos: 1 as const }]));
      client.subscribe(topics, (error, granted) => {
        if (this.stopped) return;
        if (error || !granted || granted.length !== c.subscriptions.length || granted.some(g => g.qos === 128)) {
          const rejected = granted?.filter(g => g.qos === 128).map(g => g.topic) ?? [];
          this.callbacks.error(error ? `subscribe: ${describeError(error)}`
            : `subscribe rejected: ${granted?.length ?? 0}/${c.subscriptions.length} granted${rejected.length ? `, denied ${rejected.join(",")}` : ""}`);
          client.end(true); return;
        }
        this.ready = true;
        this.phase = "ready";
        this.renewal = setTimeout(() => { if (!this.stopped) this.callbacks.renew(); }, Math.max(1000, c.expiresAt - Date.now() - 90_000));
        this.renewal.unref?.();
        this.callbacks.connected();
      });
    });
    client.on("message", (topic, payload) => {
      if (!this.stopped && c.subscriptions.includes(topic)) this.callbacks.message(payload.toString("utf8"));
    });
    client.on("error", error => { if (!this.stopped) { this.callbacks.error(describeError(error)); client.end(true); } });
    client.on("close", () => {
      this.ready = false; clearTimeout(this.renewal);
      if (!this.stopped) { this.stopped = true; this.callbacks.closed(this.phase); }
    });
  }
  send(type: string, payload: Record<string, unknown>): boolean {
    if (!this.ready || !this.client?.connected || this.stopped) return false;
    this.sequence = Math.max(Date.now() * 1000, this.sequence + 1);
    this.client.publish(this.credentials.reportTopic, JSON.stringify({
      type, payload, eventId: randomUUID(), sentAt: this.sequence
    }), { qos: 1, retain: false }, error => { if (error && !this.stopped) this.callbacks.error(`publish: ${describeError(error)}`); });
    return true;
  }
  stop(): void {
    this.stopped = true; this.ready = false; clearTimeout(this.renewal);
    this.client?.end(false); this.client = undefined;
  }
}
