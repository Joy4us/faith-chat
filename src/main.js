import {
  NCEngine,
  LogLevel,
  ChannelType,
  OpenChannel,
  OpenChannelIdentifier,
  DirectChannel,
  DirectChannelIdentifier,
  BaseChannel,
  SendTextMessageParams,
  MessageHandler,
  ConnectionStatusHandler,
  OpenChannelHandler,
} from '@nexconn/chat';

const ROOM_ID = 'welcome-room';
const CHRISTIAN_ID = 'christian';
const SESSION_KEY = 'faithchat_session_v1';
// How far back to pull public-room history on load. Nexconn's own message
// store does not guarantee unlimited retention, so we always try to restore
// the last 48 hours of the public room when a client connects.
const ROOM_HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000;
const seenRoomMessageIds = new Set();

// Faith-themed "gift" reactions. These are symbolic (cross, dove, angel,
// praying hands, etc.) rather than a literal depiction of any person, and
// map to a small full-screen animation defined in style.css.
const GIFTS = {
  heart: { emoji: '❤️', label: 'Heart of Grace' },
  angel: { emoji: '👼', label: 'Guardian Angel' },
  dove: { emoji: '🕊️', label: 'Holy Spirit' },
  cross: { emoji: '✝️', label: 'Cross of Light' },
  pray: { emoji: '🙏', label: 'Amen' },
  rainbow: { emoji: '🌈', label: "God's Promise" },
  light: { emoji: '✨', label: 'Blessing' },
};

// Bible verse lookup, backed by bible-api.com (public-domain translations
// only: KJV / WEB). Book lists are used to populate the Old/New Testament
// pickers in the Bible tab.
const OT_BOOKS = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth',
  '1 Samuel', '2 Samuel', '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra',
  'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs', 'Ecclesiastes', 'Song of Solomon',
  'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
  'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah', 'Malachi',
];
const NT_BOOKS = [
  'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians', '2 Corinthians',
  'Galatians', 'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians', '2 Thessalonians',
  '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James', '1 Peter', '2 Peter',
  '1 John', '2 John', '3 John', 'Jude', 'Revelation',
];

const app = document.getElementById('app');

let session = null; // {userId, accessToken, appKey, areaCode, displayName, isChristian}
let openChannel = null;
const dmChannels = new Map(); // peerId -> DirectChannel instance
const peers = new Map(); // peerId -> {name, messages: []}
const roomMessages = [];
let activeTab = 'room';
let activePeer = null;
let engineReady = false;
let bibleTestament = 'ot';
let lastVerseResult = null; // {reference, text, translation}
let roomReplyTarget = null; // {name, text} — message currently being replied to in the public room
let dmReplyTarget = null; // {name, text} — message currently being replied to in the DM thread

function saveSession() {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* ignore */ }
}
function loadSession() {
  try {
    const s = localStorage.getItem(SESSION_KEY);
    return s ? JSON.parse(s) : null;
  } catch (e) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
}

function doLogout() {
  clearSession();
  location.reload();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- Gate screen ----------------
function renderGate(errorMsg) {
  app.innerHTML = `
    <div class="gate">
      <div class="cross">&#10013;</div>
      <h1>Chat with Our Ministry Team</h1>
      <p class="sub">A public space to talk about faith. Come say hello — the public room is visible to everyone, and you can also send a private 1:1 message.</p>
      <input id="nameInput" type="text" placeholder="Your nickname (strangers welcome)" maxlength="24" />
      <div class="passcode-row" id="passRow">
        <input id="passInput" type="password" placeholder="Access passcode" />
      </div>
      <button id="enterBtn">Enter chat</button>
      <button class="toggle" id="modeToggle">I am on the ministry team &#8594;</button>
      <div class="error" id="errBox">${errorMsg ? escapeHtml(errorMsg) : ''}</div>
    </div>
  `;

  let isChristianMode = false;
  const nameInput = document.getElementById('nameInput');
  const passRow = document.getElementById('passRow');
  const passInput = document.getElementById('passInput');
  const enterBtn = document.getElementById('enterBtn');
  const modeToggle = document.getElementById('modeToggle');
  const errBox = document.getElementById('errBox');

  modeToggle.addEventListener('click', () => {
    isChristianMode = !isChristianMode;
    passRow.classList.toggle('show', isChristianMode);
    modeToggle.textContent = isChristianMode ? '← I am a guest' : 'I am on the ministry team →';
    nameInput.placeholder = isChristianMode ? 'Display name (shown to guests)' : 'Your nickname (strangers welcome)';
  });

  async function doEnter() {
    const displayName = nameInput.value.trim();
    if (!displayName) { errBox.textContent = 'Please enter a nickname'; return; }
    if (isChristianMode && !passInput.value.trim()) { errBox.textContent = 'Please enter the access passcode'; return; }
    enterBtn.disabled = true;
    errBox.textContent = '';
    try {
      const res = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName,
          mode: isChristianMode ? 'christian' : 'guest',
          passcode: isChristianMode ? passInput.value.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sign-in failed, please try again');
      session = data;
      saveSession();
      await connectAndRender();
    } catch (e) {
      errBox.textContent = e.message || 'Something went wrong, please try again';
      enterBtn.disabled = false;
    }
  }

  enterBtn.addEventListener('click', doEnter);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doEnter(); });
}

// ---------------- Engine setup ----------------
function setupEngineOnce() {
  if (engineReady) return;
  NCEngine.initialize({ appKey: session.appKey, areaCode: session.areaCode, logLevel: LogLevel.WARN });

  NCEngine.addConnectionStatusHandler('main', new ConnectionStatusHandler({
    onConnectionStateChanged({ status }) {
      console.log('[faith-chat] connection status changed:', status);
    },
  }));

  NCEngine.addMessageHandler('main', new MessageHandler({
    onMessageReceived({ messages }) {
      messages.forEach(handleIncomingMessage);
    },
  }));

  NCEngine.addOpenChannelHandler('main', new OpenChannelHandler({
    onEntered() { console.log('[faith-chat] entered public room'); },
    onEnterFailed(e) { console.warn('[faith-chat] failed to enter public room', e); },
  }));

  engineReady = true;
}

function toRenderable(message) {
  const rawText = message.content?.text ?? '[unsupported message type]';
  let giftKey = null;
  let verseObj = null;
  let replyTo = null;
  let displayText = rawText;

  if (typeof rawText === 'string') {
    if (rawText.startsWith('GIFT::')) {
      giftKey = rawText.slice(6);
    } else if (rawText.startsWith('VERSE::')) {
      try { verseObj = JSON.parse(rawText.slice(7)); } catch (e) { verseObj = null; }
    } else if (rawText.startsWith('REPLY::')) {
      try {
        const parsed = JSON.parse(rawText.slice(7));
        replyTo = { name: parsed.quoteName, text: parsed.quoteText };
        displayText = parsed.text;
      } catch (e) { /* fall back to showing the raw text */ }
    }
  }

  return {
    id: message.messageId,
    mine: message.senderUserId === session.userId,
    name: message.content?.senderUserInfo?.name || message.senderUserId,
    text: displayText,
    gift: giftKey && GIFTS[giftKey] ? giftKey : null,
    verse: verseObj,
    replyTo,
    time: message.sentTime || Date.now(),
  };
}

// Fetches the last ROOM_HISTORY_WINDOW_MS (48h) of public-room messages from
// the server so the room doesn't look empty just because this tab happens to
// be a fresh session (or the SDK's default enterChannel fetch missed older
// messages). Safe to call every time we connect; dedupes by messageId.
async function loadRoomHistory() {
  try {
    const query = OpenChannel.createOpenChannelMessagesQuery({
      channelId: ROOM_ID,
      pageSize: 50,
      isAscending: true,
      startTime: Date.now() - ROOM_HISTORY_WINDOW_MS,
    });
    let pages = 0;
    while (query.hasNext && pages < 8) {
      const result = await query.loadNextPage();
      pages++;
      if (!result.isOk || !result.data || !Array.isArray(result.data.data)) break;
      for (const message of result.data.data) {
        if (message.messageId && seenRoomMessageIds.has(message.messageId)) continue;
        if (message.messageId) seenRoomMessageIds.add(message.messageId);
        roomMessages.push(toRenderable(message));
      }
      if (result.data.data.length === 0) break;
    }
  } catch (e) {
    console.warn('[faith-chat] failed to load room history', e);
  }

  // Merge in our own 48h backup (see functions/api/history.js). Nexconn's
  // own message store does not reliably retain public-room history (its
  // query above can come back empty even for messages sent minutes ago on
  // a fresh session), so this backup is the part that actually guarantees
  // the 48-hour window.
  try {
    const res = await fetch('/api/history?channel=room');
    if (res.ok) {
      const data = await res.json();
      for (const m of data.messages || []) {
        if (m.id && seenRoomMessageIds.has(m.id)) continue;
        if (m.id) seenRoomMessageIds.add(m.id);
        roomMessages.push({
          id: m.id,
          mine: m.senderUserId === session.userId,
          name: m.name,
          text: m.text,
          gift: m.gift || null,
          verse: m.verse || null,
          replyTo: m.replyTo || null,
          time: m.time,
        });
      }
    }
  } catch (e) {
    console.warn('[faith-chat] failed to load room history backup', e);
  }

  roomMessages.sort((a, b) => a.time - b.time);
}

// Best-effort backup of a public-room message into our own 48h store.
// Fire-and-forget: a network hiccup here should never block sending.
function persistRoomMessage(entry) {
  fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'room', message: entry }),
  }).catch((e) => console.warn('[faith-chat] failed to persist room message', e));
}

// Fetches past messages for a direct (1:1) channel from the server and
// merges them into the local peers map, so a freshly-opened device can see
// private conversation history instead of only messages sent while that
// device's tab happens to be open.
async function loadDmHistory(peerId) {
  try {
    const query = BaseChannel.createMessagesQuery({
      channelIdentifier: new DirectChannelIdentifier(peerId),
      pageSize: 50,
      isAscending: true,
    });
    let pages = 0;
    while (query.hasNext && pages < 4) {
      const result = await query.loadNextPage();
      pages++;
      if (!result.isOk || !result.data || !Array.isArray(result.data.data)) break;
      for (const message of result.data.data) {
        const renderable = toRenderable(message);
        if (!peers.has(peerId)) peers.set(peerId, { name: renderable.name, messages: [] });
        if (message.senderUserId === peerId) peers.get(peerId).name = renderable.name;
        peers.get(peerId).messages.push(renderable);
      }
      if (result.data.data.length === 0) break;
    }
  } catch (e) {
    console.warn('[faith-chat] failed to load DM history for', peerId, e);
  }
}

// For the Ministry Team identity: discovers every guest who has an existing
// direct-message channel (even from before this login) and loads each
// conversation's history, so switching devices doesn't lose past private
// messages.
async function loadAllDmPeers() {
  try {
    const query = BaseChannel.createChannelsQuery({ pageSize: 50 });
    let pages = 0;
    const directPeerIds = [];
    while (query.hasNext && pages < 4) {
      const result = await query.loadNextPage();
      pages++;
      if (!result.isOk || !result.data || !Array.isArray(result.data.data)) break;
      for (const ch of result.data.data) {
        if (ch.channelType === ChannelType.DIRECT) directPeerIds.push(ch.channelId);
      }
      if (result.data.data.length === 0) break;
    }
    for (const peerId of directPeerIds) {
      if (!dmChannels.has(peerId)) dmChannels.set(peerId, new DirectChannel(peerId));
      if (!peers.has(peerId)) peers.set(peerId, { name: peerId, messages: [] });
      await loadDmHistory(peerId);
    }
    if (activePeer === null && directPeerIds.length) activePeer = directPeerIds[0];
  } catch (e) {
    console.warn('[faith-chat] failed to load DM peer list', e);
  }
}

function handleIncomingMessage(message) {
  // We already render our own outgoing messages locally on send; skip echoes.
  if (message.senderUserId === session.userId) return;

  const ch = message.channelIdentifier;
  const renderable = toRenderable(message);

  if (ch.channelType === ChannelType.OPEN && ch.channelId === ROOM_ID) {
    if (renderable.id && seenRoomMessageIds.has(renderable.id)) return;
    if (renderable.id) seenRoomMessageIds.add(renderable.id);
    roomMessages.push(renderable);
    if (activeTab === 'room') renderRoomMessages();
    if (renderable.gift) playGiftAnimation(renderable.gift);
    return;
  }

  if (ch.channelType === ChannelType.DIRECT) {
    const peerId = ch.channelId; // the other party's user id
    if (!peers.has(peerId)) peers.set(peerId, { name: renderable.name, messages: [] });
    else peers.get(peerId).name = renderable.name;
    peers.get(peerId).messages.push(renderable);

    if (session.isChristian && activePeer === null) activePeer = peerId;

    if (activeTab === 'dm') {
      if (session.isChristian) renderPeerSidebar();
      renderDmMessages();
    }
    if (renderable.gift) playGiftAnimation(renderable.gift);
  }
}

// ---------------- Chat screen ----------------
function giftBarHtml(scope) {
  const buttons = Object.entries(GIFTS)
    .map(([key, g]) => `<button type="button" class="gift-btn" data-gift="${key}" title="${escapeHtml(g.label)}">${g.emoji}</button>`)
    .join('');
  return `<div class="gift-bar" data-scope="${scope}">${buttons}</div>`;
}

function bookOptionsHtml(testament) {
  const books = testament === 'nt' ? NT_BOOKS : OT_BOOKS;
  return books.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
}

function bibleToolHtml() {
  return `
    <div class="bible-tool">
      <div class="testament-toggle">
        <button type="button" data-testament="ot" class="${bibleTestament === 'ot' ? 'active' : ''}">Old Testament</button>
        <button type="button" data-testament="nt" class="${bibleTestament === 'nt' ? 'active' : ''}">New Testament</button>
      </div>
      <div class="bible-fields">
        <select id="bibleBook">${bookOptionsHtml(bibleTestament)}</select>
        <input id="bibleChapter" type="number" min="1" placeholder="Chapter" />
        <input id="bibleVerse" type="text" placeholder="Verse (e.g. 16 or 1-4, optional)" />
        <button type="button" id="bibleLookupBtn">Look up</button>
      </div>
      <div class="bible-result" id="bibleResult"></div>
    </div>
  `;
}

function topbarTitle() {
  if (activeTab === 'bible') return '&#128214; Bible';
  if (activeTab === 'dm') return session.isChristian ? 'Direct messages' : 'Message the Ministry Team';
  return 'Public Chat';
}

function renderChatScreen() {
  app.innerHTML = `
    <div class="chat-screen show">
      <div class="topbar">
        <strong>${topbarTitle()}</strong>
        <span class="whoami-wrap">
          <span class="whoami">${escapeHtml(session.displayName)}${session.isChristian ? '' : ' · guest'}</span>
          <button class="logout-link" id="logoutBtn" title="Log out and use a different name">Switch</button>
        </span>
      </div>
      <div class="tabs">
        <button data-tab="room" class="${activeTab === 'room' ? 'active' : ''}">Public room</button>
        <button data-tab="dm" class="${activeTab === 'dm' ? 'active' : ''}">${session.isChristian ? 'Direct messages' : 'Message the Ministry Team'}</button>
        <button data-tab="bible" class="${activeTab === 'bible' ? 'active' : ''}">&#128214; Bible</button>
      </div>
      <div class="panels">
        <div class="panel ${activeTab === 'room' ? 'active' : ''}" id="roomPanel">
          <div class="thread-wrap">
            <div class="messages" id="roomMessages"></div>
            ${giftBarHtml('room')}
            <div class="reply-preview-slot" id="roomReplyPreview"></div>
            <div class="composer">
              <input id="roomInput" type="text" placeholder="Say something in the public room..." />
              <button id="roomSend">Send</button>
            </div>
          </div>
        </div>
        <div class="panel with-sidebar ${activeTab === 'dm' ? 'active' : ''}" id="dmPanel">
          <div class="peer-sidebar ${session.isChristian ? 'show' : ''}" id="peerSidebar"></div>
          <div class="thread-wrap">
            <div class="messages" id="dmMessages"></div>
            ${giftBarHtml('dm')}
            <div class="reply-preview-slot" id="dmReplyPreview"></div>
            <div class="composer">
              <input id="dmInput" type="text" placeholder="${session.isChristian ? 'Select a guest on the left to reply...' : 'Send our ministry team a private message...'}" />
              <button id="dmSend">Send</button>
            </div>
          </div>
        </div>
        <div class="panel bible-panel ${activeTab === 'bible' ? 'active' : ''}" id="biblePanel">
          ${bibleToolHtml()}
        </div>
      </div>
    </div>
  `;

  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      renderChatScreen();
    });
  });

  document.getElementById('logoutBtn').addEventListener('click', doLogout);

  document.getElementById('roomSend').addEventListener('click', sendRoomMessage);
  document.getElementById('roomInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendRoomMessage(); });
  document.getElementById('dmSend').addEventListener('click', sendDmMessage);
  document.getElementById('dmInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDmMessage(); });

  document.querySelectorAll('.gift-bar').forEach((bar) => {
    const scope = bar.dataset.scope;
    bar.querySelectorAll('.gift-btn').forEach((btn) => {
      btn.addEventListener('click', () => sendGift(scope, btn.dataset.gift));
    });
  });

  document.getElementById('bibleLookupBtn').addEventListener('click', lookupVerse);
  document.querySelectorAll('.testament-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      bibleTestament = btn.dataset.testament;
      renderChatScreen();
    });
  });
  if (lastVerseResult) renderBibleResult();

  renderReplyPreview('room');
  renderReplyPreview('dm');

  if (activeTab === 'room') renderRoomMessages();
  if (activeTab === 'dm') { renderPeerSidebar(); renderDmMessages(); }
}

function messagePreviewText(m) {
  if (m.verse) return `\u{1F4D6} ${m.verse.reference}`;
  if (m.gift && GIFTS[m.gift]) return `${GIFTS[m.gift].emoji} ${GIFTS[m.gift].label}`;
  const t = m.text || '';
  return t.length > 100 ? t.slice(0, 100) + '…' : t;
}

function bubbleHtml(m, idx) {
  const time = new Date(m.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const cleanName = (m.name || '').replace(/ \(me\)$/, '');
  const replyBtn = `<button type="button" class="reply-trigger" data-idx="${idx}" title="Reply">&#8617; Reply</button>`;
  const replyBlock = m.replyTo
    ? `<div class="reply-quote"><strong>${escapeHtml(m.replyTo.name)}</strong>: ${escapeHtml(m.replyTo.text)}</div>`
    : '';

  if (m.verse) {
    return `<div class="msg verse ${m.mine ? 'me' : 'them'}"><div class="meta">${escapeHtml(cleanName)} · ${time} ${replyBtn}</div>${replyBlock}<div class="verse-card"><div class="verse-ref">&#128214; ${escapeHtml(m.verse.reference)}</div><div class="verse-text">${escapeHtml(m.verse.text)}</div><div class="verse-version">${escapeHtml(m.verse.translation)}</div></div></div>`;
  }
  if (m.gift && GIFTS[m.gift]) {
    const g = GIFTS[m.gift];
    return `<div class="msg gift ${m.mine ? 'me' : 'them'}"><div class="meta">${escapeHtml(cleanName)} · ${time} ${replyBtn}</div>${replyBlock}<div class="gift-card"><span class="gift-card-emoji">${g.emoji}</span><span class="gift-card-label">${escapeHtml(g.label)}</span></div></div>`;
  }
  return `<div class="msg ${m.mine ? 'me' : 'them'}"><div class="meta">${escapeHtml(cleanName)} · ${time} ${replyBtn}</div>${replyBlock}${escapeHtml(m.text)}</div>`;
}

function wireReplyButtons(box, list, scope) {
  box.querySelectorAll('.reply-trigger').forEach((btn) => {
    const idx = Number(btn.dataset.idx);
    const m = list[idx];
    if (!m) return;
    btn.addEventListener('click', () => {
      const target = { name: (m.name || '').replace(/ \(me\)$/, ''), text: messagePreviewText(m) };
      if (scope === 'room') roomReplyTarget = target; else dmReplyTarget = target;
      renderReplyPreview(scope);
      const inputEl = document.getElementById(scope === 'room' ? 'roomInput' : 'dmInput');
      if (inputEl) inputEl.focus();
    });
  });
}

function renderReplyPreview(scope) {
  const slot = document.getElementById(scope === 'room' ? 'roomReplyPreview' : 'dmReplyPreview');
  if (!slot) return;
  const target = scope === 'room' ? roomReplyTarget : dmReplyTarget;
  if (!target) { slot.innerHTML = ''; return; }
  slot.innerHTML = `
    <div class="reply-preview">
      <div class="reply-preview-text">Replying to <strong>${escapeHtml(target.name)}</strong>: ${escapeHtml(target.text)}</div>
      <button type="button" class="reply-cancel">&times;</button>
    </div>
  `;
  const cancelBtn = slot.querySelector('.reply-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (scope === 'room') roomReplyTarget = null; else dmReplyTarget = null;
      renderReplyPreview(scope);
    });
  }
}

function renderRoomMessages() {
  const box = document.getElementById('roomMessages');
  if (!box) return;
  box.innerHTML = roomMessages.length
    ? roomMessages.map((m, idx) => bubbleHtml(m, idx)).join('')
    : '<div class="empty-hint">No one has spoken yet — say hello \u{1F44B}</div>';
  box.scrollTop = box.scrollHeight;
  wireReplyButtons(box, roomMessages, 'room');
}

function renderPeerSidebar() {
  const box = document.getElementById('peerSidebar');
  if (!box || !session.isChristian) return;
  const items = [...peers.entries()];
  box.innerHTML = items.length
    ? items.map(([id, p]) => `<div class="peer-item ${id === activePeer ? 'active' : ''}" data-peer="${escapeHtml(id)}">${escapeHtml(p.name)}</div>`).join('')
    : '<div class="peer-empty">No guests have messaged you yet</div>';
  box.querySelectorAll('.peer-item[data-peer]').forEach((el) => {
    el.addEventListener('click', () => {
      activePeer = el.dataset.peer;
      renderPeerSidebar();
      renderDmMessages();
    });
  });
}

function renderDmMessages() {
  const box = document.getElementById('dmMessages');
  if (!box) return;
  let msgs = [];
  if (session.isChristian) {
    msgs = activePeer && peers.has(activePeer) ? peers.get(activePeer).messages : [];
  } else {
    msgs = peers.has(CHRISTIAN_ID) ? peers.get(CHRISTIAN_ID).messages : [];
  }
  box.innerHTML = msgs.length ? msgs.map((m, idx) => bubbleHtml(m, idx)).join('') : '<div class="empty-hint">No messages yet — say something</div>';
  box.scrollTop = box.scrollHeight;
  wireReplyButtons(box, msgs, 'dm');
}

// ---------------- Bible lookup ----------------
async function lookupVerse() {
  const bookEl = document.getElementById('bibleBook');
  const chapterEl = document.getElementById('bibleChapter');
  const verseEl = document.getElementById('bibleVerse');
  const resultBox = document.getElementById('bibleResult');
  if (!bookEl || !chapterEl || !resultBox) return;

  const book = bookEl.value;
  const chapter = chapterEl.value.trim();
  const verse = verseEl.value.trim();

  if (!book || !chapter) {
    resultBox.innerHTML = '<div class="bible-error">Please choose a book and enter a chapter number.</div>';
    return;
  }

  const ref = verse ? `${book} ${chapter}:${verse}` : `${book} ${chapter}`;
  resultBox.innerHTML = `<div class="bible-loading">Looking up ${escapeHtml(ref)}…</div>`;

  try {
    const res = await fetch(`https://bible-api.com/${encodeURIComponent(ref)}?translation=kjv`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error || !data.text) {
      resultBox.innerHTML = '<div class="bible-error">Couldn’t find that verse — please check the chapter and verse number.</div>';
      lastVerseResult = null;
      return;
    }
    lastVerseResult = {
      reference: data.reference,
      text: data.text.trim(),
      translation: data.translation_name,
    };
    renderBibleResult();
  } catch (e) {
    resultBox.innerHTML = '<div class="bible-error">Couldn’t find that verse — please check the chapter and verse number.</div>';
    lastVerseResult = null;
  }
}

function renderBibleResult() {
  const resultBox = document.getElementById('bibleResult');
  if (!resultBox || !lastVerseResult) return;
  resultBox.innerHTML = `
    <div class="verse-card standalone">
      <div class="verse-ref">&#128214; ${escapeHtml(lastVerseResult.reference)}</div>
      <div class="verse-text">${escapeHtml(lastVerseResult.text)}</div>
      <div class="verse-version">${escapeHtml(lastVerseResult.translation)}</div>
    </div>
    <div class="verse-actions">
      <button type="button" id="verseSendRoom">Share in public room</button>
      <button type="button" id="verseSendDm">${session.isChristian ? 'Send to selected guest' : 'Send to the Ministry Team'}</button>
    </div>
  `;
  document.getElementById('verseSendRoom').addEventListener('click', () => sendVerse('room'));
  document.getElementById('verseSendDm').addEventListener('click', () => sendVerse('dm'));
}

async function sendVerse(scope) {
  if (!lastVerseResult) return;
  const text = `VERSE::${JSON.stringify(lastVerseResult)}`;

  if (scope === 'room') {
    if (!openChannel) return;
    const params = new SendTextMessageParams({ text, senderUserInfo: { name: session.displayName } });
    const result = await openChannel.sendMessage(params);
    if (result.isOk) {
      const id = result.data?.messageId;
      const time = Date.now();
      if (id) seenRoomMessageIds.add(id);
      roomMessages.push({ id, mine: true, name: session.displayName + ' (me)', text, verse: lastVerseResult, time });
      renderRoomMessages();
      persistRoomMessage({ id, senderUserId: session.userId, name: session.displayName, text, verse: lastVerseResult, time });
    } else {
      console.warn('[faith-chat] send verse failed', result);
    }
    return;
  }

  const peerId = session.isChristian ? activePeer : CHRISTIAN_ID;
  if (!peerId) { alert('Please select a guest on the left first'); return; }
  if (!dmChannels.has(peerId)) dmChannels.set(peerId, new DirectChannel(peerId));
  const channel = dmChannels.get(peerId);
  const params = new SendTextMessageParams({ text, senderUserInfo: { name: session.displayName } });
  const result = await channel.sendMessage(params);
  if (result.isOk) {
    if (!peers.has(peerId)) peers.set(peerId, { name: peerId, messages: [] });
    peers.get(peerId).messages.push({ mine: true, name: session.displayName + ' (me)', text, verse: lastVerseResult, time: Date.now() });
    renderDmMessages();
    if (session.isChristian) renderPeerSidebar();
  } else {
    console.warn('[faith-chat] send verse failed', result);
  }
}

// ---------------- Gift animations ----------------
function playGiftAnimation(key) {
  const gift = GIFTS[key];
  if (!gift) return;

  if (key === 'heart' || key === 'light') {
    const layer = document.createElement('div');
    layer.className = 'gift-fx-layer';
    const count = key === 'heart' ? 10 : 14;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      p.className = `gift-particle ${key}`;
      p.textContent = gift.emoji;
      if (key === 'heart') {
        p.style.left = (10 + Math.random() * 80) + '%';
        p.style.animationDelay = (Math.random() * 0.6) + 's';
        p.style.fontSize = (20 + Math.random() * 18) + 'px';
      } else {
        const angle = Math.random() * Math.PI * 2;
        const dist = 80 + Math.random() * 120;
        p.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
        p.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
        p.style.animationDelay = (Math.random() * 0.2) + 's';
      }
      layer.appendChild(p);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 2700);
    return;
  }

  const hero = document.createElement('div');
  hero.className = `gift-hero ${key}`;
  hero.textContent = gift.emoji;
  document.body.appendChild(hero);
  setTimeout(() => hero.remove(), 2700);
}

// ---------------- Sending ----------------
async function sendGift(scope, key) {
  const gift = GIFTS[key];
  if (!gift) return;
  const text = `GIFT::${key}`;

  if (scope === 'room') {
    if (!openChannel) return;
    const params = new SendTextMessageParams({ text, senderUserInfo: { name: session.displayName } });
    const result = await openChannel.sendMessage(params);
    if (result.isOk) {
      const id = result.data?.messageId;
      const time = Date.now();
      if (id) seenRoomMessageIds.add(id);
      roomMessages.push({ id, mine: true, name: session.displayName + ' (me)', text, gift: key, time });
      renderRoomMessages();
      playGiftAnimation(key);
      persistRoomMessage({ id, senderUserId: session.userId, name: session.displayName, text, gift: key, time });
    } else {
      console.warn('[faith-chat] send gift failed', result);
    }
    return;
  }

  const peerId = session.isChristian ? activePeer : CHRISTIAN_ID;
  if (!peerId) { alert('Please select a guest on the left first'); return; }
  if (!dmChannels.has(peerId)) dmChannels.set(peerId, new DirectChannel(peerId));
  const channel = dmChannels.get(peerId);
  const params = new SendTextMessageParams({ text, senderUserInfo: { name: session.displayName } });
  const result = await channel.sendMessage(params);
  if (result.isOk) {
    if (!peers.has(peerId)) peers.set(peerId, { name: peerId, messages: [] });
    peers.get(peerId).messages.push({ mine: true, name: session.displayName + ' (me)', text, gift: key, time: Date.now() });
    renderDmMessages();
    if (session.isChristian) renderPeerSidebar();
    playGiftAnimation(key);
  } else {
    console.warn('[faith-chat] send gift failed', result);
  }
}

async function sendRoomMessage() {
  const input = document.getElementById('roomInput');
  const rawText = input.value.trim();
  if (!rawText || !openChannel) return;
  input.value = '';

  const target = roomReplyTarget;
  const wireText = target
    ? `REPLY::${JSON.stringify({ quoteName: target.name, quoteText: target.text, text: rawText })}`
    : rawText;

  const params = new SendTextMessageParams({ text: wireText, senderUserInfo: { name: session.displayName } });
  const result = await openChannel.sendMessage(params);
  if (result.isOk) {
    const id = result.data?.messageId;
    const time = Date.now();
    const replyTo = target ? { name: target.name, text: target.text } : null;
    if (id) seenRoomMessageIds.add(id);
    roomMessages.push({
      id,
      mine: true,
      name: session.displayName + ' (me)',
      text: rawText,
      replyTo,
      time,
    });
    roomReplyTarget = null;
    renderReplyPreview('room');
    renderRoomMessages();
    persistRoomMessage({ id, senderUserId: session.userId, name: session.displayName, text: rawText, replyTo, time });
  } else {
    console.warn('[faith-chat] send room message failed', result);
    alert('Failed to send, please try again');
  }
}

async function sendDmMessage() {
  const input = document.getElementById('dmInput');
  const rawText = input.value.trim();
  if (!rawText) return;
  const peerId = session.isChristian ? activePeer : CHRISTIAN_ID;
  if (!peerId) { alert('Please select a guest on the left first'); return; }
  input.value = '';

  const target = dmReplyTarget;
  const wireText = target
    ? `REPLY::${JSON.stringify({ quoteName: target.name, quoteText: target.text, text: rawText })}`
    : rawText;

  if (!dmChannels.has(peerId)) dmChannels.set(peerId, new DirectChannel(peerId));
  const channel = dmChannels.get(peerId);
  const params = new SendTextMessageParams({ text: wireText, senderUserInfo: { name: session.displayName } });
  const result = await channel.sendMessage(params);
  if (result.isOk) {
    if (!peers.has(peerId)) peers.set(peerId, { name: peerId, messages: [] });
    peers.get(peerId).messages.push({
      mine: true,
      name: session.displayName + ' (me)',
      text: rawText,
      replyTo: target ? { name: target.name, text: target.text } : null,
      time: Date.now(),
    });
    dmReplyTarget = null;
    renderReplyPreview('dm');
    renderDmMessages();
    if (session.isChristian) renderPeerSidebar();
  } else {
    console.warn('[faith-chat] send dm failed', result);
    alert('Failed to send, please try again');
  }
}

// ---------------- Boot ----------------
async function connectAndRender() {
  setupEngineOnce();
  const connectResult = await NCEngine.connect({ token: session.accessToken });
  if (!connectResult.isOk) {
    clearSession();
    renderGate('Failed to connect to the chat service, please try again');
    return;
  }

  openChannel = new OpenChannel(ROOM_ID);
  // TEMPORARY: exposed for one-off cleanup of test messages from console.
  // Will be removed in the very next commit.
  window.__debugCleanup = { openChannel, OpenChannel, OpenChannelIdentifier, BaseChannel, ROOM_ID, roomMessages };
  await loadRoomHistory();
  await openChannel.enterChannel({ messageCount: 100 });

  if (!session.isChristian) {
    dmChannels.set(CHRISTIAN_ID, new DirectChannel(CHRISTIAN_ID));
    peers.set(CHRISTIAN_ID, { name: 'Ministry Team', messages: [] });
    await loadDmHistory(CHRISTIAN_ID);
  } else {
    await loadAllDmPeers();
  }

  renderChatScreen();
}

(async function boot() {
  const existing = loadSession();
  if (existing) {
    session = existing;
    await connectAndRender();
  } else {
    renderGate();
  }
})();
