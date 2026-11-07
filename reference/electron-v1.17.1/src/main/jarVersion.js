'use strict';

/**
 * Reads the real Minecraft version out of a downloaded server jar, so the app
 * can verify that what landed on disk is the version the user selected
 * (locked decision 3/4) rather than trusting the request.
 *
 * Vanilla and Paper server jars contain a `version.json` at the archive root
 * with `{ "id": "26.2", ... }` (Paper repackages Mojang's). Fabric's launcher
 * jar is a thin bootstrap that downloads Minecraft on first run and carries no
 * such file, so there is nothing to read — callers skip verification for it.
 *
 * Uses yauzl (already a dependency via backups.js) — no new dependency.
 */

const yauzl = require('yauzl');

const MAX_VERSION_JSON_BYTES = 1 * 1024 * 1024; // version.json is tiny; cap defensively

/**
 * Resolves the Minecraft version string from a jar, or null when the jar has no
 * version.json (e.g. a Fabric launcher jar). Rejects only on a genuinely
 * unreadable/corrupt archive.
 */
function readJarMinecraftVersion(jarPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(jarPath, { lazyEntries: true }, (err, zip) => {
      if (err) { reject(err); return; }
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } try { zip.close(); } catch { /* ignore */ } };

      zip.on('error', (e) => done(reject, e));
      zip.on('end', () => done(resolve, null)); // no version.json found
      zip.on('entry', (entry) => {
        if (entry.fileName !== 'version.json') { zip.readEntry(); return; }
        if (entry.uncompressedSize > MAX_VERSION_JSON_BYTES) { done(resolve, null); return; }
        zip.openReadStream(entry, (e, stream) => {
          if (e) { done(reject, e); return; }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', (se) => done(reject, se));
          stream.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const id = parsed && typeof parsed.id === 'string' ? parsed.id : null;
              done(resolve, id);
            } catch {
              done(resolve, null); // unreadable version.json → treat as "unknown", not fatal
            }
          });
        });
      });
      zip.readEntry();
    });
  });
}

const META_FILES = ['plugin.yml', 'paper-plugin.yml', 'fabric.mod.json'];
const MAX_META_BYTES = 256 * 1024;

/** A value out of a plugin.yml line like `version: '2.2.5-SNAPSHOT'`; null when absent or an unfilled ${placeholder}. */
function yamlValue(text, key) {
  const m = new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, 'mi').exec(text);
  if (!m) return null;
  const v = m[1].replace(/^['"]|['"]$/g, '').trim();
  return v && !v.includes('${') ? v.slice(0, 60) : null;
}

/**
 * The name and version a plugin or mod declares about itself (plugin.yml, paper-plugin.yml or fabric.mod.json inside the
 * jar): that is the real version, whatever the file is called. { name, version } with null for what it does not say, or
 * { name: null, version: null } when the jar cannot be read. Never rejects.
 */
function readJarPluginMeta(jarPath) {
  const none = { name: null, version: null };
  return new Promise((resolve) => {
    yauzl.open(jarPath, { lazyEntries: true }, (err, zip) => {
      if (err) { resolve(none); return; }
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } try { zip.close(); } catch { /* ignore */ } };
      zip.on('error', () => done(none));
      zip.on('end', () => done(none));
      zip.on('entry', (entry) => {
        if (!META_FILES.includes(entry.fileName) || entry.uncompressedSize > MAX_META_BYTES) { zip.readEntry(); return; }
        zip.openReadStream(entry, (e, stream) => {
          if (e) { done(none); return; }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', () => done(none));
          stream.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try {
              if (entry.fileName === 'fabric.mod.json') {
                const j = JSON.parse(text);
                done({ name: typeof j.name === 'string' ? j.name.slice(0, 60) : null, version: typeof j.version === 'string' && !j.version.includes('${') ? j.version.slice(0, 60) : null });
              } else done({ name: yamlValue(text, 'name'), version: yamlValue(text, 'version') });
            } catch { done(none); }
          });
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { readJarMinecraftVersion, readJarPluginMeta };
