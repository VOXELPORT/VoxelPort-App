'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

function getServerDir(userDataDir) {
  return path.join(userDataDir, 'server');
}

/**
 * Streams a jar to disk, following redirects (Paper/Fabric/Mojang all can 30x).
 * When `checksum` is given ({algorithm, expected}), the download is hashed as
 * it streams and the file is deleted + rejected on a mismatch — Vanilla and
 * Paper both publish a hash for their server jars; Fabric's assembled
 * server/jar endpoint doesn't, so that path is installed unverified.
 *
 * The real download URLs always come from the hardcoded HTTPS Mojang/Paper/
 * Fabric API hosts in mcVersions.js — picking the transport from the URL's
 * own scheme (rather than hardcoding https) doesn't change that, it just
 * makes this function testable over plain HTTP too.
 */
function downloadServerJar(url, destPath, onProgress, checksum = null, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('http://') ? http : https;
    const req = transport.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects while downloading server jar'));
          return;
        }
        downloadServerJar(res.headers.location, destPath, onProgress, checksum, redirectsLeft - 1)
          .then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const file = fs.createWriteStream(destPath);
      const hash = checksum ? crypto.createHash(checksum.algorithm) : null;

      res.on('data', (chunk) => {
        received += chunk.length;
        if (hash) hash.update(chunk);
        if (onProgress) onProgress({ received, total });
      });

      res.pipe(file);
      file.on('finish', () => file.close(() => {
        if (hash) {
          const actual = hash.digest('hex');
          if (actual.toLowerCase() !== checksum.expected.toLowerCase()) {
            fs.unlink(destPath, () => {
              reject(new Error(
                `Downloaded server jar failed ${checksum.algorithm} verification ` +
                `(expected ${checksum.expected}, got ${actual}) — deleted, not installed.`
              ));
            });
            return;
          }
        }
        resolve();
      }));
      file.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function writeEula(serverDir) {
  fs.writeFileSync(
    path.join(serverDir, 'eula.txt'),
    '# By setting eula=true you agree to the Minecraft EULA (https://www.minecraft.net/eula)\neula=true\n'
  );
}

function writeServerProperties(serverDir, { port = 25565, maxPlayers = 20, difficulty = 'easy', gamemode = 'survival', motd = 'A VoxelPort server' } = {}) {
  // port is written into a config file as a bare value — coerce to a plain
  // integer (not just interpolate the caller's value) so it can't smuggle in
  // extra server.properties lines (e.g. a newline followed by enable-rcon=true).
  const safePort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 25565;
  const lines = [
    `server-port=${safePort}`,
    `max-players=${maxPlayers}`,
    `difficulty=${difficulty}`,
    `gamemode=${gamemode}`,
    `motd=${motd}`,
    'online-mode=true',
    'enable-command-block=false',
  ];
  fs.writeFileSync(path.join(serverDir, 'server.properties'), lines.join('\n') + '\n');
}

module.exports = { getServerDir, downloadServerJar, writeEula, writeServerProperties };
