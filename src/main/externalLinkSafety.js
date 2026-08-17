'use strict';

// Item 16: shell.openExternal must never blindly take a renderer-provided
// URL. Only https:// to one of these known, approved domains (and their
// subdomains) is allowed; everything else (file:, javascript:, data:, ftp:,
// custom protocols, malformed URLs, and https:// to an unapproved domain)
// is rejected.
const APPROVED_DOMAINS = [
  'voxelport.in',
  'github.com',
  'minecraft.net',
  'adoptium.net',
];

function isApprovedExternalUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return APPROVED_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

module.exports = { isApprovedExternalUrl, APPROVED_DOMAINS };
