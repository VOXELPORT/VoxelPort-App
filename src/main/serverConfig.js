'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Remembers which server the wizard installed, so a returning user lands
 * straight on the console screen instead of picking a type/version again.
 */
function configPath(userDataDir) {
  return path.join(userDataDir, 'server-config.json');
}

function loadServerConfig(userDataDir) {
  try {
    const raw = fs.readFileSync(configPath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.type && parsed.version && parsed.port) return parsed;
  } catch {
    // no server installed yet
  }
  return null;
}

function saveServerConfig(userDataDir, config) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(configPath(userDataDir), JSON.stringify(config, null, 2));
}

module.exports = { loadServerConfig, saveServerConfig };
