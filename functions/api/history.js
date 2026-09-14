// Cloudflare Pages Function: /api/history
//
// Nexconn's own message store does not reliably retain public-room history
// (observed: messages sent the previous day were already gone from the
// SDK's own query API). To guarantee the public room always shows the last
// 48 hours regardless of what Nexconn's servers retain, we keep our own
// lightweight backup copy of room messages in a Cloudflare KV namespace
// (binding: CHAT_HISTORY).
//
// This only backs up the PUBLIC room. Private 1:1 messages are not stored
// here, since that would mean holding other people's private conversations
// in a store with no per-user access control.
//
// GET    /api/history?channel=room             -> { messages: [...] } (last 48h)
// POST   /api/history  { channel: 'room', message: {...} }        -> { ok: true }
// DELETE /api/history?channel=room&id=<msgId>  -> { ok: true } (used by "Recall")

const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_STORED_MESSAGES = 500;
const KV_KEY_PREFIX = 'msgs:';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isSupportedChannel(channel) {
  return channel === 'room';
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.CHAT_HISTORY) return json({ messages: [] });

  const url = new URL(request.url);
  const channel = url.searchParams.get('channel');
  if (!isSupportedChannel(channel)) return json({ error: 'Unknown channel' }, 400);

  const raw = await env.CHAT_HISTORY.get(KV_KEY_PREFIX + channel);
  let messages = [];
  if (raw) {
    try {
      messages = JSON.parse(raw);
    } catch (e) {
      messages = [];
    }
  }

  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  messages = messages.filter((m) => typeof m.time === 'number' && m.time >= cutoff);

  return json({ messages });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.CHAT_HISTORY) return json({ ok: false, error: 'History storage is not configured' }, 500);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request format' }, 400);
  }

  const channel = body.channel;
  if (!isSupportedChannel(channel)) return json({ error: 'Unknown channel' }, 400);

  const message = body.message;
  if (!message || typeof message !== 'object') return json({ error: 'Missing message' }, 400);

  // Only keep the fields we actually render, to avoid storing anything
  // unexpected the client might send.
  const entry = {
    id: typeof message.id === 'string' ? message.id.slice(0, 128) : null,
    senderUserId: typeof message.senderUserId === 'string' ? message.senderUserId.slice(0, 128) : '',
    name: typeof message.name === 'string' ? message.name.slice(0, 64) : '',
    text: typeof message.text === 'string' ? message.text.slice(0, 4000) : '',
    gift: typeof message.gift === 'string' ? message.gift.slice(0, 32) : null,
    verse: message.verse && typeof message.verse === 'object' ? message.verse : null,
    replyTo: message.replyTo && typeof message.replyTo === 'object' ? message.replyTo : null,
    time: typeof message.time === 'number' ? message.time : Date.now(),
  };

  const key = KV_KEY_PREFIX + channel;
  const raw = await env.CHAT_HISTORY.get(key);
  let messages = [];
  if (raw) {
    try {
      messages = JSON.parse(raw);
    } catch (e) {
      messages = [];
    }
  }

  if (entry.id && messages.some((m) => m.id === entry.id)) {
    return json({ ok: true, deduped: true });
  }

  messages.push(entry);

  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  messages = messages.filter((m) => typeof m.time === 'number' && m.time >= cutoff);
  if (messages.length > MAX_STORED_MESSAGES) {
    messages = messages.slice(messages.length - MAX_STORED_MESSAGES);
  }

  await env.CHAT_HISTORY.put(key, JSON.stringify(messages));

  return json({ ok: true });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!env.CHAT_HISTORY) return json({ ok: false, error: 'History storage is not configured' }, 500);

  const url = new URL(request.url);
  const channel = url.searchParams.get('channel');
  const id = url.searchParams.get('id');
  if (!isSupportedChannel(channel)) return json({ error: 'Unknown channel' }, 400);
  if (!id) return json({ error: 'Missing id' }, 400);

  const key = KV_KEY_PREFIX + channel;
  const raw = await env.CHAT_HISTORY.get(key);
  let messages = [];
  if (raw) {
    try {
      messages = JSON.parse(raw);
    } catch (e) {
      messages = [];
    }
  }

  const next = messages.filter((m) => m.id !== id);
  await env.CHAT_HISTORY.put(key, JSON.stringify(next));

  return json({ ok: true, removed: next.length !== messages.length });
}
