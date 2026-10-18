// Shared subprocess-management + state-file helpers for scorebored's
// tournament-sync integrations (Challonge, Podium, Shufflepolo).
//
// Each provider is a standalone, toggleable, read-only-against-the-platform
// subprocess that writes atomic JSON state files to its own `state/` dir and,
// while enabled, overwrites the app's top-level bracket.json (the file
// Next/Prev Game navigation walks). This module owns the parts that are
// identical across providers: spawn/stop lifecycle, config load/save,
// state-file reads. Provider-specific behavior (what env vars to pass, what
// extra config fields to mask, provider-only routes like Challonge's
// tournament lookup) stays in each provider's own definition, not here.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// A sync child that exits on its own (a crash, an unhandled rejection) is
// respawned after a backoff that doubles up to a minute and resets once the
// child has stayed up for a while. An operator stop or restart never
// backs off.
const CRASH_BACKOFF_START_MS = 1_000;
const CRASH_BACKOFF_MAX_MS = 60_000;
const CRASH_BACKOFF_RESET_AFTER_MS = 5 * 60_000;

/**
 * @typedef {object} SyncProvider
 * @property {string} name - e.g. "challonge" - used in logs and as the REST/socket key.
 * @property {string} dir - absolute path to the provider's script directory.
 * @property {string} script - absolute path to the script to spawn.
 * @property {string[]} [args] - extra argv for the script (e.g. shufflepolo's node script, no args needed).
 * @property {string} command - the interpreter to spawn, e.g. "python3" or "node".
 * @property {string} configFile - absolute path to the provider's `<provider>-config.json`.
 * @property {object} configDefaults - shape/defaults for the config object.
 * @property {string[]} requiredFields - config fields that must be truthy to start.
 * @property {(config: object, context: object) => object} buildEnv - maps config -> subprocess env vars.
 * @property {string} stateDir - absolute path to the provider's `state/` dir.
 * @property {(config: object) => object} maskConfig - returns the config shape safe to expose over REST/socket (secrets masked).
 * @property {(key: string, value: string) => string} [normalizeField] - optional per-field cleanup applied to incoming config values before they're stored (e.g. stripping a pasted URL down to the UUID it contains).
 * @property {number} [staleAfterMs] - optional: if the child's state/status.json `last_poll_at` is older than this while the child is running, the child is assumed hung and restarted.
 */

class SyncManager {
  /** @param {SyncProvider} provider */
  constructor(provider) {
    this.provider = provider;
    this.config = { ...provider.configDefaults };
    this.proc = null;
    this.restartPending = false;
    this.onExit = null; // optional (code) => void, for provider-specific cleanup on process exit
    this.stopping = false; // true while an operator-requested stop is in flight, so a crash restart is not scheduled
    this.startedAt = 0;
    this.crashBackoffMs = CRASH_BACKOFF_START_MS;
    this.crashRestartTimer = null;
    this.staleTimer = null;
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.provider.configFile)) {
        const saved = JSON.parse(fs.readFileSync(this.provider.configFile, 'utf8'));
        this.config = { ...this.config, ...saved };
      }
    } catch (error) {
      console.error(`Error loading ${this.provider.name} config:`, error);
    }
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.provider.configFile, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error(`Error saving ${this.provider.name} config:`, error);
    }
  }

  /**
   * Applies incoming field updates (e.g. from a socket `setConfig` event) to
   * this provider's config, generically: any string field present in
   * configDefaults gets trimmed and set, except a masked-secret placeholder
   * ('••••••••') is left untouched since that means "field not re-entered by
   * the operator, don't overwrite the real value with the mask". Fields not
   * part of this provider's config shape (e.g. sending Podium fields to
   * Challonge) are silently ignored. Does not touch `enabled` - that's
   * changed only via toggle(), never bundled into a config-field update.
   */
  applyConfigFields(fields) {
    for (const key of Object.keys(this.provider.configDefaults)) {
      if (key === 'enabled') continue;
      const value = fields[key];
      if (typeof value === 'string' && value !== '••••••••') {
        const trimmed = value.trim();
        this.config[key] = this.provider.normalizeField
          ? this.provider.normalizeField(key, trimmed)
          : trimmed;
      }
    }
  }

  maskedConfig() {
    return this.provider.maskConfig(this.config);
  }

  readStateFile(filename) {
    try {
      const filePath = path.join(this.provider.stateDir, filename);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      console.error(`Error reading ${this.provider.name} state/${filename}:`, error);
      return null;
    }
  }

  isRunning() {
    return this.proc !== null;
  }

  start(context) {
    if (this.proc) return;
    const missing = this.provider.requiredFields.filter((f) => !this.config[f]);
    if (missing.length) {
      console.log(`${this.provider.name}: cannot start, missing ${missing.join(', ')}`);
      return;
    }

    console.log(`${this.provider.name}: starting sync`);
    clearTimeout(this.crashRestartTimer);
    this.crashRestartTimer = null;
    this.stopping = false;
    this.startedAt = Date.now();
    const env = { ...process.env, ...this.provider.buildEnv(this.config, context) };
    this.proc = spawn(this.provider.command, [this.provider.script, ...(this.provider.args || [])], {
      cwd: this.provider.dir,
      env,
    });

    const tag = this.provider.name;
    this.proc.stdout.on('data', (chunk) => console.log(`[${tag}] ${chunk.toString().trim()}`));
    this.proc.stderr.on('data', (chunk) => console.error(`[${tag}] ${chunk.toString().trim()}`));
    this.proc.on('close', (code) => {
      console.log(`${this.provider.name} sync process exited with code ${code}`);
      this.proc = null;
      this._stopStaleWatch();
      if (this.onExit) this.onExit(code);
      if (this.restartPending) {
        this.restartPending = false;
        this.start(context);
        return;
      }
      if (this.stopping || !this.config.enabled) return;
      // Nobody asked for this exit: respawn with backoff.
      if (Date.now() - this.startedAt > CRASH_BACKOFF_RESET_AFTER_MS) this.crashBackoffMs = CRASH_BACKOFF_START_MS;
      console.error(`${this.provider.name}: sync exited unexpectedly; restarting in ${this.crashBackoffMs / 1000}s`);
      this.crashRestartTimer = setTimeout(() => this.start(context), this.crashBackoffMs);
      this.crashBackoffMs = Math.min(this.crashBackoffMs * 2, CRASH_BACKOFF_MAX_MS);
    });
    this.proc.on('error', (err) => {
      console.error(`${this.provider.name} sync spawn error:`, err.message);
      this.proc = null;
    });
    this._startStaleWatch(context);
  }

  // Hung-process watchdog: a child that is alive but no longer reading (a
  // socket that died without an error, a stuck fetch) keeps its status.json
  // frozen. Providers that write it on every read can set staleAfterMs.
  _startStaleWatch(context) {
    const limit = this.provider.staleAfterMs;
    if (!limit) return;
    this._stopStaleWatch();
    this.staleTimer = setInterval(() => {
      if (!this.proc || Date.now() - this.startedAt < limit) return;
      const status = this.readStateFile('status.json');
      const lastPoll = status && status.last_poll_at ? Date.parse(status.last_poll_at) : NaN;
      if (Number.isNaN(lastPoll) || Date.now() - lastPoll < limit) return;
      console.error(`${this.provider.name}: no read since ${status.last_poll_at}; restarting hung sync`);
      this.restart(context);
    }, Math.max(30_000, Math.floor(limit / 4)));
  }

  _stopStaleWatch() {
    clearInterval(this.staleTimer);
    this.staleTimer = null;
  }

  /**
   * Asks the child for a full re-read and push (it listens for the line
   * "resync" on stdin). Returns false when nothing is running or the child
   * does not accept it.
   */
  resync() {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) return false;
    this.proc.stdin.write('resync\n');
    return true;
  }

  /**
   * .kill() only sends SIGTERM — it doesn't wait for the process to actually
   * exit. Callers must not spawn a replacement until the previous process's
   * 'close' event has fired, or a stop()+start() pair leaks an orphaned
   * subprocess still holding the old connection/subscription. `callback`
   * fires once the process has actually closed (or immediately if it wasn't
   * running).
   */
  stop(callback) {
    this.stopping = true;
    clearTimeout(this.crashRestartTimer);
    this.crashRestartTimer = null;
    if (!this.proc) {
      if (callback) callback();
      return;
    }
    console.log(`${this.provider.name}: stopping sync`);
    this.proc.once('close', () => { if (callback) callback(); });
    this.proc.kill();
  }

  /** Signals the subprocess to poll immediately, for providers that support it (e.g. Challonge). Others ignore this. */
  pollNow() {
    if (this.proc) this.proc.kill('SIGUSR1');
  }

  restart(context) {
    if (this.proc) {
      this.restartPending = true;
      this.proc.kill();
    } else {
      this.start(context);
    }
  }

  /** Sets config.enabled and starts/stops the subprocess to match. Persists the config either way. */
  toggle(enabled, context) {
    this.config.enabled = !!enabled;
    this.saveConfig();
    if (this.config.enabled) {
      this.start(context);
    } else {
      this.stop();
    }
  }
}

module.exports = { SyncManager };
