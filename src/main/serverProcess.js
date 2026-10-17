'use strict';

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');

// A server line is "[time] [thread/LEVEL]: message" (Vanilla) or "[time LEVEL]: message" (Paper). What the server means is
// the whole message after that, never a piece of it: chat is "<name> text", so a player typing "Bob joined the game" can
// not pass for the server saying it.
const LOG_PREFIX_RE = /^\[[^\]]*\](?: \[[^\]]*\])?:\s*/;
const READY_RE = /^Done \([^)]*\)!/;
const JOIN_RE = /^([A-Za-z0-9_.*-]{1,32}) joined the game$/;
const LEAVE_RE = /^([A-Za-z0-9_.*-]{1,32}) left the game$/;

/** A server log line without its "[time] [thread/LEVEL]:" front. */
function stripLogPrefix(line) {
  return String(line).replace(LOG_PREFIX_RE, '').trimEnd();
}

const STOP_GRACE_MS = 20000;
const MAX_COMMAND_LEN = 512;

/**
 * Runs the java server process for the currently-active server profile and
 * mirrors the shape of Tunnel (EventEmitter, start/stop) so the renderer
 * side can treat it the same way. Always spawn()s a fixed argv (never
 * exec()/shell:true — item 28), and only ever manages a single child at a
 * time.
 *
 * Events: 'status' (state), 'log' (line), 'players' (count), 'exit' (code).
 */
class ServerProcess extends EventEmitter {
  /** `spawnImpl` is for tests. */
  constructor({ spawnImpl = spawn } = {}) {
    super();
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.status = 'stopped';
    this.online = new Set();
    this.stopTimer = null;
  }

  start({ serverDir, jarName = 'server.jar', minRamMb, maxRamMb, javaPath = 'java' }) {
    if (this.child) return; // only one managed process, ever
    if (typeof serverDir !== 'string' || !path.isAbsolute(serverDir)) {
      this.emit('log', 'Refusing to start: invalid server folder.');
      this._setStatus('crashed');
      return;
    }
    // Either java on the PATH or an absolute path to a java executable
    // (the JRE VoxelPort installs into its own data folder).
    if (javaPath !== 'java' && !(typeof javaPath === 'string' && path.isAbsolute(javaPath) && /^java(\.exe)?$/i.test(path.basename(javaPath)))) {
      this.emit('log', 'Refusing to start: invalid Java path.');
      this._setStatus('crashed');
      return;
    }
    if (!Number.isInteger(minRamMb) || !Number.isInteger(maxRamMb) || minRamMb < 256 || maxRamMb < minRamMb || maxRamMb > 131072) {
      this.emit('log', 'Refusing to start: invalid RAM allocation.');
      this._setStatus('crashed');
      return;
    }

    this.online.clear();
    this._setStatus('starting');

    const child = this.spawnImpl(javaPath, [
      `-Xms${minRamMb}M`,
      `-Xmx${maxRamMb}M`,
      '-jar', jarName,
      'nogui',
    ], { cwd: serverDir, shell: false });
    this.child = child;

    // One line at a time, however the output was cut into chunks (and a character split between two chunks stays whole).
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => this._onLine(line));
    }
    // Writing a command to a server that has just gone away must not crash the app.
    child.stdin.on('error', (err) => this.emit('log', `Could not send to the server: ${err.message}`));

    // However it ends, "exit" is said once: when the process ends, or when it never started.
    let ended = false;
    const finish = (code) => {
      if (ended) return;
      ended = true;
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
      const crashed = this.status !== 'stopping' && code !== 0;
      if (this.child === child) this.child = null;
      this.online.clear();
      this._setStatus(crashed ? 'crashed' : 'stopped');
      this.emit('players', 0);
      this.emit('exit', code);
    };

    child.on('exit', (code) => finish(code));

    child.on('error', (err) => {
      this.emit('log', `Failed to start Java: ${err.message}`);
      // No process means no 'exit' will follow: say it now, so the app lets go of this server. (An error from a process that
      // did start, such as a failed kill, is only logged: its exit still comes.)
      if (child.pid === undefined) finish(-1);
    });
  }

  _onLine(line) {
    if (!line) return;
    this.emit('log', line);
    const message = stripLogPrefix(line);
    if (this.status === 'starting' && READY_RE.test(message)) this._setStatus('online');

    const joined = JOIN_RE.exec(message);
    if (joined) { this.online.add(joined[1]); this.emit('players', this.online.size); }
    const left = LEAVE_RE.exec(message);
    if (left) { this.online.delete(left[1]); this.emit('players', this.online.size); }
  }

  /**
   * Console input is Minecraft command input, sent only to the child's
   * stdin — never a shell (item 29). Bounded length, and an embedded
   * newline/control character is stripped rather than allowed to smuggle a
   * second command into a single IPC call.
   */
  sendCommand(cmd) {
    if (!this.child || typeof cmd !== 'string') return;
    // eslint-disable-next-line no-control-regex
    const sanitized = cmd.replace(/[\r\n\x00-\x1f]/g, '').trim().slice(0, MAX_COMMAND_LEN);
    if (!sanitized) return;
    this.child.stdin.write(sanitized + '\n');
  }

  stop() {
    if (!this.child) return;
    this._setStatus('stopping');
    this.sendCommand('stop');
    this.stopTimer = setTimeout(() => {
      if (this.child) this.child.kill('SIGKILL');
    }, STOP_GRACE_MS);
  }

  _setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }
}

module.exports = { ServerProcess, stripLogPrefix };
