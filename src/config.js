// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  poll_interval: POLL_INTERVAL.default,
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** An IPv4 address a box can have: not 0.0.0.0, not broadcast, not multicast. */
function usableIpv4(ip) {
  const [a] = ip.split('.').map(Number);
  return ip !== '0.0.0.0' && ip !== '255.255.255.255' && !(a >= 224 && a <= 239) && a !== 0;
}

/**
 * The address of a box typed by the user: an IPv4 address or a host name (a
 * pasted URL is reduced to its host; the ports are always the box's own).
 * @returns {string | undefined} undefined when invalid or empty.
 */
export function parseHost(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d{1,5}$/, '')
    .toLowerCase();
  if (text === '' || text.length > 253) {
    return undefined;
  }
  if (isIP(text) === 4) {
    return usableIpv4(text) ? text : undefined;
  }
  if (/^[\d.]+$/.test(text)) {
    return undefined;
  }
  return text.split('.').every((label) => LABEL.test(label)) ? text : undefined;
}

const entries = (raw) =>
  String(raw ?? '')
    .split(/[\s,;]+/)
    .filter((entry) => entry !== '');

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const addresses = [];
  let invalid = 0;
  for (const entry of entries(c.addresses)) {
    const host = parseHost(entry);
    if (!host) {
      // Counted, never shown back (it may hold anything).
      invalid += 1;
    } else if (!addresses.includes(host) && addresses.length < LIMITS.addresses) {
      addresses.push(host);
    }
  }
  const text = String(c.poll_interval ?? '').trim();
  const interval = text === '' ? NaN : Number(text);
  return {
    addresses,
    invalid,
    pollInterval: Number.isFinite(interval)
      ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
      : POLL_INTERVAL.default,
  };
}
