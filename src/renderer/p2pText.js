'use strict';

// What the screens say about join codes (peer-to-peer), as plain functions of the status the main process reports and a
// translate function. No page access, so it can be tested.
(function (root) {
  /**
   * The player's side. @param status { state, path, port, reason, message } from p2pJoin.js
   * @returns {{ text: string, tone: 'ok'|'info'|'warn'|'err'|'', pill: string, address: string, running: boolean }}
   *   running = a join is in progress or connected (shows Stop instead of Join); address = what to type in Minecraft
   */
  function describeJoin(status, t) {
    const s = status || { state: 'idle' };
    const address = s.port > 0 ? `localhost:${s.port}` : '';
    switch (s.state) {
      case 'signaling':
        return { text: t("Looking for your friend's server…"), tone: 'info', pill: '', address: '', running: true };
      case 'connecting':
        return { text: t('Connecting straight to your friend…'), tone: 'info', pill: '', address: '', running: true };
      case 'p2p':
        return {
          text: s.path === 'lan'
            ? t('Connected straight to your friend, on the same network. Lowest ping.')
            : t('Connected straight to your friend. Lowest ping.'),
          tone: 'ok', pill: t('Direct'), address, running: true,
        };
      case 'relay':
        return { text: relayText(s.reason, t), tone: 'warn', pill: t('Relay'), address, running: true };
      case 'failed':
        return { text: s.message ? t(s.message) : t('Could not join.'), tone: 'err', pill: '', address: '', running: false };
      default:
        return { text: '', tone: '', pill: '', address: '', running: false };
    }
  }

  function relayText(reason, t) {
    switch (reason) {
      case 'timeout':
        return t("A direct connection didn't open in time, so you're connected through the relay. It works the same, with a little more delay.");
      case 'lost':
        return t('The direct connection was lost, so you are connected through the relay now.');
      case 'stalled':
        return t('The direct connection stopped answering, so you are connected through the relay now.');
      default:
        return t("A direct connection couldn't be made (a router or firewall is in the way), so you're connected through the relay. It works the same, with a little more delay.");
    }
  }

  /**
   * The host's side. @param info { enabled, public, supported, code, peers, players }
   * @returns {{ showRow: boolean, showOffer: boolean, code: string, line: string }}
   *   showOffer = join codes are off for a public server: the page offers a button to turn them on
   */
  function describeHost(info, t) {
    const i = info || {};
    const showRow = Boolean(i.enabled && i.public && i.supported);
    const showOffer = Boolean(!i.enabled && i.public && i.supported);
    if (!showRow) return { showRow: false, showOffer, code: '', line: '' };
    if (!i.code) return { showRow: true, showOffer: false, code: '', line: t('Getting your code…') };
    const peers = i.peers || 0;
    return {
      showRow: true,
      showOffer: false,
      code: i.code,
      line: peers > 0
        ? (peers === 1 ? t('1 friend connected directly.') : t('{n} friends connected directly.', { n: peers }))
        : t('Nobody has joined with the code yet.'),
    };
  }

  const api = { describeJoin, describeHost };
  root.VPP2P = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
