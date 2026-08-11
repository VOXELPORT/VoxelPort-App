'use strict';

const { execFile } = require('child_process');

/**
 * Minecraft's required Java major version, keyed by the lowest MC version
 * that needs it. Paper/Fabric don't publish this themselves, but it only
 * depends on the underlying MC version, not the loader on top of it.
 */
const JAVA_REQUIREMENTS = [
  { since: '1.20.5', major: 21 },
  { since: '1.18', major: 17 },
  { since: '1.17', major: 16 },
  { since: '0.0', major: 8 },
];

function parseVersion(v) {
  return String(v).split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function requiredJavaMajor(mcVersion) {
  for (const req of JAVA_REQUIREMENTS) {
    if (compareVersions(mcVersion, req.since) >= 0) return req.major;
  }
  return 8;
}

/** Resolves { found, major, raw } — major is null if java isn't on PATH. */
function checkJava() {
  return new Promise((resolve) => {
    execFile('java', ['-version'], (err, _stdout, stderr) => {
      if (err) {
        resolve({ found: false, major: null, raw: null });
        return;
      }
      // java prints its version banner to stderr, e.g.
      // openjdk version "21.0.2" 2024-01-16   or   java version "1.8.0_351"
      const match = /version "(\d+)(?:\.(\d+))?/.exec(stderr);
      if (!match) {
        resolve({ found: true, major: null, raw: stderr.trim() });
        return;
      }
      const first = parseInt(match[1], 10);
      const major = first === 1 ? parseInt(match[2], 10) : first;
      resolve({ found: true, major, raw: stderr.trim() });
    });
  });
}

module.exports = { checkJava, requiredJavaMajor };
