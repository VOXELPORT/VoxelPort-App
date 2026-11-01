'use strict';

const fs = require('fs');
const path = require('path');
const { readJarMinecraftVersion } = require('./jarVersion');

/**
 * Reads what is actually installed for a server, for display and diagnostics
 * (locked decision 4): the real Minecraft version from the jar, and the
 * Geyser/Floodgate/ViaVersion plugin or mod versions from their jar file names.
 * Everything here reads the disk, never the stored profile.
 */

// Plugins/mods we name in the UI, matched by the start of the jar file name.
const KNOWN = [
  { key: 'geyser', label: 'Geyser', re: /^geyser[-_]/i },
  { key: 'floodgate', label: 'Floodgate', re: /^floodgate[-_]/i },
  { key: 'viaversion', label: 'ViaVersion', re: /^viaversion[-_]/i },
  { key: 'viabackwards', label: 'ViaBackwards', re: /^viabackwards[-_]/i },
];

// Pulls a version out of a jar file name, e.g. "Geyser-Spigot-2.11.3.jar" → "2.11.3",
// "ViaVersion-5.1.1.jar" → "5.1.1". Returns null when there is no version-looking part.
function versionFromFileName(name) {
  const base = name.replace(/\.jar$/i, '');
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/.exec(base);
  return m ? m[1] : null;
}

function readPlugins(serverDir) {
  const out = [];
  for (const dir of ['plugins', 'mods']) {
    let names = [];
    try { names = fs.readdirSync(path.join(serverDir, dir)); } catch { continue; }
    for (const name of names) {
      if (!/\.jar$/i.test(name)) continue;
      const known = KNOWN.find((k) => k.re.test(name));
      if (known) out.push({ key: known.key, label: known.label, version: versionFromFileName(name), file: name });
    }
  }
  return out;
}

/**
 * { minecraftVersion, plugins:[{key,label,version,file}] }. minecraftVersion is
 * null for a Fabric launcher jar (no version.json) or a missing/unreadable jar —
 * callers show the stored version in that case.
 */
async function readRuntimeInfo(serverDir) {
  let minecraftVersion = null;
  try {
    minecraftVersion = await readJarMinecraftVersion(path.join(serverDir, 'server.jar'));
  } catch { /* unreadable/missing jar → null */ }
  return { minecraftVersion, plugins: readPlugins(serverDir) };
}

module.exports = { readRuntimeInfo, readPlugins, versionFromFileName };
