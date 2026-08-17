'use strict';

/** True for loopback/private/link-local hosts — mirrors the mod's own relay-URL validation. */
function isPrivateOrLocalHost(hostname) {
  // URL#hostname keeps the brackets around an IPv6 literal (e.g. "[::1]").
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 unique local fc00::/7
  if (h.startsWith('fe80')) return true; // IPv6 link-local
  return false;
}

/**
 * A custom relay URL must be wss:// unless it points at a loopback/private
 * address — this stops the device token from being sent in cleartext to a
 * remote host by accident (a typo'd scheme or a copy-pasted ws:// example).
 */
function isSafeRelayUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol === 'wss:') return true;
  if (u.protocol === 'ws:') return isPrivateOrLocalHost(u.hostname);
  return false;
}

module.exports = { isPrivateOrLocalHost, isSafeRelayUrl };
