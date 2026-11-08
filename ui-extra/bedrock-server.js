'use strict';

// The Bedrock Dedicated Server type's few changes to the screens. Everything the Electron renderer already does for Java servers is left
// alone; the patches in tools/ui-patches-bedrock.js call into this file at the places where a Bedrock server differs (no Java, no memory
// setting, a UDP address with a port, an allow-list of gamertags, nothing to install into). Plain functions of the page, so every one of
// them also puts the Java wording back when the server in front of the person is not a Bedrock one.
(function (root) {
  const TYPE = 'bedrock-server';
  const byId = (id) => document.getElementById(id);
  const say = (text, vars) => (typeof root.t === 'function' ? root.t(text, vars) : text);

  const isType = (type) => type === TYPE;
  const isProfile = (profile) => Boolean(profile) && profile.type === TYPE;
  const typeName = (type) => ({ vanilla: 'Vanilla', paper: 'Paper', fabric: 'Fabric', [TYPE]: 'Bedrock Server' }[type] || type);

  /** Remembers what an element said before this file changed it, so the Java words can be put back. */
  function swapText(el, bedrockText, bedrock) {
    if (!el) return;
    if (el.dataset.javaText === undefined) el.dataset.javaText = el.textContent;
    el.textContent = bedrock ? bedrockText : el.dataset.javaText;
  }

  /** Wizard step 2: a Bedrock server needs no Java and no memory setting, listens on UDP 19132, and has its own terms. */
  function applyConfigScreen(type) {
    const bedrock = isType(type);
    byId('javaBlock').classList.toggle('hidden', bedrock);
    byId('ramField').classList.toggle('hidden', bedrock);
    const port = byId('serverPort');
    if (bedrock && port.value === '25565') port.value = '19132';
    if (!bedrock && port.value === '19132') port.value = '25565';
    const eula = byId('eulaText');
    if (eula.dataset.javaHtml === undefined) eula.dataset.javaHtml = eula.innerHTML;
    eula.innerHTML = bedrock
      ? 'I agree to the <a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">Minecraft EULA</a> and the <a href="https://go.microsoft.com/fwlink/?LinkId=521839" target="_blank" rel="noreferrer">Microsoft Privacy Statement</a>.'
      : eula.dataset.javaHtml;
    return bedrock;
  }

  /** The "share this address" box: a Bedrock server has no Java address to type, only a server name and one port. */
  function applyShareLayout(bedrock) {
    byId('shareAddressRow').classList.toggle('hidden', bedrock);
    byId('nameBox').classList.toggle('hidden', bedrock);
    byId('srvVoiceStatus').classList.toggle('hidden', bedrock); // voice chat is for Java servers
    swapText(byId('shareLabel'), say('Share this with Bedrock players: Play → Servers → Add Server'), bedrock);
  }

  /** The performance panel: the tick rate is a Java server's number. */
  function applyPerfLayout(bedrock) {
    const tile = byId('perfTps').closest('.perf-tile');
    if (tile) tile.classList.toggle('hidden', bedrock);
  }

  /** The settings screen: hide what only a Java server has, and say how Bedrock players join. */
  function applySettingsLayout(data) {
    const bedrock = Boolean(data && data.bedrockServer);
    for (const el of document.querySelectorAll('#screen-settings [data-java-only]')) el.classList.toggle('hidden', bedrock);
    const note = byId('setBdsNote');
    note.classList.toggle('hidden', !bedrock);
    note.textContent = bedrock
      ? say('Bedrock Dedicated Server {version}. Players join with the server name and port shown on the server screen once it is public. Changes apply after a restart.', { version: (data.profile && data.profile.version) || '' })
      : '';
    return bedrock;
  }

  /** The friends-only screen: gamertags (which may hold spaces) on the server's allow-list. */
  function applyFriendsLayout(profile) {
    const bedrock = isProfile(profile);
    const field = byId('friendsInput').closest('label');
    swapText(field.querySelector('.label'), say('Add friends by gamertag'), bedrock);
    swapText(field.querySelector('.hint'), say('Separate gamertags with commas or new lines. A gamertag can hold spaces.'), bedrock);
    swapText(byId('friendsEnabled').closest('label').querySelector('span'), say('Only let my friends join (allow-list on)'), bedrock);
    swapText(byId('friendsAddBtn'), say('Add to the allow-list'), bedrock);
    swapText(byId('friendsList').previousElementSibling, say('On the allow-list'), bedrock);
    const input = byId('friendsInput');
    if (input.dataset.javaPlaceholder === undefined) input.dataset.javaPlaceholder = input.placeholder;
    input.placeholder = bedrock ? 'Steve, Alex Smith' : input.dataset.javaPlaceholder;
  }

  root.VPBedrockServer = { TYPE, isType, isProfile, typeName, applyConfigScreen, applyShareLayout, applyPerfLayout, applySettingsLayout, applyFriendsLayout };
})(window);
