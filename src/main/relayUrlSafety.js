'use strict';

const net = require('net');

/**
 * True for loopback/private/link-local hosts — mirrors the mod's own
 * relay-URL validation. Uses net.isIP() to classify the literal first, so a
 * DNS name that merely *starts with* private-looking characters (e.g.
 * "fcevil.example", "10.example.com") is never misclassified as an IP
 * address — only "localhost" and genuine IPv4/IPv6 literals are special-cased.
 */
function isPrivateOrLocalHost(hostname) {
  // URL#hostname keeps the brackets around an IPv6 literal (e.g. "[::1]").
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost') return true;

  const version = net.isIP(h); // 0 = not an IP, 4 = IPv4, 6 = IPv6

  if (version === 4) {
    const [a, b] = h.split('.').map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }

  if (version === 6) {
    if (h === '::1') return true; // loopback
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local fc00::/7
    if (h.startsWith('fe80')) return true; // link-local
    return false;
  }

  // Not "localhost" and not a real IP literal — a plain DNS name, however
  // it's spelled, is never treated as private/local.
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
