import {
  NCEngine,
  LogLevel,
  ChannelType,
  OpenChannel,
  DirectChannel,
  SendTextMessageParams,
  MessageHandler,
  ConnectionStatusHandler,
  OpenChannelHandler,
} from '@nexconn/chat';

const ROOM_ID = 'welcome-room';
const CHRISTIAN_ID = 'christian';
const SESSION_KEY = 'faithchat_session_v1';

const app = document.getElementById('app');

let session = null; // {userId, accessToken, appKey, areaCode, displayName, isChristian}
let openChannel = null;
const dmChannels = new Map(); // peerId -> DirectChannel instance
const peers = new Map(); // peerId -> {name, messages: []}
const roomMessages = [];
let activeTab = 'room';
let activePeer = null;
let engineReady = false;

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
      <h1>Chat with Christian</h1>
      <p class="sub">A public space to talk about faith. Come say hello — the public room is visible to everyone, and you can also send a private 1:1 message.</p>
      <input id="nameInput" type="text" placeholder="Your nickname (strangers welcome)" maxlength="24" />
      <div class="passcode-row" id="passRow">
        <input id="passInput" type="password" placeholder="Access passcode" />
      </div>
      <button id="enterBtn">Enter chat</button>
      <button class="toggle" id="modeToggle">I am Christian &#8594;</button>
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
    modeToggle.textContent = isChristianMode ? '← I am a guest' : 'I am Christian →';
    nameInput.placeholder = isChristianMode ? 'Display name (e.g. Christian)' : 'Your nickname (strangers welcome)';
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

function handleIncomingMessage(message) {
  // We already render our own outgoing messages locally on send; skip echoes.
  if (message.senderUserId === session.userId) return;

  const ch = message.channelIdentifier;
  const renderable = {
    mine: false,
    name: message.content?.senderUserInfo?.name || message.senderUserId,
    text: message.content?.text ?? '[unsupported message type]',
    time: message.sentTime || Date.now(),
  };

  if (ch.channelType === ChannelType.OPEN && ch.channelId === ROOM_ID) {
    roomMessages.push(renderable);
    if (activeTab === 'room') renderRoomMessages();
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
  }
}

// ---------------- Chat screen ----------------
function renderChatScreen() {
  app.innerHTML = `
    <div class="chat-screen show">
      <div class="topbar">
        <strong>${session.isChristian ? '&#10013; Christian (me)' : 'Chat with Christian'}</strong>
        <span class="whoami-wrap">
          <span class="whoami">${escapeHtml(session.displayName)}${session.isChristian ? '' : ' · guest'}</span>
          <button class="logout-link" id="logoutBtn" title="Log out and use a different name">Switch</button>
        </span>
      </div>
      <div class="tabs">
        <button data-tab="room" class="${activeTab === 'room' ? 'active' : ''}">Public room</button>
        <button data-tab="dm" class="${activeTab === 'dm' ? 'active' : ''}">${session.isChristian ? 'Direct messages' : 'Message Christian'}</button>
      </div>
      <div class="panels">
        <div class="panel ${activeTab === 'room' ? 'active' : ''}" id="roomPanel">
          <div class="thread-wrap">
            <div class="messages" id="roomMessages"></div>
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
            <div class="composer">
              <input id="dmInput" type="text" placeholder="${session.isChristian ? 'Select a guest on the left to reply...' : 'Send Christian a private message...'}" />
              <button id="dmSend">Send</button>
            </div>
          </div>
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

  if (activeTab === 'room') renderRoomMessages();
  if (activeTab === 'dm') { renderPeerSidebar(); renderDmMessages(); }
}

function bubbleHtml(m) {
  const time = new Date(m.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `<div class="msg ${m.mine ? 'me' : 'them'}"><div class="meta">${escapeHtml(m.name)} · ${time}</div>${escapeHtml(m.text)}</div>`;
}

function renderRoomMessages() {
  const box = document.getElementById('roomMessages');
  if (!box) return;
  box.innerHTML = roomMessages.length
    ? roomMessages.map(bubbleHtml).join('')
    : '<div class="empty-hint">No one has spoken yet — say hello \u{1F44B}</div>';
  box.scrollTop = box.scrollHeight;
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
  box.innerHTML = msgs.length ? msgs.map(bubbleHtml).join('') : '<div class="empty-hint">No messages yet — say something</div>';
  box.scrollTop = box.scrollHeight;
}

// ---------------- Sending ----------------
async function sendRoomMessage() {
  const input = document.getElementById('roomInput');
  const text = input.value.trim();
  if (!text || !openChannel) return;
  input.value = '';
  const params = new SendTextMessageParams({ text, senderUserInfo: { name: session.displayName } });
  const result = await openChannel.sendMessage(params);
  if (result.isOk) {
    roomMessages.push({ mine: true, name: session.displayName + ' (me)', text, time: Date.now() });
    renderRoomMessages();
  } else {
    console.warn('[faith-chat] send room message failed', result);
    alert('Failed to send, please try again');
  }
}

async function sendDmMessage() {
  const input = document.getElementById('dmInput');
  const text = input.value.trim();
  if (!text) return;
  const peerId = session.isChristian ? activePeer : CHRISTIAN_ID;
  if (!peerId) { alert('Please select a guest on the left first'); return; }
  input.value = '';
  if (!dmChannels.has(peerId)) dmChannels.set(peerId, new DirectChannel(peerId));
  const channel = dmChannels.get(peerId);
  const params = new SendTextMessageParams({ text, senderUserInfo: { name: session.displayName } });
  const result = await channel.sendMessage(params);
  if (result.isOk) {
    if (!peers.has(peerId)) peers.set(peerId, { name: peerId, messages: [] });
    peers.get(peerId).messages.push({ mine: true, name: session.displayName + ' (me)', text, time: Date.now() });
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
  await openChannel.enterChannel({ messageCount: 30 });

  if (!session.isChristian) {
    dmChannels.set(CHRISTIAN_ID, new DirectChannel(CHRISTIAN_ID));
    peers.set(CHRISTIAN_ID, { name: 'Christian', messages: [] });
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
