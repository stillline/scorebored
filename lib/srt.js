// SRT push to the cloud relay: passphrase, status and the output switch for
// the /network page.
//
// nginx's `application live` includes exactly one output file,
// /etc/nginx/rtmp-active.conf, a symlink to either rtmp-srt.conf (exec_push
// to the cloud relay) or rtmp-push.conf (direct push to YouTube, edited by
// lib/rtmp.js). Switching repoints the symlink and restarts nginx, which is
// what applies it to the session that is on air (a reload only affects new
// sessions); the ATEM reconnects by itself within a few seconds.
//
// nginx-rtmp runs /usr/local/bin/srt-push (exec_push in
// /etc/nginx/rtmp-srt.conf) for every stream the ATEM publishes. That script
// reads the SRT passphrase from /etc/srt-relay/passphrase (root:www-data 640,
// readable by the nginx worker that spawns it). This module lets the page set
// that passphrase and see whether a push is running. The passphrase itself is
// never sent back to the browser or written to any log.

const { execFile } = require('child_process');

const PASS_FILE = '/etc/srt-relay/passphrase';
const PUSH_SCRIPT = '/usr/local/bin/srt-push';
const RELAY = 'srt://54.190.49.121:8890 (relay.onlygoals.tv)';
const PASS_RE = /^[0-9a-f]{32}$/;
const ACTIVE_LINK = '/etc/nginx/rtmp-active.conf';
const MODES = { srt: 'rtmp-srt.conf', rtmp: 'rtmp-push.conf' };

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
    if (input !== undefined) { proc.stdin.write(input); proc.stdin.end(); }
  });
}
const sudo = (args, input) => run('sudo', ['-n', ...args], input);

/** Is the passphrase file populated with something that looks valid? Never returns the value. */
async function passphraseSet() {
  const data = await sudo(['cat', PASS_FILE]).catch(() => '');
  return PASS_RE.test(data.trim());
}

/** PIDs of running srt-push ffmpeg processes (normally 0 or 1). */
async function pushPids() {
  const out = await run('pgrep', ['-f', 'ffmpeg .* -f mpegts srt://']).catch(() => '');
  return out.split('\n').filter(Boolean).map(Number);
}

/** Last few srt-push journal lines. The script redacts the passphrase before logging. */
async function recentLog(lines = 8) {
  const out = await run('journalctl', ['-t', 'srt-push', '-n', String(lines), '--no-pager', '-o', 'short-iso']).catch(() => '');
  return out.split('\n').filter((l) => l && !l.startsWith('-- '));
}

/** Which output nginx is configured for: 'srt', 'rtmp', or null if the link points elsewhere. */
async function readMode() {
  const target = (await run('readlink', [ACTIVE_LINK]).catch(() => '')).trim();
  return Object.keys(MODES).find((m) => MODES[m] === target) || null;
}

async function setMode(mode) {
  const previous = await readMode();
  await sudo(['ln', '-sfn', MODES[mode], ACTIVE_LINK]);
  try {
    await sudo(['nginx', '-t']);
  } catch (e) {
    if (previous) await sudo(['ln', '-sfn', MODES[previous], ACTIVE_LINK]);
    throw new Error('nginx rejected the switch; previous output kept: ' + e.message);
  }
  await sudo(['systemctl', 'restart', 'nginx']);
}

async function status() {
  const [mode, set, pids, log] = await Promise.all([readMode(), passphraseSet(), pushPids(), recentLog()]);
  return { mode, relay: RELAY, passphraseSet: set, pushRunning: pids.length > 0, pushPids: pids, log };
}

async function setPassphrase(pass) {
  await sudo(['tee', PASS_FILE], pass + '\n');
  await sudo(['chown', 'root:www-data', PASS_FILE]);
  await sudo(['chmod', '640', PASS_FILE]);
  // A push already running was started with the old passphrase (or none):
  // kill it and nginx respawns it in 5 s with the new one.
  const pids = await pushPids();
  if (pids.length) await sudo(['kill', ...pids.map(String)]).catch(() => {});
  return pids.length > 0;
}

/** Registers the SRT relay socket events on a connected socket. */
function registerSrtSocketHandlers(socket) {
  socket.on('getSrtRelayStatus', (callback) => {
    status().then(callback).catch((err) => callback({ error: err.message }));
  });

  socket.on('setRelayMode', ({ mode }, callback) => {
    if (!MODES[mode]) return callback({ error: 'mode must be "srt" or "rtmp"' });
    setMode(mode)
      .then(() => {
        console.log(`Stream output switched to ${mode === 'srt' ? 'cloud relay (SRT)' : 'direct YouTube push'}; nginx restarted`);
        callback({ ok: true, restarted: true });
      })
      .catch((err) => callback({ error: err.message }));
  });

  socket.on('setSrtPassphrase', ({ passphrase }, callback) => {
    const pass = (passphrase || '').trim().toLowerCase();
    if (!PASS_RE.test(pass)) return callback({ error: 'Passphrase must be 32 hex characters (0-9, a-f)' });
    setPassphrase(pass)
      .then((restarted) => {
        console.log(`SRT relay passphrase updated${restarted ? '; running push restarted' : ''}`);
        callback({ ok: true, restarted });
      })
      .catch((err) => callback({ error: err.message }));
  });
}

module.exports = { registerSrtSocketHandlers, PUSH_SCRIPT };
