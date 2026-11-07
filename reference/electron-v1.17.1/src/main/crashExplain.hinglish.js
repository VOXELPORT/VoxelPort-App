'use strict';

// The "why it stopped" explanations in Hinglish (Hindi in the English alphabet). One entry per rule in
// crashExplain.js, with the same id; test/crashExplain.test.js checks that none is missing.
// `ctx` is what crashExplain.js worked out from the console: port, mods, missing, plugin, mixinMod, ...

function modList(ctx) {
  if (!ctx.mods.length) return '';
  const names = [...new Set(ctx.mods)].slice(0, 3).map((m) => `"${m}"`);
  return names.length === 1 ? `Mod ${names[0]}` : `Mods ${names.join(', ')}`;
}

const FOLDER = 'Server folder kholo';

module.exports = {
  'port-in-use': {
    title: 'Port pehle se use mein hai',
    detail: (ctx) => `Koi aur program — aksar doosra Minecraft server — port ${ctx.port || 'jo yeh server use karta hai'} pehle se use kar raha hai. `
      + 'Doosra program band karo, ya Settings mein is server ko alag port do.',
    fix: 'Port badlo',
  },
  'heap-too-big': {
    title: 'Bahut zyada RAM maangi gayi',
    detail: () => 'Java ko utni memory nahi mili jitni is server ke liye set hai. Settings mein RAM slider kam karo aur dobara start karo.',
    fix: 'RAM kam karo',
  },
  'out-of-memory': {
    title: 'Server ki memory khatam ho gayi',
    detail: () => 'World, players ya mods ko server ki RAM se zyada memory chahiye thi. Settings mein RAM badhao, view distance kam karo, ya bhaari mods hatao.',
    fix: 'Zyada RAM do',
  },
  eula: {
    title: 'Minecraft EULA manzoor nahi kiya gaya',
    detail: () => 'Har Minecraft server ko start hone se pehle Mojang ka EULA (minecraft.net/eula) manzoor karna padta hai.',
    fix: 'Main EULA se sehmat hoon',
  },
  'mod-wrong-minecraft': {
    title: 'Ek mod doosre Minecraft version ke liye bana hai',
    detail: (ctx) => `${modList(ctx) || 'Ek mod'} is Minecraft version ko support nahi karta. `
      + 'Us mod ka is server ke version wala version download karo, ya use mods folder se hata do.',
    fix: FOLDER,
  },
  'mod-missing-dependency': {
    title: 'Ek mod ko kuch chahiye jo maujood nahi hai',
    detail: (ctx) => `${modList(ctx) || 'Ek mod'} ko ek aur mod chahiye jo install nahi hai${ctx.missing.length ? ` (${ctx.missing.join(', ')})` : ''}. `
      + 'Missing mod ko mods folder mein daalo — zyada tar Fabric mods ko Fabric API chahiye.',
    fix: FOLDER,
  },
  mixin: {
    title: 'Ek mod compatible nahi hai',
    detail: (ctx) => `${ctx.mixinMod ? `Mod "${ctx.mixinMod}"` : 'Ek mod'} is Minecraft version mein load nahi ho paya. `
      + 'Use update karo, ya mods folder se hata do.',
    fix: FOLDER,
  },
  'bad-jar': {
    title: 'server.jar missing ya kharab hai',
    detail: () => 'Server file khul nahi payi. Agar tumne server.jar hataya ya badla hai, to chalne wali file wapas rakho — '
      + 'ya server ko dobara jodo taaki nayi copy download ho.',
    fix: FOLDER,
  },
  'world-locked': {
    title: 'World kahin aur khuli hui hai',
    detail: () => 'Koi aur Minecraft server ya program is world folder ko use kar raha hai. '
      + 'Use band karo (Task Manager mein java.exe dekho) aur dobara start karo.',
    fix: null,
  },
  'no-permission': {
    title: 'Server apne folder mein likh nahi pa raha',
    detail: () => 'Windows ne server ko files save karne se roka. Folder read-only ho sakta hai ya OneDrive usse sync kar raha ho — '
      + 'server ko Documents jaise normal folder mein le jao.',
    fix: FOLDER,
  },
  'plugin-failed': {
    title: 'Ek plugin load nahi hua',
    detail: (ctx) => `${ctx.plugin ? `"${ctx.plugin}"` : 'Ek plugin'} start nahi ho paya — aksar isliye ki woh doosre Minecraft version ke liye bana hai. `
      + 'Use update karo ya plugins folder se hata do.',
    fix: FOLDER,
  },
  crashed: {
    title: 'Server crash ho gaya',
    detail: (ctx) => (ctx.description
      ? `Minecraft kehta hai: "${ctx.description}". Poori crash report server ke crash-reports folder mein save hui hai.`
      : `Server achanak band ho gaya${ctx.lastError ? ` is error ke saath: ${ctx.lastError}` : ''}. Upar console mein pehla laal error dekho.`),
    fix: FOLDER,
  },
};
