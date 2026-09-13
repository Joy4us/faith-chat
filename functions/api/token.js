// Cloudflare Pages Function: POST /api/token
// Issues a Nexconn chat access token for either an anonymous guest, or the
// fixed "christian" identity (gated by a passcode kept server-side only).
//
// Required environment variables (set as Cloudflare Pages secrets, never in code):
//   NEXCONN_APP_KEY       - Nexconn App Key
//   NEXCONN_APP_SECRET    - Nexconn App Secret (never sent to the client)
//   CHRISTIAN_PASSCODE    - shared passphrase that unlocks the "christian" identity
// Optional:
//   NEXCONN_API_HOST      - defaults to Singapore data center
//   CHRISTIAN_USER_ID     - defaults to "christian"

const DEFAULT_API_HOST = 'api.sg-light-api.com';
const AREA_CODE_SG = 2; // must match AreaCode.SG in @nexconn/engine

function randomNonce(len = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function sha1Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomGuestId() {
  return 'guest_' + randomNonce(10).toLowerCase();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request format' }, 400);
  }

  const displayName = (body.displayName || '').toString().trim().slice(0, 24);
  const mode = body.mode === 'christian' ? 'christian' : 'guest';

  if (!displayName) {
    return json({ error: 'Please enter a nickname' }, 400);
  }

  if (!env.NEXCONN_APP_KEY || !env.NEXCONN_APP_SECRET) {
    return json({ error: 'The service is not configured yet, please contact the admin' }, 500);
  }

  let userId;
  if (mode === 'christian') {
    if (!env.CHRISTIAN_PASSCODE || body.passcode !== env.CHRISTIAN_PASSCODE) {
      return json({ error: 'Incorrect passcode' }, 403);
    }
    userId = env.CHRISTIAN_USER_ID || 'christian';
  } else {
    userId = randomGuestId();
  }

  const apiHost = env.NEXCONN_API_HOST || DEFAULT_API_HOST;
  const nonce = randomNonce(16);
  const timestamp = Date.now().toString();
  const signature = await sha1Hex(env.NEXCONN_APP_SECRET + nonce + timestamp);

  let upstream;
  try {
    upstream = await fetch(`https://${apiHost}/v4/auth/access-token/issue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'App-Key': env.NEXCONN_APP_KEY,
        Nonce: nonce,
        Timestamp: timestamp,
        Signature: signature,
      },
      body: JSON.stringify({
        userId,
        name: displayName,
        avatarUrl: '',
      }),
    });
  } catch (e) {
    return json({ error: 'Could not reach the chat service, please try again later' }, 502);
  }

  let data;
  try {
    data = await upstream.json();
  } catch (e) {
    return json({ error: 'The chat service returned an unexpected response' }, 502);
  }

  if (!upstream.ok || data.code !== 0 || !data.result?.accessToken) {
    return json({ error: 'Failed to obtain an access token', detail: data }, 502);
  }

  return json({
    userId: data.result.userId,
    accessToken: data.result.accessToken,
    appKey: env.NEXCONN_APP_KEY,
    areaCode: AREA_CODE_SG,
    displayName,
    isChristian: mode === 'christian',
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
