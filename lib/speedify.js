// Speedify bonding stats: a persistent `speedify_cli -s stats` subprocess
// that streams live per-adapter bandwidth/quality JSON lines, broadcast to
// every connected display/dashboard over socket.io, plus a handful of
// one-shot `speedify_cli` queries the network dashboard calls on demand.

const { spawn, exec } = require('child_process');

/** Starts the persistent stats subprocess, restarting it on exit/error. Call once at startup. */
function startSpeedifyStats(io) {
  let speedifyProc = null;

  function start() {
    if (speedifyProc) return;
    console.log('Starting speedify_cli stats subprocess...');

    speedifyProc = spawn('speedify_cli', ['-s', 'stats']);
    let buffer = '';

    speedifyProc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer
      lines.forEach(line => {
        line = line.trim();
        if (!line) return;
        try {
          const parsed = JSON.parse(line);
          // Output format is ["type", {data}] arrays
          if (Array.isArray(parsed) && parsed.length === 2) {
            const msg = parsed[1];
            msg.type = parsed[0];
            io.emit('speedifyStats', msg);
          }
        } catch (e) {
          // not valid JSON, skip
        }
      });
    });

    speedifyProc.stderr.on('data', (chunk) => {
      console.error('speedify_cli stderr:', chunk.toString());
    });

    speedifyProc.on('close', (code) => {
      console.log(`speedify_cli stats exited with code ${code}, restarting in 5s...`);
      speedifyProc = null;
      setTimeout(start, 5000);
    });

    speedifyProc.on('error', (err) => {
      console.error('speedify_cli spawn error:', err.message);
      speedifyProc = null;
      setTimeout(start, 10000);
    });
  }

  start();
  return {
    stop: () => { if (speedifyProc) speedifyProc.kill(); },
  };
}

/** Registers the one-shot speedify_cli query socket events on a connected socket. */
function registerSpeedifySocketHandlers(socket) {
  socket.on('getSpeedifyState', (callback) => {
    exec('speedify_cli state', (err, stdout) => {
      if (err) return callback({ error: err.message });
      try { callback({ data: JSON.parse(stdout) }); }
      catch (e) { callback({ data: stdout.trim() }); }
    });
  });

  socket.on('getSpeedifyAdapters', (callback) => {
    exec('speedify_cli show adapters', (err, stdout) => {
      if (err) return callback({ error: err.message });
      try { callback({ data: JSON.parse(stdout) }); }
      catch (e) { callback({ error: 'Parse error' }); }
    });
  });

  socket.on('getSpeedifyServer', (callback) => {
    exec('speedify_cli show currentserver', (err, stdout) => {
      if (err) return callback({ error: err.message });
      try { callback({ data: JSON.parse(stdout) }); }
      catch (e) { callback({ error: 'Parse error' }); }
    });
  });

  socket.on('getSpeedifySettings', (callback) => {
    exec('speedify_cli show settings', (err, stdout) => {
      if (err) return callback({ error: err.message });
      try { callback({ data: JSON.parse(stdout) }); }
      catch (e) { callback({ error: 'Parse error' }); }
    });
  });

  socket.on('runStreamTest', (callback) => {
    exec('speedify_cli streamtest', { timeout: 90000 }, (err, stdout, stderr) => {
      if (err) return callback({ error: err.message + (stderr ? ' | ' + stderr.trim() : '') });
      try { callback({ data: JSON.parse(stdout) }); }
      catch (e) { callback({ data: stdout.trim() }); }
    });
  });
}

module.exports = { startSpeedifyStats, registerSpeedifySocketHandlers };
