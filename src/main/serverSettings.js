'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The server.properties keys VoxelPort's Settings screen can change, each
 * with a validator. Anything not listed here is never written from the UI —
 * and security-sensitive keys (online-mode, enable-rcon, rcon.password,
 * enable-command-block, …) are deliberately absent, so they can't be
 * weakened from the renderer.
 */
const SETTINGS = [
  { key: 'motd', label: 'Description (MOTD)', type: 'text', max: 59, def: 'A VoxelPort server' },
  { key: 'gamemode', label: 'Game mode', type: 'enum', options: ['survival', 'creative', 'adventure', 'spectator'], def: 'survival' },
  { key: 'difficulty', label: 'Difficulty', type: 'enum', options: ['peaceful', 'easy', 'normal', 'hard'], def: 'easy' },
  { key: 'hardcore', label: 'Hardcore (one life)', type: 'bool', def: false },
  { key: 'pvp', label: 'PvP', type: 'bool', def: true },
  { key: 'max-players', label: 'Max players', type: 'int', min: 1, max: 1000, def: 20 },
  { key: 'white-list', label: 'Whitelist (only approved players)', type: 'bool', def: false },
  { key: 'allow-flight', label: 'Allow flight', type: 'bool', def: false },
  { key: 'view-distance', label: 'View distance (chunks)', type: 'int', min: 3, max: 32, def: 10 },
  { key: 'simulation-distance', label: 'Simulation distance (chunks)', type: 'int', min: 3, max: 32, def: 10 },
  { key: 'spawn-protection', label: 'Spawn protection (blocks)', type: 'int', min: 0, max: 64, def: 16 },
  { key: 'level-seed', label: 'World seed (new worlds only)', type: 'text', max: 64, def: '' },
];
const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** Parses server.properties text (Java .properties subset) into a Map. */
function parseProperties(text) {
  const out = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line[0] === '#' || line[0] === '!') continue;
    const m = /^((?:\\.|[^=:\s\\])+)\s*[=:]?\s*(.*)$/.exec(line);
    if (!m) continue;
    out.set(unescapeProp(m[1]), unescapeProp(m[2]));
  }
  return out;
}

function unescapeProp(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_m, hex, ch) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return { t: '\t', n: '\n', r: '\r', f: '\f' }[ch] || ch;
  });
}

/** Escapes a value for server.properties: \\ and non-ASCII as \\uXXXX, so it reads the same in every Minecraft version. */
function escapeValue(s) {
  let out = '';
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i); // UTF-16 units, exactly what \uXXXX encodes
    if (code === 0x5c) out += '\\\\';
    else if (code < 0x20 || code === 0x7f) continue; // never let a value smuggle in a new line
    else if (code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += str[i];
  }
  return out;
}

function readPropertiesFile(serverDir) {
  try {
    return parseProperties(fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8'));
  } catch {
    return new Map();
  }
}

/** Current values of every editable setting (defaults where missing). */
function readSettings(serverDir) {
  const props = readPropertiesFile(serverDir);
  const values = {};
  for (const s of SETTINGS) {
    const raw = props.get(s.key);
    if (raw === undefined) { values[s.key] = s.def; continue; }
    if (s.type === 'bool') values[s.key] = raw.trim().toLowerCase() === 'true';
    else if (s.type === 'int') {
      const n = parseInt(raw, 10);
      values[s.key] = Number.isInteger(n) ? n : s.def;
    } else values[s.key] = raw;
  }
  return values;
}

/**
 * Validates changes from the renderer and returns them as escaped
 * server.properties strings. Unknown keys and invalid values throw — the UI
 * should never send them, so a bad value means something is wrong.
 */
function validateSettings(changes) {
  if (!changes || typeof changes !== 'object') throw new Error('Invalid settings.');
  const out = {};
  for (const [key, value] of Object.entries(changes)) {
    const s = BY_KEY.get(key);
    if (!s) throw new Error(`"${key}" can't be changed here.`);
    if (s.type === 'bool') {
      if (typeof value !== 'boolean') throw new Error(`${s.label} must be on or off.`);
      out[key] = value ? 'true' : 'false';
    } else if (s.type === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < s.min || n > s.max) throw new Error(`${s.label} must be between ${s.min} and ${s.max}.`);
      out[key] = String(n);
    } else if (s.type === 'enum') {
      if (!s.options.includes(value)) throw new Error(`Invalid ${s.label.toLowerCase()}.`);
      out[key] = value;
    } else {
      if (typeof value !== 'string') throw new Error(`Invalid ${s.label.toLowerCase()}.`);
      // eslint-disable-next-line no-control-regex
      const clean = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
      if ([...clean].length > s.max) throw new Error(`${s.label} can be at most ${s.max} characters.`);
      out[key] = escapeValue(clean);
    }
  }
  // Whitelist on should actually keep non-whitelisted players out.
  if (out['white-list'] !== undefined) out['enforce-whitelist'] = out['white-list'];
  return out;
}

/**
 * Starting points for a new server. `properties` values are already in
 * server.properties form; `bedrock` installs Geyser + Floodgate after setup.
 */
const TEMPLATES = [
  {
    id: 'survival', label: 'Survival SMP', blurb: 'Classic survival with friends.', type: 'paper',
    properties: { gamemode: 'survival', difficulty: 'normal', pvp: 'true', 'max-players': '20', motd: 'Survival SMP' },
  },
  {
    id: 'crossplay', label: 'Java + Bedrock', blurb: 'Phone, console & PC players together.', type: 'paper', bedrock: true,
    properties: { gamemode: 'survival', difficulty: 'normal', 'max-players': '20', motd: 'Java + Bedrock SMP' },
  },
  {
    id: 'creative', label: 'Creative Flat', blurb: 'Flat world, creative mode, no monsters.', type: 'paper',
    properties: {
      gamemode: 'creative', 'force-gamemode': 'true', difficulty: 'peaceful', 'level-type': 'minecraft\\:flat',
      'generate-structures': 'false', pvp: 'false', motd: 'Creative build server',
    },
  },
  {
    id: 'hardcore', label: 'Hardcore', blurb: 'Hard difficulty. One life.', type: 'paper',
    properties: { gamemode: 'survival', difficulty: 'hard', hardcore: 'true', motd: 'Hardcore — one life' },
  },
  {
    id: 'chill', label: 'Peaceful Chill', blurb: 'Build and explore, no monsters.', type: 'paper',
    properties: { gamemode: 'survival', difficulty: 'peaceful', pvp: 'false', motd: 'Peaceful chill server' },
  },
  {
    id: 'modded', label: 'Modded (Fabric)', blurb: 'Ready for Fabric mods.', type: 'fabric',
    properties: { motd: 'Modded Fabric server' },
  },
];

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

/** The game mode label shown on the public server list. */
function listingMode(values, type) {
  if (values.hardcore) return 'hardcore';
  if (type === 'fabric') return 'modded';
  return ['survival', 'creative', 'adventure'].includes(values.gamemode) ? values.gamemode : '';
}

module.exports = {
  SETTINGS, TEMPLATES, getTemplate, parseProperties, escapeValue, readSettings, validateSettings, listingMode,
};
