// Tater Talk - main program
// Runs the window, the TikTok / Twitch / YouTube connections, Fish Audio, and the on-stream widgets.

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');

// Keep settings in the same folder whether running from cmd or the installed app,
// so your Fish key, sounds, voices and theme carry over.
app.setPath('userData', path.join(app.getPath('appData'), 'tatertalk'));

let win = null;
let identityDebugShown = false;
let giftDebugShown = false;
let fishDebugShown = false;

// One live connection per platform
const conns = { tiktok: null, twitch: null, youtube: null };

const AUDIO_TYPES = ['.mp3', '.wav', '.ogg', '.m4a'];

function createWindow() {
  win = new BrowserWindow({
    width: 1150,
    height: 860,
    title: 'Tater Talk',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#05060d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
}

// Sends info from here to the app window
function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function sendEvent(platform, ev) {
  ev.platform = platform;
  send('stream-event', ev);
}

function sendStatus(platform, state, text) {
  send('stream-status', { platform: platform, state: state, text: text });
}

// Turns data into text safely (TikTok uses some extra-big numbers)
function safeJson(value) {
  try {
    return JSON.stringify(value, (k, v) => typeof v === 'bigint' ? v.toString() : v);
  } catch (e) {
    return '(could not show)';
  }
}

// =====================================================
//  TIKTOK
// =====================================================
function ttUser(data) {
  const u = data.user || {};
  return {
    handle: u.displayId || u.uniqueId || data.uniqueId || 'someone',
    nickname: u.nickname || u.nickName || u.displayId || u.uniqueId || 'someone'
  };
}

function ttRoles(data) {
  const id = data.userIdentity || {};
  return {
    isHost: !!id.isAnchor,
    isMod: !!(id.isModeratorOfAnchor || data.isModerator),
    isSuperFan: !!(id.isSubscriberOfAnchor || data.isSubscriber),
    isFollower: !!(id.isFollowerOfAnchor || id.isMutualFollowingWithAnchor || data.followRole >= 1)
  };
}

function ttGiftImage(data) {
  const d = data.giftDetails || {};
  return (
    d.giftImage?.giftPictureUrl ||
    d.image?.urlList?.[0] || d.image?.url_list?.[0] ||
    d.icon?.urlList?.[0] || d.icon?.url_list?.[0] ||
    data.giftPictureUrl || ''
  );
}

async function connectTikTok(username) {
  const { TikTokLiveConnection } = await import('tiktok-live-connector');

  // processInitialData: false = skip old chat history when joining
  const conn = new TikTokLiveConnection(username, { processInitialData: false });
  conns.tiktok = conn;

  conn.on('chat', data => {
    if (!identityDebugShown) {
      identityDebugShown = true;
      console.log('[Tater Talk debug] userIdentity:', safeJson(data.userIdentity || {}));
    }
    sendEvent('tiktok', {
      type: 'chat', user: ttUser(data), roles: ttRoles(data),
      text: data.content || data.comment || ''
    });
  });

  conn.on('gift', data => {
    const isStreakGift = data.giftType === 1 || data.giftDetails?.giftType === 1;
    if (isStreakGift && !data.repeatEnd) return; // wait until the streak ends

    const giftName =
      data.giftDetails?.giftName || data.gift?.name || data.extendedGiftInfo?.name ||
      data.giftName || ('gift #' + data.giftId);

    const ev = {
      type: 'gift', user: ttUser(data), roles: ttRoles(data),
      giftId: String(data.giftId ?? data.giftDetails?.id ?? ''),
      giftName: giftName,
      coins: Number(data.giftDetails?.diamondCount ?? data.diamondCount ?? 0) || 0,
      image: ttGiftImage(data),
      count: data.repeatCount || data.comboCount || 1
    };

    if (!giftDebugShown) {
      giftDebugShown = true;
      console.log('[Tater Talk debug] first gift:', safeJson({
        id: ev.giftId, name: ev.giftName, coins: ev.coins, image: ev.image ? 'yes' : 'NO'
      }));
    }
    sendEvent('tiktok', ev);
  });

  conn.on('follow', data => {
    sendEvent('tiktok', { type: 'follow', user: ttUser(data), roles: ttRoles(data) });
  });

  conn.on('member', data => {
    sendEvent('tiktok', { type: 'join', user: ttUser(data), roles: ttRoles(data) });
  });

  conn.on('streamEnd', () => {
    if (conns.tiktok === conn) conns.tiktok = null;
    sendStatus('tiktok', 'off', 'TikTok stream ended.');
  });

  conn.on('disconnected', () => {
    if (conns.tiktok === conn) {
      conns.tiktok = null;
      sendStatus('tiktok', 'off', 'TikTok disconnected.');
    }
  });

  await conn.connect();
}

// =====================================================
//  TWITCH (reads chat anonymously - no login needed)
// =====================================================
function twUser(tags) {
  return {
    handle: String(tags.username || tags.login || '').toLowerCase() || 'someone',
    nickname: tags['display-name'] || tags.username || tags.login || 'someone'
  };
}

function twRoles(tags) {
  const b = tags.badges || {};
  return {
    isHost: !!b.broadcaster,
    isMod: !!(tags.mod || b.moderator),
    isSuperFan: !!(tags.subscriber || b.subscriber || b.founder),
    isFollower: false
  };
}

async function connectTwitch(channel, opts) {
  const tmi = require('tmi.js');
  channel = channel.toLowerCase();
  const client = new tmi.Client({
    connection: { secure: true, reconnect: true },
    channels: [channel]
  });
  conns.twitch = client;

  client.on('message', (ch, tags, message, self) => {
    if (self) return;
    if (tags.bits) return; // cheers are handled below
    sendEvent('twitch', { type: 'chat', user: twUser(tags), roles: twRoles(tags), text: message || '' });
  });

  client.on('cheer', (ch, tags, message) => {
    sendEvent('twitch', {
      type: 'bits', user: twUser(tags), roles: twRoles(tags),
      amount: Number(tags.bits) || 0,
      text: String(message || '').replace(/\b[a-z]+\d+\b/gi, '').replace(/\s+/g, ' ').trim()
    });
  });

  client.on('subscription', (ch, username, methods, message, tags) => {
    sendEvent('twitch', {
      type: 'sub', user: twUser(tags), roles: twRoles(tags),
      months: 1, prime: !!(methods && methods.prime), text: message || ''
    });
  });

  client.on('resub', (ch, username, months, message, tags, methods) => {
    sendEvent('twitch', {
      type: 'sub', user: twUser(tags), roles: twRoles(tags),
      months: Number(tags['msg-param-cumulative-months']) || Number(months) || 1,
      prime: !!(methods && methods.prime), text: message || ''
    });
  });

  // Someone gifted a batch of subs (the individual gifts are skipped so it only alerts once)
  const recentMystery = new Map();
  client.on('submysterygift', (ch, username, count, methods, tags) => {
    const key = String(username || '').toLowerCase();
    recentMystery.set(key, (recentMystery.get(key) || 0) + (Number(count) || 1));
    setTimeout(() => recentMystery.delete(key), 15000);
    sendEvent('twitch', { type: 'subgift', user: twUser(tags), roles: twRoles(tags), count: Number(count) || 1 });
  });

  client.on('subgift', (ch, username, streak, recipient, methods, tags) => {
    const key = String(username || '').toLowerCase();
    const left = recentMystery.get(key) || 0;
    if (left > 0) { recentMystery.set(key, left - 1); return; } // part of a batch already announced
    sendEvent('twitch', { type: 'subgift', user: twUser(tags), roles: twRoles(tags), count: 1, recipient: recipient || '' });
  });

  client.on('raided', (ch, username, viewers) => {
    sendEvent('twitch', {
      type: 'raid',
      user: { handle: String(username || '').toLowerCase(), nickname: username || 'someone' },
      roles: {}, viewers: Number(viewers) || 0
    });
  });

  client.on('disconnected', reason => {
    if (conns.twitch === client) {
      sendStatus('twitch', 'off', 'Twitch disconnected' + (reason ? ': ' + reason : '.'));
      conns.twitch = null;
    }
  });

  await client.connect();

  // Follow alerts (only if you've logged in with Twitch)
  if (opts && opts.token && opts.clientId) {
    startTwitchFollows(channel, opts.clientId, opts.token).catch(err => {
      const msg = (err && err.message) || String(err);
      send('twitch-follows', { state: err && err.expired ? 'expired' : 'err', text: msg });
    });
  }
}

// =====================================================
//  TWITCH FOLLOWS (EventSub - needs a Twitch login)
// =====================================================
const TWITCH_REDIRECT = 'http://localhost:4848/twitch-auth';
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
let twFollow = null;

function getWebSocket() {
  if (globalThis.WebSocket) return globalThis.WebSocket;
  return require('ws');
}

async function helix(pathAndQuery, clientId, token, options) {
  const res = await fetch('https://api.twitch.tv/helix/' + pathAndQuery, Object.assign({}, options, {
    headers: { 'Client-Id': clientId, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000)
  }));
  let body = null;
  try { body = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, body: body };
}

async function validateTwitchToken(token) {
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: 'OAuth ' + token },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const e = new Error('Your Twitch login expired. Click "Log in with Twitch" again.');
    e.expired = true;
    throw e;
  }
  return res.json(); // { client_id, login, user_id, scopes, expires_in }
}

function stopTwitchFollows() {
  const st = twFollow;
  twFollow = null;
  if (!st) return;
  st.stopped = true;
  try { st.ws && st.ws.close(); } catch (e) {}
}

async function startTwitchFollows(channel, clientId, token) {
  stopTwitchFollows();
  const me = await validateTwitchToken(token);
  if (!(me.scopes || []).includes('moderator:read:followers')) {
    const e = new Error('Your Twitch login is missing follow permission. Click "Log in again".');
    e.expired = true;
    throw e;
  }

  let broadcasterId = me.user_id;
  if (String(channel).toLowerCase() !== String(me.login).toLowerCase()) {
    const u = await helix('users?login=' + encodeURIComponent(channel), clientId, token);
    const found = u.body && u.body.data && u.body.data[0];
    if (!found) throw new Error('Could not find the Twitch channel "' + channel + '".');
    broadcasterId = found.id;
  }

  const st = { stopped: false, ws: null, seen: new Set() };
  twFollow = st;

  function open(url, subscribe) {
    if (st.stopped) return;
    const WS = getWebSocket();
    const ws = new WS(url);
    st.ws = ws;

    ws.onmessage = async e => {
      let m;
      try { m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString()); } catch (x) { return; }
      const type = m.metadata && m.metadata.message_type;

      if (type === 'session_welcome' && subscribe) {
        const r = await helix('eventsub/subscriptions', clientId, token, {
          method: 'POST',
          body: JSON.stringify({
            type: 'channel.follow',
            version: '2',
            condition: { broadcaster_user_id: broadcasterId, moderator_user_id: me.user_id },
            transport: { method: 'websocket', session_id: m.payload.session.id }
          })
        });
        if (st.stopped) return;
        if (r.ok) {
          send('twitch-follows', { state: 'on', text: 'Follow alerts on' });
        } else {
          let text = (r.body && r.body.message) || ('Twitch error ' + r.status);
          if (r.status === 403) text = 'Twitch says you must be the streamer or a mod of ' + channel + ' to see its follows.';
          if (r.status === 401) text = 'Your Twitch login expired. Click "Log in with Twitch" again.';
          send('twitch-follows', { state: r.status === 401 ? 'expired' : 'err', text: text });
          stopTwitchFollows();
        }
      } else if (type === 'notification') {
        const id = m.metadata.message_id;
        if (st.seen.has(id)) return;
        st.seen.add(id);
        if (st.seen.size > 500) st.seen.clear();
        const ev = (m.payload && m.payload.event) || {};
        sendEvent('twitch', {
          type: 'follow',
          user: { handle: String(ev.user_login || '').toLowerCase() || 'someone', nickname: ev.user_name || ev.user_login || 'someone' },
          roles: {}
        });
      } else if (type === 'session_reconnect') {
        open(m.payload.session.reconnect_url, false);
      } else if (type === 'revocation') {
        send('twitch-follows', { state: 'err', text: 'Twitch turned off follow alerts (' + ((m.payload.subscription || {}).status || 'revoked') + '). Try logging in again.' });
      }
    };

    ws.onclose = () => {
      if (st.stopped || twFollow !== st || st.ws !== ws) return;
      // Unexpected drop: reconnect and subscribe again
      setTimeout(() => open(EVENTSUB_URL, true), 5000);
    };
  }

  open(EVENTSUB_URL, true);
}

// Opens a Twitch login window and catches the login token
ipcMain.handle('twitch-login', async (event, clientId) => {
  clientId = String(clientId || '').trim();
  if (!clientId) return { ok: false, error: 'Paste your Twitch Client ID first.' };

  const stateCode = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const authUrl = 'https://id.twitch.tv/oauth2/authorize?' + new URLSearchParams({
    response_type: 'token',
    client_id: clientId,
    redirect_uri: TWITCH_REDIRECT,
    scope: 'moderator:read:followers',
    state: stateCode,
    force_verify: 'true'
  }).toString();

  const result = await new Promise(resolve => {
    const authWin = new BrowserWindow({
      width: 520, height: 780, parent: win, title: 'Log in with Twitch',
      autoHideMenuBar: true, backgroundColor: '#0e0e10',
      webPreferences: { partition: 'persist:twitchauth' }
    });
    let done = false;
    const finish = r => {
      if (done) return;
      done = true;
      resolve(r);
      if (!authWin.isDestroyed()) authWin.close();
    };
    const check = url => {
      if (!url || !String(url).startsWith(TWITCH_REDIRECT)) return false;
      const [beforeHash, hash] = String(url).split('#');
      const query = beforeHash.split('?')[1] || '';
      const p = new URLSearchParams(hash || query);
      if (p.get('access_token')) {
        if (p.get('state') && p.get('state') !== stateCode) finish({ ok: false, error: 'Login did not match. Try again.' });
        else finish({ ok: true, token: p.get('access_token') });
      } else {
        const why = p.get('error_description') || p.get('error') || 'Login was cancelled.';
        let msg = 'Twitch login failed: ' + why;
        if (/redirect/i.test(why)) msg = 'Twitch says the redirect URL is wrong. In your Twitch app on dev.twitch.tv, the OAuth Redirect URL must be exactly ' + TWITCH_REDIRECT;
        finish({ ok: false, error: msg });
      }
      return true;
    };
    authWin.webContents.on('will-redirect', (ev, url) => { if (check(ev.url || url)) ev.preventDefault(); });
    authWin.webContents.on('will-navigate', (ev, url) => { if (check(ev.url || url)) ev.preventDefault(); });
    authWin.webContents.on('did-navigate', (ev, url) => { check(url); });
    authWin.on('closed', () => finish({ ok: false, error: 'The login window was closed before finishing.' }));
    authWin.loadURL(authUrl).catch(() => {});
  });

  if (!result.ok) return result;
  try {
    const me = await validateTwitchToken(result.token);
    return { ok: true, token: result.token, login: me.login, userId: me.user_id };
  } catch (err) {
    return { ok: false, error: 'Logged in, but Twitch would not confirm it: ' + ((err && err.message) || err) };
  }
});

// =====================================================
//  YOUTUBE (reads live chat - no API key needed)
// =====================================================
function ytTarget(input) {
  const s = String(input || '').trim();
  let m = s.match(/(?:v=|youtu\.be\/|\/live\/)([A-Za-z0-9_-]{11})/);
  if (m) return { liveId: m[1] };
  m = s.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (m) return { channelId: m[1] };
  if (/^UC[A-Za-z0-9_-]{22}$/.test(s)) return { channelId: s };
  m = s.match(/youtube\.com\/(@[A-Za-z0-9._-]+)/);
  if (m) return { handle: m[1] };
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return { liveId: s };
  return { handle: s.startsWith('@') ? s : '@' + s };
}

function ytText(message) {
  return (message || []).map(p => p.text != null ? p.text : (p.emojiText || p.alt || '')).join('').trim();
}

async function connectYouTube(input) {
  const { LiveChat } = require('youtube-chat');
  const chat = new LiveChat(ytTarget(input));
  conns.youtube = chat;

  chat.on('chat', item => {
    const a = item.author || {};
    const user = { handle: String(a.name || '').replace(/^@/, '').toLowerCase() || 'someone', nickname: a.name || 'someone' };
    const roles = { isHost: !!item.isOwner, isMod: !!item.isModerator, isSuperFan: !!item.isMembership, isFollower: false };
    const text = ytText(item.message);

    if (item.superchat) {
      sendEvent('youtube', { type: 'superchat', user, roles, amount: String(item.superchat.amount || ''), text: text });
    } else {
      sendEvent('youtube', { type: 'chat', user, roles, text: text });
    }
  });

  chat.on('end', () => {
    if (conns.youtube === chat) {
      conns.youtube = null;
      sendStatus('youtube', 'off', 'YouTube stream ended.');
    }
  });

  let lastError = '';
  chat.on('error', err => { lastError = (err && err.message) || String(err); });

  const ok = await chat.start();
  if (!ok) {
    conns.youtube = null;
    throw new Error(lastError || 'Could not find a live stream. Make sure you are live, or paste the live video link instead.');
  }
}

// =====================================================
//  Connect / disconnect (any platform)
// =====================================================
async function disconnectPlatform(platform) {
  const c = conns[platform];
  conns[platform] = null;
  if (!c) return;
  try {
    if (platform === 'tiktok') c.disconnect();
    if (platform === 'twitch') { stopTwitchFollows(); await c.disconnect(); }
    if (platform === 'youtube') c.stop();
  } catch (e) {}
}

ipcMain.handle('platform-connect', async (event, platform, name, opts) => {
  name = String(name || '').trim();
  if (platform !== 'youtube') name = name.replace(/^@/, '');
  if (!name) return { ok: false, error: 'Type a name first.' };

  await disconnectPlatform(platform);
  try {
    if (platform === 'tiktok') await connectTikTok(name);
    else if (platform === 'twitch') await connectTwitch(name, opts || {});
    else if (platform === 'youtube') await connectYouTube(name);
    else return { ok: false, error: 'Unknown platform.' };
    return { ok: true };
  } catch (err) {
    conns[platform] = null;
    let msg = (err && err.message) || String(err);
    if (/Cannot find module/.test(msg)) {
      msg = 'A piece is missing. In cmd, run: npm install tmi.js youtube-chat';
    }
    return { ok: false, error: msg };
  }
});

ipcMain.handle('platform-disconnect', async (event, platform) => {
  await disconnectPlatform(platform);
  return { ok: true };
});

// =====================================================
//  On-stream widgets (a tiny web server for OBS / LIVE Studio)
// =====================================================
const widgetClients = new Set();
let widgetSettings = {};
let resolveWidgetPort;
const widgetPortReady = new Promise(r => { resolveWidgetPort = r; });

const WIDGET_PAGES = {
  '/widget/chat': 'widget-chat.html',
  '/widget/alerts': 'widget-alerts.html'
};

function widgetBroadcast(type, data) {
  const msg = 'data: ' + JSON.stringify({ type: type, data: data }) + '\n\n';
  for (const res of widgetClients) {
    try { res.write(msg); } catch (e) {}
  }
}

function handleWidgetRequest(req, res) {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch (e) {}

  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify({ type: 'settings', data: widgetSettings }) + '\n\n');
    widgetClients.add(res);
    req.on('close', () => widgetClients.delete(res));
    return;
  }

  if (pathname === '/twitch-auth') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<body style="background:#0e0e10;color:#fff;font-family:sans-serif;text-align:center;padding-top:80px">Logged in! You can close this window.</body>');
    return;
  }

  if (WIDGET_PAGES[pathname]) {
    fs.readFile(path.join(__dirname, WIDGET_PAGES[pathname]), (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Widget file missing: ' + WIDGET_PAGES[pathname]);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Tater Talk widgets: use /widget/chat or /widget/alerts');
}

function startWidgetServer(port, tries) {
  const server = http.createServer(handleWidgetRequest);
  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && tries < 10) {
      startWidgetServer(port + 1, tries + 1);
    } else {
      console.log('[Tater Talk] Widget server could not start:', err.message);
      resolveWidgetPort(null);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('[Tater Talk] Widgets running at http://127.0.0.1:' + port);
    resolveWidgetPort(port);
  });
}

setInterval(() => {
  for (const res of widgetClients) {
    try { res.write(': ping\n\n'); } catch (e) {}
  }
}, 20000);

ipcMain.handle('widget-info', async () => ({ port: await widgetPortReady }));
ipcMain.on('widget-push', (event, data) => widgetBroadcast('event', data || {}));
ipcMain.on('widget-settings', (event, s) => {
  widgetSettings = s || {};
  widgetBroadcast('settings', widgetSettings);
});

ipcMain.handle('copy-text', (event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('open-link', (event, url) => {
  url = String(url || '');
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) shell.openExternal(url);
  return true;
});

// =====================================================
//  Sound files
// =====================================================
ipcMain.handle('pick-sound', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a sound',
    properties: ['openFile'],
    filters: [{ name: 'Sound files', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }]
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };

  const source = result.filePaths[0];
  const soundsFolder = path.join(app.getPath('userData'), 'sounds');
  fs.mkdirSync(soundsFolder, { recursive: true });
  const fileName = path.basename(source);
  const destination = path.join(soundsFolder, Date.now() + '-' + fileName);
  fs.copyFileSync(source, destination);

  return { ok: true, name: fileName, url: pathToFileURL(destination).href };
});

ipcMain.handle('import-sound-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a folder of sounds',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };

  const source = result.filePaths[0];
  const folderName = path.basename(source);
  let files = [];
  try {
    files = fs.readdirSync(source)
      .filter(f => AUDIO_TYPES.includes(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  } catch (e) {
    return { ok: false, error: 'Could not open that folder.' };
  }
  if (!files.length) {
    return { ok: false, error: 'That folder has no MP3, WAV, OGG, or M4A files in it.' };
  }

  const destFolder = path.join(app.getPath('userData'), 'sounds', 'folder-' + Date.now());
  fs.mkdirSync(destFolder, { recursive: true });

  const sounds = [];
  for (const f of files) {
    try {
      const to = path.join(destFolder, f);
      fs.copyFileSync(path.join(source, f), to);
      sounds.push({ name: path.parse(f).name, url: pathToFileURL(to).href });
    } catch (e) {}
  }

  return { ok: true, name: folderName, sounds: sounds };
});

// =====================================================
//  Fish Audio
// =====================================================
function fishUrl(u) {
  if (!u) return '';
  u = String(u);
  if (/^https?:\/\//i.test(u)) return u;
  return 'https://public-platform.r2.fish.audio/' + u.replace(/^\//, '');
}

async function fishError(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j.message || j.detail || '';
  } catch (e) {}
  if (res.status === 401 || res.status === 403) return 'Fish Audio says the API key is wrong. Check it and paste it again.';
  if (res.status === 402) return 'Your Fish Audio account is out of credit. Switch to the Free model or add credit on fish.audio.';
  if (res.status === 429) return 'Fish Audio is busy (too many requests at once). It will work again in a moment.';
  return 'Fish Audio error ' + res.status + (detail ? ': ' + detail : '');
}

ipcMain.handle('fish-search', async (event, o) => {
  o = o || {};
  const key = String(o.key || '').trim();
  if (!key) return { ok: false, error: 'Paste your Fish Audio API key first, then click Save.' };

  const params = new URLSearchParams();
  params.set('page_size', '20');
  params.set('page_number', String(o.page || 1));
  if (o.self) {
    params.set('self', 'true');
  } else {
    if (o.title) params.set('title', o.title);
    if (o.licensed) params.set('licensed', 'true');
    params.set('sort_by', o.sortBy || 'task_count');
  }

  try {
    const res = await fetch('https://api.fish.audio/model?' + params.toString(), {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) return { ok: false, error: await fishError(res) };
    const data = await res.json();
    const raw = Array.isArray(data.items) ? data.items : [];

    if (!fishDebugShown && raw.length) {
      fishDebugShown = true;
      console.log('[Tater Talk debug] first Fish voice:', safeJson({
        cover: raw[0].cover_image,
        sample: raw[0].samples && raw[0].samples[0] && raw[0].samples[0].audio
      }));
    }

    const items = raw
      .filter(m => !m.type || m.type === 'tts')
      .map(m => ({
        id: m._id,
        title: m.title || '(untitled)',
        author: (m.author && m.author.nickname) || '',
        cover: fishUrl(m.cover_image),
        uses: m.task_count || 0,
        sample: fishUrl(m.samples && m.samples[0] && m.samples[0].audio),
        licensed: !!m.licensed,
        state: m.state || ''
      }));

    return {
      ok: true,
      items: items,
      total: data.total || items.length,
      hasMore: data.has_more != null ? !!data.has_more : raw.length === 20
    };
  } catch (err) {
    return { ok: false, error: 'Could not reach Fish Audio: ' + ((err && err.message) || String(err)) };
  }
});

ipcMain.handle('fish-tts', async (event, o) => {
  o = o || {};
  const key = String(o.key || '').trim();
  if (!key) return { ok: false, error: 'No Fish Audio API key saved.' };
  if (!o.voiceId) return { ok: false, error: 'No Fish Audio voice picked.' };

  try {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        model: o.model || 's2.1-pro-free'
      },
      body: JSON.stringify({
        text: String(o.text || '').slice(0, 500),
        reference_id: o.voiceId,
        format: 'mp3',
        latency: 'balanced',
        prosody: { speed: Math.min(2, Math.max(0.5, Number(o.speed) || 1)) }
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return { ok: false, error: await fishError(res) };

    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) return { ok: false, error: 'Fish Audio sent back no audio.' };
    return { ok: true, dataUrl: 'data:audio/mpeg;base64,' + buffer.toString('base64') };
  } catch (err) {
    return { ok: false, error: 'Could not reach Fish Audio: ' + ((err && err.message) || String(err)) };
  }
});

app.whenReady().then(() => {
  startWidgetServer(4848, 0);
  createWindow();
});

app.on('window-all-closed', () => {
  Object.keys(conns).forEach(p => disconnectPlatform(p));
  app.quit();
});
