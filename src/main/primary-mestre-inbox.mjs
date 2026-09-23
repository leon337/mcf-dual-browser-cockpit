import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './instance.mjs';

const VERSION = 1;
const STATES = new Set(['PENDING','DELIVERING','DELIVERED','UNKNOWN']);

function clean(value, max) {
  const text = String(value ?? '').trim();
  return text && text.length <= max ? text : null;
}

export class PrimaryMestreInbox {
  constructor({ file, deliver, canDeliver = async () => ({ready:true}), onEvent = () => {} }) {
    if (!file || typeof deliver !== 'function' || typeof canDeliver !== 'function') throw new Error('mestre_inbox_config_required');
    this.file = file;
    this.deliver = deliver;
    this.canDeliver = canDeliver;
    this.onEvent = onEvent;
    this.processing = false;
    this.items = this.#load();
  }

  #load() {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed?.version !== VERSION || !Array.isArray(parsed.items)) return [];
      let changed = false;
      const items = parsed.items.filter(item => item && STATES.has(item.state)).map(item => {
        if (item.state !== 'DELIVERING') return item;
        changed = true;
        return { ...item, state:'UNKNOWN', lastError:'delivery_interrupted_by_restart', updatedAt:new Date().toISOString() };
      });
      if (changed) atomicJson(this.file, { version:VERSION, items });
      return items;
    } catch {
      return [];
    }
  }

  #save() {
    atomicJson(this.file, { version:VERSION, items:this.items });
  }

  list() {
    return this.items.map(item => structuredClone(item));
  }

  enqueue(input = {}) {
    const messageId = clean(input.messageId, 180);
    const from = clean(input.from, 120);
    const fromChatId = clean(input.fromChatId, 180);
    const text = clean(input.text, 12000);
    if (!messageId || !from || !fromChatId || !text) throw new Error('valid_mestre_inbox_message_required');
    const existing = this.items.find(item => item.messageId === messageId && item.fromChatId === fromChatId);
    if (existing) return { ok:true, deduplicated:true, item:structuredClone(existing) };
    const now = new Date().toISOString();
    const item = {
      id:randomUUID(), messageId, from, fromChatId, text,
      state:'PENDING', attempts:0, createdAt:now, updatedAt:now,
      deliveredAt:null, lastError:null, response:null
    };
    this.items.push(item);
    this.#save();
    this.onEvent({level:'info',message:`MESTRE inbox: mensagem recebida de ${from}.`});
    return { ok:true, deduplicated:false, item:structuredClone(item) };
  }

  async processOne() {
    if (this.processing) return {ok:false,deferred:true,reason:'processor_busy'};
    const item = this.items.find(candidate => candidate.state === 'PENDING');
    if (!item) return {ok:true,processed:false};
    this.processing = true;
    try {
      let readiness;
      try {
        readiness = await this.canDeliver(structuredClone(item));
      } catch (error) {
        return {ok:false,processed:false,deferred:true,reason:String(error?.message || error).slice(0,500)};
      }
      if (readiness === false || readiness?.ready === false || readiness?.deferred) {
        return {ok:false,processed:false,deferred:true,reason:readiness?.reason || 'delivery_not_ready'};
      }

      item.state = 'DELIVERING';
      item.attempts += 1;
      item.updatedAt = new Date().toISOString();
      this.#save();
      try {
        const result = await this.deliver(structuredClone(item));
        if (result?.deferred) {
          item.state = 'PENDING';
          item.lastError = result.reason || 'delivery_deferred';
        } else if (result?.ok) {
          item.state = 'DELIVERED';
          item.deliveredAt = new Date().toISOString();
          item.lastError = null;
          item.response = result.response ?? null;
          this.onEvent({level:'ok',message:`MESTRE inbox: mensagem de ${item.from} entregue.`});
        } else if (result?.delivery === 'NOT_SENT') {
          item.state = 'PENDING';
          item.lastError = result.error || 'delivery_not_sent';
        } else {
          item.state = 'UNKNOWN';
          item.lastError = result?.error || 'delivery_unknown';
        }
        item.updatedAt = new Date().toISOString();
        this.#save();
        return {ok:item.state === 'DELIVERED',processed:true,item:structuredClone(item)};
      } catch (error) {
        item.state = error?.delivery === 'NOT_SENT' ? 'PENDING' : 'UNKNOWN';
        item.lastError = String(error?.message || error).slice(0,500);
        item.updatedAt = new Date().toISOString();
        this.#save();
        return {ok:false,processed:true,item:structuredClone(item)};
      }
    } finally {
      this.processing = false;
    }
  }}
