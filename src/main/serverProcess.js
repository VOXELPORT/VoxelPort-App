'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const READY_RE = /Done \([^)]*\)!/;
const JOIN_RE = /: (\S+) joined the game/;
const LEAVE_RE = /: (\S+) left the game/;

/**
 * Runs the java server process for the currently-installed server and
 * mirrors the shape of Tunnel (EventEmitter, start/stop) so the renderer
 * side can treat it the same way.
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

  start({ serverDir, jarName = 'server.jar', minRamMb, maxRamMb }) {
    if (this.child) return;
    this.online.clear();
    this._setStatus('starting');

    this.child = spawn('java', [
      `-Xms${minRamMb}M`,
      `-Xmx${maxRamMb}M`,
      '-jar', jarName,
      'nogui',
    ], { cwd: serverDir });

    this.child.stdout.on('data', (buf) => this._onLine(buf.toString()));
    this.child.stderr.on('data', (buf) => this._onLine(buf.toString()));

    this.child.on('exit', (code) => {
      clearTimeout(this.stopTimer);
      const crashed = this.status !== 'stopping' && code !== 0;
      this.child = null;
      this.online.clear();
      this._setStatus(crashed ? 'crashed' : 'stopped');
      this.emit('players', 0);
      this.emit('exit', code);
    });

    this.child.on('error', (err) => {
      this.emit('log', `Failed to start Java: ${err.message}`);
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

  sendCommand(cmd) {
    if (!this.child || !cmd) return;
    this.child.stdin.write(cmd.trim() + '\n');
  }

  stop() {
    if (!this.child) return;
    this._setStatus('stopping');
    this.sendCommand('stop');
    this.stopTimer = setTimeout(() => {
      if (this.child) this.child.kill('SIGKILL');
    }, 20000);
  }

  _setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }
}

module.exports = { ServerProcess };
