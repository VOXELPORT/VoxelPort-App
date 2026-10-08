'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

const READY_RE = /Done \([^)]*\)!/;
const JOIN_RE = /: (\S+) joined the game/;
const LEAVE_RE = /: (\S+) left the game/;

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
  constructor() {
    super();
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

    this.child = spawn(javaPath, [
      `-Xms${minRamMb}M`,
      `-Xmx${maxRamMb}M`,
      '-jar', jarName,
      'nogui',
    ], { cwd: serverDir, shell: false });

    this.child.stdout.on('data', (buf) => this._onLine(buf.toString()));
    this.child.stderr.on('data', (buf) => this._onLine(buf.toString()));

    this.child.on('exit', (code) => {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
      const crashed = this.status !== 'stopping' && code !== 0;
      this.child = null;
      this.online.clear();
      this._setStatus(crashed ? 'crashed' : 'stopped');
      this.emit('players', 0);
      this.emit('exit', code);
    });

    this.child.on('error', (err) => {
      this.emit('log', `Failed to start Java: ${err.message}`);
      this.child = null;
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
      this._setStatus('crashed');
    });
  }

  _onLine(text) {
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      this.emit('log', line);
      if (this.status === 'starting' && READY_RE.test(line)) this._setStatus('online');

      const joined = JOIN_RE.exec(line);
      if (joined) { this.online.add(joined[1]); this.emit('players', this.online.size); }
      const left = LEAVE_RE.exec(line);
      if (left) { this.online.delete(left[1]); this.emit('players', this.online.size); }
    }
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

module.exports = { ServerProcess };
