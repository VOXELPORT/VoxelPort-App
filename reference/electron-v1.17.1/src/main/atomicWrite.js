'use strict';

const fs = require('fs');
const crypto = require('crypto');

/**
 * Writes a file so that nobody ever sees half of it: the new contents go to a temporary file in the same folder, which then
 * replaces the real one in a single step. A crash, a full disk or a power cut while writing leaves the old file as it was.
 */
function atomicWriteFileSync(file, data, options) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, data, options);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw err;
  }
}

module.exports = { atomicWriteFileSync };
