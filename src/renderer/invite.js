'use strict';

// The "Copy invite message" text: what a host pastes into WhatsApp or Discord so friends know exactly how to
// join, including how Bedrock players do it, and where the free hosting came from.
// A plain function with no page access, so it can be tested (and the Android app uses the same wording).
(function (root) {
  const SITE = 'https://voxelport.in';

  const WORDS = {
    en: {
      title: (name) => (name ? `🎮 Join my Minecraft server: ${name}` : '🎮 Join my Minecraft server!'),
      java: (version) => (version ? `Minecraft Java ${version}` : 'Minecraft Java'),
      address: 'Address',
      orPlain: 'or',
      bedrock: '📱 Bedrock (phone / console / Windows 10):',
      bedrockServer: 'Server',
      bedrockPort: 'Port',
      how: 'How to join: Minecraft → Multiplayer → Add Server → paste the address.',
      footer: `No mods needed. Free server, hosted with VoxelPort: ${SITE}`,
    },
    hinglish: {
      title: (name) => (name ? `🎮 Mere Minecraft server mein aao: ${name}` : '🎮 Mere Minecraft server mein aao!'),
      java: (version) => (version ? `Minecraft Java ${version}` : 'Minecraft Java'),
      address: 'Address',
      orPlain: 'ya',
      bedrock: '📱 Bedrock (phone / console / Windows 10):',
      bedrockServer: 'Server',
      bedrockPort: 'Port',
      how: 'Kaise judo: Minecraft → Multiplayer → Add Server → address paste karo.',
      footer: `Koi mod nahi chahiye. Free server, VoxelPort se bana hai: ${SITE}`,
    },
  };

  /** One line of plain text: no line breaks or control characters, and not absurdly long. */
  function oneLine(text, max) {
    // eslint-disable-next-line no-control-regex
    return String(text == null ? '' : text).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  /**
   * @param {object} o
   * @param {'en'|'hinglish'} o.lang
   * @param {string} [o.name]         the server's name
   * @param {string} [o.version]      Minecraft version ("unknown" is left out)
   * @param {string} o.address        what to type in Minecraft (custom address or host:port)
   * @param {string} [o.plainAddress] host:port, shown as the fallback when `address` is a custom name
   * @param {{host: string, port: number|string}|null} [o.bedrock]
   */
  function buildInviteMessage({ lang = 'en', name, version, address, plainAddress, bedrock = null }) {
    const w = WORDS[lang] || WORDS.en;
    const ver = oneLine(version, 20);
    const lines = [w.title(oneLine(name, 60)), ''];
    lines.push(w.java(ver && ver !== 'unknown' ? ver : ''));
    lines.push(`${w.address}: ${oneLine(address, 120)}`);
    const plain = oneLine(plainAddress, 120);
    if (plain && plain !== oneLine(address, 120)) lines.push(`(${w.orPlain}: ${plain})`);
    if (bedrock && bedrock.host && bedrock.port) {
      lines.push('', w.bedrock, `${w.bedrockServer}: ${oneLine(bedrock.host, 120)}   ${w.bedrockPort}: ${oneLine(bedrock.port, 6)}`);
    }
    lines.push('', w.how, w.footer);
    return lines.join('\n');
  }

  const api = { buildInviteMessage };
  root.VPInvite = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
