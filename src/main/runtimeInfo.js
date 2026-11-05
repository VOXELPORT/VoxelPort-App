'use strict';

const fs = require('fs');
const path = require('path');
const { readJarMinecraftVersion, readJarPluginMeta } = require('./jarVersion');

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
 * Every plugin and mod jar in the server folder with its real name and version, read from the jar itself (the file name
 * is only a fallback: Geyser-Spigot.jar and floodgate-spigot.jar carry no version in their names).
 * [{ key, label, version, file, dir }], key being 'geyser' etc. for the ones we know and the lower-cased name otherwise.
 */
async function readAllPlugins(serverDir) {
  const out = [];
  for (const dir of ['plugins', 'mods']) {
    let names = [];
    try { names = fs.readdirSync(path.join(serverDir, dir)); } catch { continue; }
    for (const name of names.filter((n) => /.jar$/i.test(n)).sort((a, b) => a.localeCompare(b))) {
      const known = KNOWN.find((k) => k.re.test(name));
      const meta = await readJarPluginMeta(path.join(serverDir, dir, name));
      const label = known ? known.label : (meta.name || name.replace(/.jar$/i, ''));
      out.push({
        key: known ? known.key : label.toLowerCase(),
        label,
        version: meta.version || versionFromFileName(name),
        file: name,
        dir,
      });
    }
  }
  return out;
}

/**
 * Plugin/mod updates that were downloaded but couldn't replace the running jar
 * (it was locked), so the server staged them in plugins/update or mods/update
 * and will apply them on the next restart. Returns the staged jar file names.
 */
function readStagedUpdates(serverDir) {
  const out = [];
  for (const dir of ['plugins', 'mods']) {
    let names = [];
    try { names = fs.readdirSync(path.join(serverDir, dir, 'update')); } catch { continue; }
    for (const name of names) if (/\.jar$/i.test(name)) out.push({ dir, name });
  }
  return out;
}

/**
 * { minecraftVersion, plugins:[{key,label,version,file}], stagedUpdates:[{dir,name}] }.
 * minecraftVersion is null for a Fabric launcher jar (no version.json) or a
 * missing/unreadable jar — callers show the stored version in that case.
 */
async function readRuntimeInfo(serverDir) {
  let minecraftVersion = null;
  try {
    minecraftVersion = await readJarMinecraftVersion(path.join(serverDir, 'server.jar'));
  } catch { /* unreadable/missing jar → null */ }
  return { minecraftVersion, plugins: await readAllPlugins(serverDir), stagedUpdates: readStagedUpdates(serverDir) };
}

module.exports = { readRuntimeInfo, readPlugins, readAllPlugins, readStagedUpdates, versionFromFileName };
