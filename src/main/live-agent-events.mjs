import { randomUUID } from 'node:crypto';

export const LIVE_AGENT_EVENT_SCHEMA = 'mcf-live-agent-event/v1';
export const LIVE_AGENT_EVENT_SNAPSHOT_SCHEMA = 'mcf-live-agent-event-snapshot/v1';

const DEFAULT_EVENT_LIMIT = 4096;
const DEFAULT_HEARTBEAT_MS = 10000;
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function eventName(value) {
  const normalized = String(value || 'message')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return normalized || 'message';
}

function parseCursor(value, currentBootId, currentSequence) {
  if (value == null || value === '') {
    return { sequence: 0, resetReason: null };
  }

  const text = String(value).trim();
  const match = text.match(/^([^:]+):(\d+)$/);
  if (!match) return { sequence: 0, resetReason: 'cursor_unknown' };
  if (match[1] !== currentBootId) return { sequence: 0, resetReason: 'boot_changed' };

  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > currentSequence) {
    return { sequence: 0, resetReason: 'cursor_unknown' };
  }
  return { sequence, resetReason: null };
}

export class LiveAgentEventBus {
  constructor({
    instanceId,
    agentProfile = null,
    bootId = randomUUID(),
    limit = DEFAULT_EVENT_LIMIT,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!instanceId) throw new Error('live_event_instance_required');
    if (!bootId) throw new Error('live_event_boot_required');
    if (!Number.isInteger(limit) || limit < 8) throw new Error('live_event_limit_invalid');
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1000) {
      throw new Error('live_event_heartbeat_invalid');
    }
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1000) {
      throw new Error('live_event_max_age_invalid');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 4096) {
      throw new Error('live_event_max_bytes_invalid');
    }

    this.instanceId = instanceId;
    this.agentProfile = agentProfile;
    this.bootId = bootId;
    this.limit = limit;
    this.heartbeatMs = heartbeatMs;
    this.maxAgeMs = maxAgeMs;
    this.maxBytes = maxBytes;
    this.now = now;
    this.sequence = 0;
    this.bufferBytes = 0;
    this.entries = [];
    this.clients = new Set();
  }

  publish(input = {}) {
    const {
      schema: _schema,
      eventId: _eventId,
      instanceId: _instanceId,
      agentProfile: _agentProfile,
      bootId: _bootId,
      timestamp: suppliedTimestamp,
      type: suppliedType,
      ...payload
    } = input && typeof input === 'object' ? input : {};

    const sequence = ++this.sequence;
    const timestamp = suppliedTimestamp || this.now();
    const event = Object.freeze({
      schema: LIVE_AGENT_EVENT_SCHEMA,
      eventId: this.bootId + ':' + sequence,
      bootId: this.bootId,
      sequence,
      instanceId: this.instanceId,
      agentProfile: this.agentProfile,
      timestamp,
      type: String(suppliedType || 'EVENT'),
      ...clone(payload),
    });

    const bytes = Buffer.byteLength(JSON.stringify(event));
    const atMs = Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : Date.now();
    this.entries.push({ event, bytes, atMs });
    this.bufferBytes += bytes;
    this.#evict();

    for (const client of [...this.clients]) {
      if (!this.#writeEvent(client.res, event)) this.#removeClient(client, true);
    }
    return clone(event);
  }

  snapshot(after = null) {
    this.#evict();
    const parsed = parseCursor(after, this.bootId, this.sequence);
    const oldestSequence = this.entries.length ? this.entries[0].event.sequence : this.sequence + 1;
    let resetReason = parsed.resetReason;

    if (!resetReason
        && parsed.sequence > 0
        && this.entries.length
        && parsed.sequence < oldestSequence - 1) {
      resetReason = 'cursor_expired';
    }

    const replaySequence = resetReason ? 0 : parsed.sequence;
    return {
      schema: LIVE_AGENT_EVENT_SNAPSHOT_SCHEMA,
      instanceId: this.instanceId,
      agentProfile: this.agentProfile,
      bootId: this.bootId,
      requestedAfter: after == null ? null : String(after),
      oldestEventId: this.entries.length ? this.entries[0].event.eventId : null,
      highWatermarkEventId: this.sequence ? this.bootId + ':' + this.sequence : null,
      lastEventId: this.sequence ? this.bootId + ':' + this.sequence : null,
      resetRequired: Boolean(resetReason),
      resetReason,
      events: this.entries
        .filter(entry => entry.event.sequence > replaySequence)
        .map(entry => clone(entry.event)),
    };
  }

  attach(req, res, { after = null } = {}) {
    const snapshot = this.snapshot(after);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    res.setTimeout?.(0);
    req.socket?.setTimeout?.(0);
    res.flushHeaders?.();

    const client = { res, heartbeat: null, closed: false };
    const cleanup = () => this.#removeClient(client);
    req.once('close', cleanup);
    res.once('close', cleanup);
    res.once('error', cleanup);
    this.clients.add(client);

    if (snapshot.resetRequired) {
      if (!this.#writeTransient(res, 'channel.replay_reset', {
        schema: LIVE_AGENT_EVENT_SNAPSHOT_SCHEMA,
        instanceId: this.instanceId,
        agentProfile: this.agentProfile,
        bootId: this.bootId,
        reason: snapshot.resetReason,
        requestedAfter: snapshot.requestedAfter,
        highWatermarkEventId: snapshot.highWatermarkEventId,
      })) {
        this.#removeClient(client, true);
        return { ok: false, error: 'stream_write_failed' };
      }
    }

    if (!this.#writeTransient(res, 'channel.ready', {
      schema: LIVE_AGENT_EVENT_SNAPSHOT_SCHEMA,
      instanceId: this.instanceId,
      agentProfile: this.agentProfile,
      bootId: this.bootId,
      requestedAfter: snapshot.requestedAfter,
      oldestEventId: snapshot.oldestEventId,
      highWatermarkEventId: snapshot.highWatermarkEventId,
      resetRequired: snapshot.resetRequired,
      resetReason: snapshot.resetReason,
      replayCount: snapshot.events.length,
    })) {
      this.#removeClient(client, true);
      return { ok: false, error: 'stream_write_failed' };
    }

    for (const event of snapshot.events) {
      if (!this.#writeEvent(res, event)) {
        this.#removeClient(client, true);
        return { ok: false, error: 'stream_backpressure' };
      }
    }

    client.heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        this.#removeClient(client);
        return;
      }
      try {
        const writable = res.write(': heartbeat ' + this.now() + '\n\n');
        if (!writable) this.#removeClient(client, true);
      } catch {
        this.#removeClient(client, true);
      }
    }, this.heartbeatMs);
    client.heartbeat.unref?.();

    return {
      ok: true,
      instanceId: this.instanceId,
      agentProfile: this.agentProfile,
      bootId: this.bootId,
      highWatermarkEventId: snapshot.highWatermarkEventId,
      resetRequired: snapshot.resetRequired,
      resetReason: snapshot.resetReason,
      replayCount: snapshot.events.length,
    };
  }

  disconnectAll() {
    for (const client of [...this.clients]) this.#removeClient(client, true);
  }

  #evict() {
    const logicalNow = Date.parse(this.now());
    const cutoff = (Number.isFinite(logicalNow) ? logicalNow : Date.now()) - this.maxAgeMs;
    while (this.entries.length) {
      const first = this.entries[0];
      const overCount = this.entries.length > this.limit;
      const overBytes = this.bufferBytes > this.maxBytes;
      const expired = first.atMs < cutoff;
      if (!overCount && !overBytes && !expired) break;
      this.entries.shift();
      this.bufferBytes -= first.bytes;
    }
  }

  #writeTransient(res, type, data) {
    if (res.writableEnded || res.destroyed) return false;
    try {
      const a = res.write('event: ' + eventName(type) + '\n');
      const b = res.write('data: ' + JSON.stringify(data) + '\n\n');
      return Boolean(a && b);
    } catch {
      return false;
    }
  }

  #writeEvent(res, event) {
    if (res.writableEnded || res.destroyed) return false;
    try {
      const a = res.write('id: ' + event.eventId + '\n');
      const b = res.write('event: ' + eventName(event.type) + '\n');
      const c = res.write('data: ' + JSON.stringify(event) + '\n\n');
      return Boolean(a && b && c);
    } catch {
      return false;
    }
  }

  #removeClient(client, end = false) {
    if (!client || client.closed) return;
    client.closed = true;
    if (client.heartbeat) clearInterval(client.heartbeat);
    this.clients.delete(client);
    if (end && !client.res.writableEnded && !client.res.destroyed) {
      try { client.res.end(); } catch {}
    }
  }
}
