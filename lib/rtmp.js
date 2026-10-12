// RTMP destination editor for the live relay.
//
// nginx-rtmp pushes whatever the ATEM publishes to one fixed URL. That URL
// lives in /etc/nginx/rtmp-push.conf (root-only, included from nginx.conf's
// `application live` block) so the stream key is not in a world-readable
// file. This module lets the /network page read and change it, then
// restarts nginx so the change applies to the *current* session: a reload
// only affects new sessions, and the ATEM reconnects by itself within a few
// seconds of a restart.
//
// Presets (saved base URL + key combos) live client-side in network.html's
// localStorage.

const { execFile } = require('child_process');

const PUSH_CONF = '/etc/nginx/rtmp-push.conf';

function sudo(args, input) {
  return new Promise((resolve, reject) => {
    const proc = execFile('sudo', ['-n', ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
    if (input !== undefined) { proc.stdin.write(input); proc.stdin.end(); }
  });
}

async function readDest() {
  const data = await sudo(['cat', PUSH_CONF]);
  const m = data.match(/^\s*push\s+(rtmp:\/\/[^\s;]+);/m);
  if (!m) throw new Error(`No push line found in ${PUSH_CONF}`);
  const fullUrl = m[1];
  const lastSlash = fullUrl.lastIndexOf('/');
  return { baseUrl: fullUrl.substring(0, lastSlash), streamKey: fullUrl.substring(lastSlash + 1), fullUrl };
}

async function writeDest(baseUrl, streamKey) {
  const previous = await sudo(['cat', PUSH_CONF]);
  const content =
    '# Managed by scorebored (/network page, lib/rtmp.js). Root-only: holds the stream key.\n' +
    `push ${baseUrl}/${streamKey};\n`;
  await sudo(['tee', PUSH_CONF], content);
  try {
    await sudo(['nginx', '-t']);
  } catch (e) {
    await sudo(['tee', PUSH_CONF], previous); // roll back, leave nginx untouched
    throw new Error('nginx rejected the new destination; previous one kept: ' + e.message);
  }
  await sudo(['systemctl', 'restart', 'nginx']);
}

/** Registers the RTMP destination socket events on a connected socket. */
function registerRtmpSocketHandlers(socket) {
  socket.on('getNginxStreamDest', (callback) => {
    readDest().then(callback).catch((err) => callback({ error: err.message }));
  });

  socket.on('setNginxStreamDest', ({ baseUrl, streamKey }, callback) => {
    if (!baseUrl || !streamKey) return callback({ error: 'baseUrl and streamKey are required' });
    if (!/^rtmp:\/\/[a-zA-Z0-9._\-/:]+$/.test(baseUrl)) return callback({ error: 'Invalid base URL' });
    if (!/^[a-zA-Z0-9._\-]+$/.test(streamKey)) return callback({ error: 'Invalid stream key' });
    writeDest(baseUrl.replace(/\/+$/, ''), streamKey)
      .then(() => {
        console.log(`RTMP destination changed to ${baseUrl}/...${streamKey.slice(-4)}; nginx restarted`);
        callback({ ok: true, restarted: true });
      })
      .catch((err) => callback({ error: err.message }));
  });
}

module.exports = { registerRtmpSocketHandlers };
