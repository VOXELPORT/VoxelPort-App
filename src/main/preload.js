'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge — the renderer has no Node access and can only call these.
contextBridge.exposeInMainWorld('vp', {
  // app:info deliberately never returns the raw device token — see token.js/main.js.
  info: () => ipcRenderer.invoke('app:info'),
  versions: () => ipcRenderer.invoke('app:versions'),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
  openDiscord: () => ipcRenderer.invoke('community:discord'),
  copyToken: () => ipcRenderer.invoke('token:copy'),
  copySupporterID: () => ipcRenderer.invoke('supporterID:copy'),
  discordState: () => ipcRenderer.invoke('discord:state'),
  discordSignIn: () => ipcRenderer.invoke('discord:signIn'),
  discordCancel: () => ipcRenderer.invoke('discord:cancel'),
  discordRecheck: () => ipcRenderer.invoke('discord:recheck'),
  discordSignOut: () => ipcRenderer.invoke('discord:signOut'),
  discordOpenInvite: () => ipcRenderer.invoke('discord:openInvite'),
  identitySave: (passphrase) => ipcRenderer.invoke('identity:save', passphrase),
  identityRestore: (passphrase) => ipcRenderer.invoke('identity:restore', passphrase),
  identityDelete: () => ipcRenderer.invoke('identity:delete'),
  voiceState: () => ipcRenderer.invoke('voice:state'),

  start: (opts) => ipcRenderer.invoke('tunnel:start', opts),
  stop: () => ipcRenderer.invoke('tunnel:stop'),

  on: (channel, cb) => {
    const allowed = [
      'tunnel:status',
      'discord:state',
      'tunnel:assigned',
      'tunnel:voice',
      'tunnel:players',
      'tunnel:ping',
      'tunnel:log',
      'tunnel:error',
      'server:status',
      'server:log',
      'server:players',
      'server:playerNames',
      'server:exit',
      'install:progress',
      'java:progress',
      'app:state',
      'update:available',
      'update:downloaded',
      'update:error',
      'tunnel:name',
      'tunnel:nameError',
      'perf:sample',
      'server:diagnosis',
      'bedrock:progress',
      'accounts:progress',
      'addons:progress',
      'tunnel:region',
      'tunnel:notice',
      'backup:progress',
    ];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_evt, payload) => cb(payload));
  },

  system: {
    specs: () => ipcRenderer.invoke('system:specs'),
  },

  // The language the screen is showing, so messages the main process writes (crash explanations,
  // in-game chat lines) use it too.
  setLanguage: (lang) => ipcRenderer.invoke('app:setLanguage', { lang }),

  java: {
    check: (version) => ipcRenderer.invoke('java:check', { version }),
    install: (version) => ipcRenderer.invoke('java:install', { version }),
    openDownloadPage: () => ipcRenderer.invoke('java:openDownloadPage'),
  },

  server: {
    types: () => ipcRenderer.invoke('server:types'),
    versions: (type) => ipcRenderer.invoke('server:versions', { type }),
    defaultDir: () => ipcRenderer.invoke('server:defaultDir'),
    chooseFolder: () => ipcRenderer.invoke('server:chooseFolder'),
    detectExisting: (dir) => ipcRenderer.invoke('server:detectExisting', { dir }),
    install: (config) => ipcRenderer.invoke('server:install', config),
    import: (input) => ipcRenderer.invoke('server:import', input),

    list: () => ipcRenderer.invoke('server:profiles:list'),
    get: (id) => ipcRenderer.invoke('server:profiles:get', { id }),
    update: (id, changes) => ipcRenderer.invoke('server:profiles:update', { id, changes }),
    remove: (id) => ipcRenderer.invoke('server:profiles:delete', { id }),

    start: (id) => ipcRenderer.invoke('server:start', { id }),
    stop: () => ipcRenderer.invoke('server:stop'),
    restart: () => ipcRenderer.invoke('server:restart'),
    command: (command) => ipcRenderer.invoke('server:command', { command }),
    playerAction: (action, name) => ipcRenderer.invoke('server:playerAction', { action, name }),
    openFolder: (id) => ipcRenderer.invoke('server:openFolder', { id }),
    makePublic: (id) => ipcRenderer.invoke('server:makePublic', { id }),
    templates: () => ipcRenderer.invoke('server:templates'),
    getSettings: (id) => ipcRenderer.invoke('server:settings:get', { id }),
    saveSettings: (input) => ipcRenderer.invoke('server:settings:save', input),
    setBedrock: (id, enabled) => ipcRenderer.invoke('server:bedrock:set', { id, enabled }),
    fix: (id, action) => ipcRenderer.invoke('server:fix', { id, action }),

    state: () => ipcRenderer.invoke('server:state'),
  },

  // The server's own folder, as a small file browser. Paths are relative to the server folder and checked in the main process.
  files: {
    list: (id, path) => ipcRenderer.invoke('files:list', { id, path }),
    read: (id, path) => ipcRenderer.invoke('files:read', { id, path }),
    write: (id, path, text) => ipcRenderer.invoke('files:write', { id, path, text }),
  },

  backups: {
    info: (id) => ipcRenderer.invoke('backup:info', { id }),
    create: (id) => ipcRenderer.invoke('backup:create', { id }),
    restore: (id, name) => ipcRenderer.invoke('backup:restore', { id, name }),
    remove: (id, name) => ipcRenderer.invoke('backup:delete', { id, name }),
    setSettings: (id, settings) => ipcRenderer.invoke('backup:settings:set', { id, settings }),
    openFolder: (id) => ipcRenderer.invoke('backup:openFolder', { id }),
  },

  accounts: {
    get: (id) => ipcRenderer.invoke('server:accounts:get', { id }),
    set: (id, cracked, confirmed) => ipcRenderer.invoke('server:accounts:set', { id, cracked, confirmed }),
    installLogin: (id) => ipcRenderer.invoke('server:accounts:installLogin', { id }),
  },

  // Plugins (Paper) and mods (Fabric) from Modrinth. The renderer only sends ids and search words, never URLs or paths.
  addons: {
    get: (id) => ipcRenderer.invoke('addons:get', { id }),
    search: (id, query, anyVersion, offset) => ipcRenderer.invoke('addons:search', { id, query, anyVersion, offset }),
    install: (id, projectId, title) => ipcRenderer.invoke('addons:install', { id, projectId, title }),
    remove: (id, projectId) => ipcRenderer.invoke('addons:remove', { id, projectId }),
    openFolder: (id) => ipcRenderer.invoke('addons:openFolder', { id }),
  },

  // Import a Modrinth .mrpack and build a Fabric server from it.
  modpack: {
    choose: () => ipcRenderer.invoke('modpack:choose'),
    install: (config) => ipcRenderer.invoke('modpack:install', config),
  },

  // Friends-only hosting: the whitelist, edited from one screen.
  whitelist: {
    status: (id) => ipcRenderer.invoke('whitelist:status', { id }),
    add: (id, text) => ipcRenderer.invoke('whitelist:add', { id, text }),
    remove: (id, name) => ipcRenderer.invoke('whitelist:remove', { id, name }),
    setEnabled: (id, on) => ipcRenderer.invoke('whitelist:setEnabled', { id, on }),
  },

  // The Support screen. Links are opened by id/kind: the renderer never passes a URL.
  support: {
    get: (force) => ipcRenderer.invoke('support:get', { force }),
    open: (what, id) => ipcRenderer.invoke('support:open', { what, id }),
    copyUpi: () => ipcRenderer.invoke('support:copyUpi'),
  },

  name: {
    get: () => ipcRenderer.invoke('name:get'),
    claim: (name) => ipcRenderer.invoke('name:claim', { name }),
    release: () => ipcRenderer.invoke('name:release'),
  },

  // Discord Rich Presence: "available" is false until the app has a Discord application id, and the option is then hidden.
  presence: {
    get: () => ipcRenderer.invoke('presence:get'),
    set: (enabled) => ipcRenderer.invoke('presence:set', { enabled }),
  },

  region: {
    get: () => ipcRenderer.invoke('region:get'),
    set: (preference) => ipcRenderer.invoke('region:set', { preference }),
  },

  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
  },
});
