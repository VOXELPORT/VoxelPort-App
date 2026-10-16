'use strict';

// What the screen says about Direct mode, as a plain function of the status the main process reports (see
// src/main/directMode.js) and a translate function. No page access, so it can be tested.
(function (root) {
  /**
   * @param {{state: string, code?: string, detail?: string, ip?: string, port?: number, address?: string}|null} status
   * @param {(text: string, vars?: object) => string} t
   * @returns {{text: string, tone: 'ok'|'info'|'warn'|'err'|'', retry: boolean}} tone picks the colour; retry shows "Try again"
   */
  function describeDirect(status, t) {
    const s = status || { state: 'off' };
    switch (s.state) {
      case 'working':
        return { text: s.code === 'checking' ? t('Checking from the internet…') : t('Opening a port on your router…'), tone: 'info', retry: false };
      case 'on':
        return {
          text: s.address
            ? t('Direct is on: players who join {address} connect straight to your PC.', { address: s.address })
            : t('Direct is on. Players can also join straight at {address}.', { address: `${s.ip}:${s.port}` }),
          tone: 'ok',
          retry: false,
        };
      case 'fallback':
        return {
          text: t('Direct is paused: players are using the relay again. It switches back by itself when your server is reachable.'),
          tone: 'warn',
          retry: false,
        };
      case 'unsupported':
        return {
          text: t("Your internet provider shares one public address between many customers (CGNAT), so players can't connect to this PC directly. Players keep using the relay."),
          tone: 'info',
          retry: false,
        };
      case 'failed':
        return { text: failedText(s, t), tone: 'err', retry: true };
      default:
        return { text: '', tone: '', retry: false };
    }
  }

  function failedText(s, t) {
    switch (s.code) {
      case 'no-router':
        return t("Your router didn't answer. UPnP may be switched off in its settings. Turn it on, then try again. Players keep using the relay.");
      case 'refused':
        return t('Your router refused to forward a port. Try again. Players keep using the relay.');
      case 'port-busy':
        return t('Your router already uses that port and no other port worked. Players keep using the relay.');
      case 'timeout':
        return t("The relay didn't answer in time. Try again. Players keep using the relay.");
      case 'lost':
        return t('Your router stopped forwarding the port, so Direct mode is off. Players use the relay.');
      case 'relay':
        // The relay's own explanation (it says what it could not reach and what to check).
        return s.detail ? t(s.detail) + ' ' + t('Players keep using the relay.') : t('The relay could not reach your server. Players keep using the relay.');
      default:
        return t("Direct mode didn't work. Players keep using the relay.");
    }
  }

  const api = { describeDirect };
  root.VPDirect = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
