'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

function getServerDir(userDataDir) {
  return path.join(userDataDir, 'server');
}

/** Streams a jar to disk, following redirects (Paper/Fabric/Mojang all can 30x). */
function downloadServerJar(url, destPath, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects while downloading server jar'));
          return;
        }
        downloadServerJar(res.headers.location, destPath, onProgress, redirectsLeft - 1)
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

      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress({ received, total });
      });

      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
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
  const lines = [
    `server-port=${port}`,
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
