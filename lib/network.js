// Network dashboard: the Pi's own hostapd access point (channel read/set/
// scan), NetworkManager-based WiFi scan/connect, and iPhone USB-tether
// pairing (the phones auto-bond into Speedify once paired; this just covers
// the one manual step of trusting a brand new phone on site).

const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');

const VALID_5GHZ_CHANNELS = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165];

const IPHONE_NAMES_FILE = path.join(__dirname, '..', 'iphone-names.json');

function loadIphoneNames() {
  try { return JSON.parse(fs.readFileSync(IPHONE_NAMES_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveIphoneNames(names) {
  try { fs.writeFileSync(IPHONE_NAMES_FILE, JSON.stringify(names, null, 2)); } catch (e) {}
}

/** Registers the AP channel, WiFi dashboard, and iPhone pairing socket events on a connected socket. */
function registerNetworkSocketHandlers(socket) {
  // ── AP Channel Management ──

  socket.on('getApConfig', (callback) => {
    exec('cat /etc/hostapd/hostapd.conf', (err, stdout) => {
      if (err) return callback({ error: err.message });
      const chMatch = stdout.match(/^channel=(\d+)/m);
      const htMatch = stdout.match(/^ht_capab=(.+)/m);
      const channel = chMatch ? parseInt(chMatch[1]) : null;
      const htCapab = htMatch ? htMatch[1].trim() : '';
      callback({ channel, htCapab });
    });
  });

  socket.on('setApChannel', (data, callback) => {
    const ch = parseInt(data.channel);
    if (!VALID_5GHZ_CHANNELS.includes(ch)) {
      return callback({ error: 'Invalid channel number' });
    }
    // Validate channel is compatible with ht_capab before writing
    exec('cat /etc/hostapd/hostapd.conf', (err0, conf) => {
      if (!err0) {
        const htMatch = conf.match(/^ht_capab=(.+)/m);
        const htCapab = htMatch ? htMatch[1] : '';
        const hasPlus  = htCapab.includes('[HT40+]');
        const hasMinus = htCapab.includes('[HT40-]');
        const ht40PlusOnly  = [36,44,52,60,100,108,116,124,132,140,149,157];
        const ht40MinusOnly = [40,48,56,64,104,112,120,128,136,144,153,161];
        if (hasPlus && !hasMinus && !ht40PlusOnly.includes(ch)) {
          return callback({ error: `Channel ${ch} is not valid for HT40+ mode. Valid channels: ${ht40PlusOnly.join(', ')}` });
        }
        if (hasMinus && !hasPlus && !ht40MinusOnly.includes(ch)) {
          return callback({ error: `Channel ${ch} is not valid for HT40- mode. Valid channels: ${ht40MinusOnly.join(', ')}` });
        }
      }
      exec(`sudo sed -i 's/^channel=.*/channel=${ch}/' /etc/hostapd/hostapd.conf`, (err) => {
        if (err) return callback({ error: 'Failed to update hostapd.conf: ' + err.message });
        exec('sudo systemctl restart hostapd', (err2) => {
          if (err2) return callback({ error: 'Channel written but hostapd restart failed: ' + err2.message });
          console.log(`AP channel changed to ${ch}`);
          callback({ success: true, channel: ch });
        });
      });
    });
  });

  socket.on('scanApChannels', (data, callback) => {
    const iface = data.iface;
    if (!iface || /[;&|`$<>]/.test(iface)) return callback({ error: 'Invalid interface name' });
    exec(`sudo iwlist "${iface}" scan 2>&1`, { timeout: 20000 }, (err, stdout) => {
      if (err && !stdout) return callback({ error: err.message });
      // Parse each Cell block
      const channels = {};
      const blocks = stdout.split(/(?=\s*Cell \d+)/);
      blocks.forEach(block => {
        const chMatch = block.match(/Channel:(\d+)/);
        const essidMatch = block.match(/ESSID:"([^"]*)"/);
        const signalMatch = block.match(/Signal level=(-?\d+)/);
        const freqMatch = block.match(/Frequency:([\d.]+)/);
        if (!chMatch) return;
        const ch = parseInt(chMatch[1]);
        const freq = freqMatch ? parseFloat(freqMatch[1]) : 0;
        if (freq < 5) return; // skip 2.4 GHz
        const essid = essidMatch ? essidMatch[1] : '(hidden)';
        const signal = signalMatch ? parseInt(signalMatch[1]) : null;
        if (!channels[ch]) channels[ch] = [];
        channels[ch].push({ essid, signal });
      });
      callback({ channels });
    });
  });

  // ── Network Dashboard: WiFi Management ──

  socket.on('getInterfaces', (callback) => {
    exec('nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev status', (err, stdout) => {
      if (err) {
        console.error('nmcli dev status error:', err.message);
        return callback({ error: err.message });
      }
      const interfaces = [];
      stdout.trim().split('\n').forEach(line => {
        // nmcli -t uses : as separator, but connection names can contain colons
        // Format: DEVICE:TYPE:STATE:CONNECTION
        const parts = line.split(':');
        if (parts.length < 4) return;
        const dev = parts[0];
        const type = parts[1];
        const state = parts[2];
        const con = parts.slice(3).join(':');
        if (dev === 'lo' || type === 'wifi-p2p' || type === 'tun' || type === 'bridge') return;
        interfaces.push({ device: dev, type, state, connection: con === '--' ? '' : con });
      });
      callback({ interfaces });
    });
  });

  socket.on('getWifiNetworks', (data, callback) => {
    const iface = data.iface;
    if (!iface || /[;&|`$]/.test(iface)) {
      return callback({ error: 'Invalid interface name' });
    }

    // Get the active NM connection profile name (used by reconnectPrevious)
    execFile('sudo', ['nmcli', '-t', '-f', 'GENERAL.CONNECTION', 'dev', 'show', iface], (_, devOut) => {
      const previousCon = (devOut || '').match(/^GENERAL\.CONNECTION:(.+)$/m)?.[1]?.trim() || '';
      const previousConnection = previousCon === '--' ? '' : previousCon;

      // Scan via NM
      execFile('sudo', ['nmcli', '-t', '-f', 'SSID,BSSID,SECURITY,SIGNAL', 'dev', 'wifi', 'list', 'ifname', iface, '--rescan', 'yes'],
        { timeout: 15000 }, (err2, stdout2) => {
        if (err2 && !stdout2) {
          return callback({ error: err2.message, previousConnection });
        }

        const seen = new Set();
        const ssids = [];
        (stdout2 || '').split('\n').forEach(line => {
          // nmcli -t output: SSID:BSSID:SECURITY:SIGNAL — colons in SSID are escaped as \:
          const parts = line.split(/(?<!\\):/g);
          const ssid = parts[0]?.replace(/\\:/g, ':').trim();
          if (!ssid || ssid === 'switcher_net' || seen.has(ssid)) return;
          seen.add(ssid);
          ssids.push(ssid);
        });

        // Get saved NM WiFi profiles to mark known networks
        execFile('sudo', ['nmcli', '-t', '-f', 'NAME,TYPE', 'con', 'show'], (_, conOut) => {
          const savedNames = new Set();
          (conOut || '').split('\n').forEach(line => {
            const [name, type] = line.split(':');
            if (type?.trim() === '802-11-wireless') savedNames.add(name?.trim());
          });

          const results = ssids.map(ssid => ({ ssid, saved: savedNames.has(ssid) }));
          callback({ networks: results, previousConnection });
        });
      });
    });
  });

  socket.on('connectWifi', (data, callback) => {
    const { iface, ssid, passphrase } = data;
    if (!iface || !ssid || /[;&|`$]/.test(iface)) {
      return callback({ error: 'Invalid parameters' });
    }

    console.log(`Connecting ${iface} to ${ssid} via nmcli`);

    // Rescan on this specific interface so nmcli's cache is fresh before connecting
    execFile('sudo', ['nmcli', 'dev', 'wifi', 'list', 'ifname', iface, '--rescan', 'yes'], { timeout: 15000 }, () => {

    // Find any saved profile for this SSID so we can clear its interface lock
    execFile('sudo', ['nmcli', '-t', '-f', 'NAME,TYPE', 'con', 'show'], (_, conOut) => {
      let savedProfile = null;
      (conOut || '').split('\n').forEach(line => {
        const [name, type] = line.split(':');
        if (type?.trim() === '802-11-wireless' && name?.trim() === ssid) {
          savedProfile = name.trim();
        }
      });

      function doConnect() {
        const args = passphrase
          ? ['dev', 'wifi', 'connect', ssid, 'password', passphrase, 'ifname', iface]
          : ['dev', 'wifi', 'connect', ssid, 'ifname', iface];

        execFile('sudo', ['nmcli', ...args], { timeout: 60000 }, (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr || stdout || err.message || '').trim();
            console.error(`nmcli connect error for ${ssid}:`, msg);
            return callback({ error: msg || `Failed to connect to ${ssid}` });
          }
          console.log(`WiFi connected: ${iface} -> ${ssid}`, stdout.trim());
          callback({ success: true, message: `Connected to ${ssid}` });
        });
      }

      if (savedProfile) {
        // Saved profile: clear interface lock, then bring it up on the requested iface
        execFile('sudo', ['nmcli', 'con', 'modify', savedProfile, 'connection.interface-name', ''], () => {
          execFile('sudo', ['nmcli', 'con', 'up', savedProfile, 'ifname', iface], { timeout: 60000 }, (err, stdout, stderr) => {
            if (err) {
              const msg = (stderr || stdout || err.message || '').trim();
              console.error(`nmcli con up error for ${ssid}:`, msg);
              return callback({ error: msg || `Failed to connect to ${ssid}` });
            }
            console.log(`WiFi connected (saved): ${iface} -> ${ssid}`);
            callback({ success: true, message: `Connected to ${ssid}` });
          });
        });
      } else {
        doConnect();
      }
    }); // end con show
    }); // end rescan
  });

  socket.on('reconnectPrevious', (data, callback) => {
    const conName = data.connectionName;
    const iface = data.iface || '';
    if (!conName) {
      return callback({ error: 'No previous connection name' });
    }
    const safeCon = conName.replace(/'/g, "'\\''");
    const safeIface = iface.replace(/'/g, "'\\''");
    const ifaceArg = iface ? ` ifname "${safeIface}"` : '';
    exec(`sudo nmcli con up '${safeCon}'${ifaceArg}`, (err) => {
      if (err) {
        console.error('Reconnect error:', err.message);
        return callback({ error: err.message });
      }
      console.log(`WiFi reconnected to: ${conName}${iface ? ' on ' + iface : ''}`);
      callback({ success: true, message: `Reconnected to ${conName}` });
    });
  });

  // ── iPhone pairing ──
  // The phones auto-tether as USB ethernet and Speedify auto-bonds them;
  // this only covers the manual step of trusting a brand new phone on site.

  socket.on('getIphones', (callback) => {
    const nameCache = loadIphoneNames();
    exec('idevicepair list', (err, pairedOut) => {
      const paired = (pairedOut || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
      exec('idevice_id -l', (err2, connectedOut) => {
        const connected = new Set((connectedOut || '').trim().split('\n').map(s => s.trim()).filter(Boolean));
        let remaining = paired.length;
        if (!remaining) return callback({ phones: [] });
        const phones = [];
        let cacheUpdated = false;
        paired.forEach(udid => {
          exec(`ideviceinfo -u ${udid} -k DeviceName`, { timeout: 5000 }, (e, nameOut) => {
            const fetched = (nameOut || '').trim();
            if (fetched) {
              if (nameCache[udid] !== fetched) { nameCache[udid] = fetched; cacheUpdated = true; }
            }
            const name = nameCache[udid] || 'Unknown';
            phones.push({ udid, name, connected: connected.has(udid) });
            if (--remaining === 0) {
              if (cacheUpdated) saveIphoneNames(nameCache);
              connected.forEach(udid2 => {
                if (!paired.includes(udid2)) {
                  phones.push({ udid: udid2, name: 'Unpaired', connected: true, unpaired: true });
                }
              });
              callback({ phones });
            }
          });
        });
      });
    });
  });

  socket.on('pairIphone', (callback) => {
    exec('idevicepair pair', { timeout: 30000 }, (err, stdout, stderr) => {
      const out = (stdout || '').trim() || (stderr || '').trim();
      if (err && !out.includes('SUCCESS')) return callback({ error: out || err.message });
      callback({ ok: true, message: out });
    });
  });
}

module.exports = { registerNetworkSocketHandlers, VALID_5GHZ_CHANNELS };
