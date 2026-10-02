// RTMP destination editor: reads/writes the STREAM_URL inside an external
// streaming script (not part of this repo) so the operator can repoint the
// relay at a different ingest without SSHing in. Preset management (saved
// base URL + key combos) lives entirely client-side in network.html's
// localStorage - nothing to do here.

const fs = require('fs');
const { exec } = require('child_process');

const SEND_BUFFER_SCRIPT = '/usr/local/bin/pi-send-buffer.sh';

/** Registers the RTMP destination socket events on a connected socket. */
function registerRtmpSocketHandlers(socket) {
  socket.on('getNginxStreamDest', (callback) => {
    fs.readFile(SEND_BUFFER_SCRIPT, 'utf8', (err, data) => {
      if (err) return callback({ error: err.message });
      const m = data.match(/^STREAM_URL="(rtmp:\/\/[^"]+)"/m);
      if (!m) return callback({ error: 'No STREAM_URL found in pi-send-buffer.sh' });
      const fullUrl = m[1];
      const lastSlash = fullUrl.lastIndexOf('/');
      const baseUrl = fullUrl.substring(0, lastSlash);
      const streamKey = fullUrl.substring(lastSlash + 1);
      callback({ baseUrl, streamKey, fullUrl });
    });
  });

  socket.on('setNginxStreamDest', ({ baseUrl, streamKey }, callback) => {
    if (!baseUrl || !streamKey) return callback({ error: 'baseUrl and streamKey are required' });
    if (!/^rtmp:\/\/[a-zA-Z0-9._\-/:]+$/.test(baseUrl)) return callback({ error: 'Invalid base URL' });
    if (!/^[a-zA-Z0-9._\-]+$/.test(streamKey)) return callback({ error: 'Invalid stream key' });
    const newUrl = `${baseUrl}/${streamKey}`;

    fs.readFile(SEND_BUFFER_SCRIPT, 'utf8', (err, data) => {
      if (err) return callback({ error: 'Failed to read script: ' + err.message });
      if (!/^STREAM_URL="rtmp:\/\/[^"]+"/m.test(data)) return callback({ error: 'Could not locate STREAM_URL in script' });
      const updated = data.replace(/^(STREAM_URL=")rtmp:\/\/[^"]+(")/m, `$1${newUrl}$2`);

      const proc = exec(`sudo tee ${SEND_BUFFER_SCRIPT}`, (err2) => {
        if (err2) return callback({ error: 'Failed to write script: ' + err2.message });
        callback({ ok: true });
      });
      proc.stdin.write(updated);
      proc.stdin.end();
    });
  });
}

module.exports = { registerRtmpSocketHandlers };
