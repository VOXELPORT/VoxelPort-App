'use strict';

/**
 * Turns the last lines of a server's console into plain-English
 * explanations of why it stopped, each with a suggested fix. Rules are
 * ordered most-specific first; the generic "it crashed" rule only applies
 * when nothing more specific matched.
 *
 * A diagnosis: { id, title, detail, fix: { action, label } | null, evidence }
 * where action is 'settings' (open the Settings screen), 'folder' (open the
 * server folder) or 'eula' (accept the EULA for an imported server).
 */

const RULES = [
  {
    id: 'port-in-use',
    test: /FAILED TO BIND TO PORT|Address already in use|BindException/i,
    title: 'The port is already in use',
    detail: (ctx) => `Another program — often another Minecraft server — is already using port ${ctx.port || 'this server uses'}. ` +
      'Close the other program, or give this server a different port in Settings.',
    fix: { action: 'settings', label: 'Change the port' },
  },
  {
    id: 'heap-too-big',
    test: /Could not reserve enough space for (?:object heap|\d+KB object heap)|Invalid maximum heap size|Initial heap size set to a larger value|There is insufficient memory for the Java Runtime/i,
    title: 'Too much RAM requested',
    detail: () => 'Java couldn\'t get the amount of memory this server is set to use. Lower the RAM slider in Settings and start again.',
    fix: { action: 'settings', label: 'Lower the RAM' },
  },
  {
    id: 'out-of-memory',
    test: /java\.lang\.OutOfMemoryError/,
    title: 'The server ran out of memory',
    detail: () => 'The world, players or mods needed more RAM than the server has. Raise the RAM in Settings, lower the view distance, or remove heavy mods.',
    fix: { action: 'settings', label: 'Give it more RAM' },
  },
  {
    id: 'eula',
    test: /You need to agree to the EULA/i,
    title: 'The Minecraft EULA hasn\'t been accepted',
    detail: () => 'Every Minecraft server must agree to Mojang\'s EULA (minecraft.net/eula) before it can start.',
    fix: { action: 'eula', label: 'I agree to the EULA' },
  },
  {
    id: 'mod-wrong-minecraft',
    test: /(?:requires|depends on)[^\n]*\bminecraft\b[^\n]*(?:but only the wrong version is present|which is missing)|Incompatible mod set/i,
    title: 'A mod is made for a different Minecraft version',
    detail: (ctx) => `${modList(ctx) || 'One of the mods'} doesn't support this Minecraft version. Download the version of that mod made for this server's version, or remove it from the mods folder.`,
    fix: { action: 'folder', label: 'Open the server folder' },
  },
  {
    id: 'mod-missing-dependency',
    test: /requires (?:any version|version [^\s]+|[^\s]+) of (?:mod )?'?[\w .-]+'?.*which is missing|Mod resolution failed|Incompatible mods? found/i,
    title: 'A mod is missing something it needs',
    detail: (ctx) => `${modList(ctx) || 'A mod'} needs another mod that isn't installed${ctx.missing.length ? ` (${ctx.missing.join(', ')})` : ''}. ` +
      'Add the missing mod to the mods folder — most Fabric mods need Fabric API.',
    fix: { action: 'folder', label: 'Open the server folder' },
  },
  {
    id: 'mixin',
    test: /Mixin apply(?: for mod ([\w-]+))? failed|MixinApplyError|InvalidMixinException|MixinTransformerError/i,
    title: 'A mod isn\'t compatible',
    detail: (ctx) => `${ctx.mixinMod ? `The mod "${ctx.mixinMod}"` : 'A mod'} failed to load into this Minecraft version. ` +
      'Update it, or remove it from the mods folder.',
    fix: { action: 'folder', label: 'Open the server folder' },
  },
  {
    id: 'bad-jar',
    test: /Invalid or corrupt jarfile|Unable to access jarfile|Error: Could not find or load main class/i,
    title: 'server.jar is missing or broken',
    detail: () => 'The server file couldn\'t be opened. If you moved or replaced server.jar, put a working one back — or add this server again to download a fresh copy.',
    fix: { action: 'folder', label: 'Open the server folder' },
  },
  {
    id: 'world-locked',
    test: /session\.lock|is already locked|LevelStorageException|The directory .* is locked/i,
    title: 'The world is open somewhere else',
    detail: () => 'Another Minecraft server or program is using this world folder. Close it (check Task Manager for java.exe) and start again.',
    fix: null,
  },
  {
    id: 'no-permission',
    test: /AccessDeniedException|Permission denied|Access is denied/i,
    title: 'The server can\'t write to its folder',
    detail: () => 'Windows blocked the server from saving files. The folder may be read-only or synced by OneDrive — move the server to a normal folder such as Documents.',
    fix: { action: 'folder', label: 'Open the server folder' },
  },
  {
    id: 'plugin-failed',
    test: /Could not load '?plugins[\\/]([^'\s]+)'?|Error occurred while enabling ([\w-]+)/i,
    title: 'A plugin failed to load',
    detail: (ctx) => `${ctx.plugin ? `"${ctx.plugin}"` : 'A plugin'} couldn't start — usually because it's made for a different Minecraft version. Update or remove it from the plugins folder.`,
    fix: { action: 'folder', label: 'Open the server folder' },
  },
];

const GENERIC = {
  id: 'crashed',
  title: 'The server crashed',
  detail: (ctx) => (ctx.description
    ? `Minecraft says: "${ctx.description}". A full crash report was saved in the server's crash-reports folder.`
    : `The server stopped unexpectedly${ctx.lastError ? ` with: ${ctx.lastError}` : ''}. Check the console above for the first red error.`),
  fix: { action: 'folder', label: 'Open the server folder' },
};

function modList(ctx) {
  if (!ctx.mods.length) return '';
  const names = [...new Set(ctx.mods)].slice(0, 3).map((m) => `"${m}"`);
  return names.length === 1 ? `The mod ${names[0]}` : `The mods ${names.join(', ')}`;
}

function context(lines, extra) {
  const ctx = { mods: [], missing: [], plugin: null, mixinMod: null, description: null, lastError: null, ...extra };
  for (const line of lines) {
    let m = /Mod '([^']+)' \([\w-]+\) [^\s]+ (?:requires|depends on)[^']*'([^']+)'/.exec(line);
    if (m) {
      ctx.mods.push(m[1]);
      if (!/^minecraft$/i.test(m[2]) && !/wrong version/.test(line)) ctx.missing.push(m[2]);
    }
    m = /Mixin apply for mod ([\w-]+) failed/i.exec(line);
    if (m) ctx.mixinMod = m[1];
    m = /Could not load '?plugins[\\/]([^'\s]+)'?/i.exec(line) || /Error occurred while enabling ([\w-]+)/i.exec(line);
    if (m && !ctx.plugin) ctx.plugin = m[1];
    m = /^Description: (.+)$/.exec(line.trim());
    if (m) ctx.description = m[1].slice(0, 160);
    if (!ctx.lastError && /(?:Exception|Error)(?::|\b)/.test(line) && !/^\s*at /.test(line)) {
      ctx.lastError = line.replace(/^\[[^\]]*\]\s*(?:\[[^\]]*\]:?\s*)?/, '').trim().slice(0, 160);
    }
  }
  ctx.missing = [...new Set(ctx.missing)].slice(0, 3);
  return ctx;
}

/**
 * @param {string[]} lines recent console lines (oldest first)
 * @param {{ port?: number, crashed?: boolean }} extra
 * @returns {Array} diagnoses, most relevant first (empty if nothing matched and it didn't crash)
 */
function explainCrash(lines, extra = {}) {
  const ctx = context(lines, extra);
  const found = [];
  for (const rule of RULES) {
    const evidence = lines.find((l) => rule.test.test(l));
    if (evidence) found.push(toDiagnosis(rule, ctx, evidence));
  }
  // "Wrong Minecraft version" is the more useful reading of a resolution failure.
  if (found.some((d) => d.id === 'mod-wrong-minecraft')) {
    const i = found.findIndex((d) => d.id === 'mod-missing-dependency');
    if (i !== -1 && !ctx.missing.length) found.splice(i, 1);
  }
  if (!found.length && extra.crashed) found.push(toDiagnosis(GENERIC, ctx, ctx.lastError || ''));
  return found.slice(0, 3);
}

function toDiagnosis(rule, ctx, evidence) {
  return { id: rule.id, title: rule.title, detail: rule.detail(ctx), fix: rule.fix, evidence: String(evidence).slice(0, 300) };
}

module.exports = { explainCrash };
