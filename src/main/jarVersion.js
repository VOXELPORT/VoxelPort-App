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

module.exports = { readJarMinecraftVersion };
