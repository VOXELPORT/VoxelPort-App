'use strict';

// The small changes the Bedrock Dedicated Server type makes to the released Electron renderer. tools/build-ui.js applies them after it
// copies the pinned renderer, so ui/ is still built, never edited by hand, and a patch whose anchor is not found stops the build instead of
// silently doing nothing. The logic lives in ui-extra/bedrock-server.js; these only add ids and call into it.

const B = 'window.VPBedrockServer';

/** @type {{file: string, find: string, replace: string, all?: boolean}[]} */
module.exports = [
  // ── index.html: ids to find things by, and what only a Java server has ──
  { file: 'index.html', find: '<script src="tauri-bridge.js"></script>', replace: '<script src="tauri-bridge.js"></script>\n  <script src="bedrock-server.js"></script>' },
  { file: 'index.html', find: '<label class="field">\n        <span class="label">Memory (RAM) — <span id="ramValueLabel">', replace: '<label class="field" id="ramField">\n        <span class="label">Memory (RAM) — <span id="ramValueLabel">' },
  { file: 'index.html', find: '<span>I agree to the <a href="https://www.minecraft.net/eula"', replace: '<span id="eulaText">I agree to the <a href="https://www.minecraft.net/eula"' },
  { file: 'index.html', find: '<div class="share-label">Share this address with players</div>\n        <div class="address-row">', replace: '<div class="share-label" id="shareLabel">Share this address with players</div>\n        <div class="address-row" id="shareAddressRow">' },
  { file: 'index.html', find: '<div class="name-box">', replace: '<div class="name-box" id="nameBox">' },
  { file: 'index.html', find: '<label class="field">\n          <span class="label">Memory (RAM) — <span id="setRamLabel">', replace: '<label class="field" data-java-only>\n          <span class="label">Memory (RAM) — <span id="setRamLabel">' },
  { file: 'index.html', find: '<input id="setRam" type="range" min="512" step="256" />\n        </label>\n      </div>', replace: '<input id="setRam" type="range" min="512" step="256" />\n        </label>\n        <p class="hint hidden" id="setBdsNote"></p>\n      </div>' },
  { file: 'index.html', find: '<div class="set-group">\n        <div class="set-group-title">Minecraft version</div>', replace: '<div class="set-group" data-java-only>\n        <div class="set-group-title">Minecraft version</div>' },
  { file: 'index.html', find: '<div class="set-group">\n        <div class="set-group-title">Bedrock players</div>', replace: '<div class="set-group" data-java-only>\n        <div class="set-group-title">Bedrock players</div>' },
  { file: 'index.html', find: '<div class="set-group">\n        <div class="set-group-title">Player accounts</div>', replace: '<div class="set-group" data-java-only>\n        <div class="set-group-title">Player accounts</div>' },
  { file: 'index.html', find: '<div class="set-group">\n        <div class="set-group-title">Public server list</div>', replace: '<div class="set-group" data-java-only>\n        <div class="set-group-title">Public server list</div>' },
  { file: 'index.html', find: '<div class="set-group">\n        <div class="set-group-title">Voice chat · Supporter Plus</div>', replace: '<div class="set-group" data-java-only>\n        <div class="set-group-title">Voice chat · Supporter Plus</div>' },
  { file: 'index.html', find: '<option value="fabric">Fabric</option>\n        </select>', replace: '<option value="fabric">Fabric</option>\n          <option value="bedrock-server">Bedrock Server</option>\n        </select>' },

  // ── wizard.js: step 2 has no Java or memory for a Bedrock server, and the default port is 19132 ──
  {
    file: 'wizard.js',
    find: 'async function runJavaCheck() {\n',
    replace: `async function runJavaCheck() {\n  // A Bedrock Dedicated Server needs no Java: the Java and memory rows go, and there is nothing to wait for.\n  if (${B}.applyConfigScreen(wizardState.type)) { javaSatisfied = true; updateInstallEnabled(); return; }\n`,
  },
  { file: 'wizard.js', find: 'port: Number(serverPort.value) || 25565,', replace: `port: Number(serverPort.value) || (${B}.isType(wizardState.type) ? 19132 : 25565),` },
  {
    file: 'wizard.js',
    find: "  } else if (p.phase === 'cracked') {",
    replace: "  } else if (p.phase === 'verifying') {\n    installFill.style.width = '100%';\n    installText.textContent = window.t('Checking the download…');\n  } else if (p.phase === 'cracked') {",
  },

  // ── library.js, console.js: the name and icon of the type ──
  { file: 'library.js', find: "return { vanilla: 'Vanilla', paper: 'Paper', fabric: 'Fabric' }[type] || type;", replace: `return ${B}.typeName(type);` },
  { file: 'library.js', find: "({ paper: 'P', fabric: 'F', vanilla: 'V' })[profile.type] || 'M'", replace: "({ paper: 'P', fabric: 'F', vanilla: 'V', 'bedrock-server': 'B' })[profile.type] || 'M'" },
  { file: 'console.js', find: "{ vanilla: 'Vanilla', paper: 'Paper', fabric: 'Fabric' }[profile.type] || profile.type", replace: `${B}.typeName(profile.type)`, all: true },
  {
    file: 'console.js',
    find: '  const bedrockOn = Boolean(!awaitingAssignment && isPublic && assigned && managingProfile && managingProfile.bedrock);',
    replace: `  const bedrockServer = ${B}.isProfile(managingProfile) || Boolean(assigned && assigned.bedrockServer);\n  ${B}.applyShareLayout(bedrockServer);\n  const bedrockOn = Boolean(!awaitingAssignment && isPublic && assigned && managingProfile && (managingProfile.bedrock || bedrockServer));`,
  },
  {
    file: 'console.js',
    find: "    : assigned.bedrockReady !== true ? t('Restart your server once to activate this Bedrock address.') : '';",
    replace: "    : assigned.bedrockReady !== true && !bedrockServer ? t('Restart your server once to activate this Bedrock address.') : '';",
  },
  {
    file: 'console.js',
    find: '  const bedrockOn = Boolean(managingProfile && managingProfile.bedrock);\n  return {',
    replace: `  const bedrockServer = ${B}.isProfile(managingProfile) || Boolean(assigned && assigned.bedrockServer);\n  const bedrockOn = Boolean(managingProfile && (managingProfile.bedrock || bedrockServer));\n  return {`,
  },
  {
    file: 'console.js',
    find: '    bedrock: bedrockOn && assigned.bedrockReady === true ? assignedBedrockAddress() : null,\n',
    replace: '    bedrock: bedrockOn && (assigned.bedrockReady === true || bedrockServer) ? assignedBedrockAddress() : null,\n    bedrockOnly: bedrockServer,\n',
  },
  { file: 'console.js', find: "  perfPanel.classList.remove('hidden');\n  if (p.cpuPercent !== null) {", replace: `  perfPanel.classList.remove('hidden');\n  ${B}.applyPerfLayout(${B}.isProfile(managingProfile));\n  if (p.cpuPercent !== null) {` },

  // ── invite.js: a Bedrock server's invite names only the server and port ──
  { file: 'invite.js', find: "      how: 'How to join: Minecraft → Multiplayer → Add Server → paste the address.',", replace: "      how: 'How to join: Minecraft → Multiplayer → Add Server → paste the address.',\n      bedrockHow: 'How to join: Minecraft Bedrock → Play → Servers → Add Server → type the server and the port.'," },
  { file: 'invite.js', find: "      how: 'Kaise judo: Minecraft → Multiplayer → Add Server → address paste karo.',", replace: "      how: 'Kaise judo: Minecraft → Multiplayer → Add Server → address paste karo.',\n      bedrockHow: 'Kaise judo: Minecraft Bedrock → Play → Servers → Add Server → server aur port daalo.'," },
  {
    file: 'invite.js',
    find: "  function buildInviteMessage({ lang = 'en', name, version, address, plainAddress, bedrock = null }) {\n    const w = WORDS[lang] || WORDS.en;\n",
    replace: "  function buildInviteMessage({ lang = 'en', name, version, address, plainAddress, bedrock = null, bedrockOnly = false }) {\n    const w = WORDS[lang] || WORDS.en;\n    if (bedrockOnly) {\n      // A Bedrock Dedicated Server has no Java address: only the Bedrock server and port.\n      const only = [w.title(oneLine(name, 60)), '', w.bedrock];\n      if (bedrock && bedrock.host && bedrock.port) only.push(`${w.bedrockServer}: ${oneLine(bedrock.host, 120)}   ${w.bedrockPort}: ${oneLine(bedrock.port, 6)}`);\n      only.push('', w.bedrockHow, w.footer);\n      return only.join('\\n');\n    }\n",
  },

  // ── settings.js, friends-ui.js, import.js ──
  { file: 'settings.js', find: '  fieldDefs = fields;\n', replace: `  fieldDefs = fields;\n  ${B}.applySettingsLayout(data);\n` },
  { file: 'settings.js', find: '  await renderRuntimeInfo(id, profile, data.running);\n', replace: '  if (!data.bedrockServer) await renderRuntimeInfo(id, profile, data.running);\n' },
  // An allow-list that is on but empty keeps everybody out, the host included: say so where the host is looking.
  {
    file: 'friends-ui.js',
    find: "    emptyEl.classList.toggle('hidden', friends.length > 0);\n  }",
    replace: "    emptyEl.classList.toggle('hidden', friends.length > 0);\n    if (status.enabled && friends.length === 0) stateText.textContent += ' ' + t('Nobody is on the list yet, so nobody can join, not even you. Add your own name first, or turn this off.');\n  }",
  },
  { file: 'friends-ui.js', find: "    $('friendsServerName').textContent = (friendsProfile && friendsProfile.name) || '';\n", replace: `    $('friendsServerName').textContent = (friendsProfile && friendsProfile.name) || '';\n    ${B}.applyFriendsLayout(friendsProfile);\n` },
  { file: 'import.js', find: "    if (info.hasServerJar) found.push('server.jar');\n", replace: "    if (info.hasBedrockServer) found.push('bedrock_server.exe');\n    if (info.hasServerJar) found.push('server.jar');\n" },
  { file: 'import.js', find: 'port: Number(importPort.value) || 25565,', replace: "port: Number(importPort.value) || (importType.value === 'bedrock-server' ? 19132 : 25565)," },
];
