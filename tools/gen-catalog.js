'use strict';

// Writes src-tauri/src/catalog.json from the Electron app's own modules, so the lists the screens show (server
// types, templates, relay regions) are identical by construction. Run it again whenever those modules change:
//   node tools/gen-catalog.js
// It reads the pinned release in reference/electron-v1.17.1.

const fs = require('fs');
const path = require('path');

const main = path.join(__dirname, '..', 'reference', 'electron-v1.17.1', 'src', 'main');
const { getTypes } = require(path.join(main, 'mcVersions'));
const { TEMPLATES } = require(path.join(main, 'serverSettings'));
const { REGIONS } = require(path.join(main, 'regions'));

const catalog = {
  types: getTypes(),
  // The same fields the server:templates handler returns.
  templates: TEMPLATES.map((t) => ({
    id: t.id, label: t.label, blurb: t.blurb, type: t.type, bedrock: Boolean(t.bedrock), cracked: Boolean(t.cracked),
  })),
  // The same fields region:get lists.
  regions: Object.values(REGIONS).map((r) => ({ id: r.id, label: r.label })),
};

const out = path.join(__dirname, '..', 'src-tauri', 'src', 'catalog.json');
fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n');
console.log(`wrote ${out}: ${catalog.types.length} types, ${catalog.templates.length} templates, ${catalog.regions.length} regions`);
