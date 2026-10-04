import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

export type AddressResolver = (hostname: string) => Promise<string[]>;

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function inIpv4Cidr(ip: string, base: string, prefix: number): boolean {
  const value = ipv4ToInt(ip);
  const network = ipv4ToInt(base);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

export function isBlockedIpv4(ip: string): boolean {
  return [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ].some(([base, prefix]) => inIpv4Cidr(ip, base as string, prefix as number));
}

function normalizeIpv6(ip: string): string {
  return ip.toLowerCase().split('%')[0];
}

function parseIpv6Words(ip: string): number[] {
  let value = normalizeIpv6(ip);
  const dottedTail = value.match(/(^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedTail) {
    const octets = dottedTail[2].split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      throw new NetworkPolicyError(`Invalid IPv6 address: ${ip}`);
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    value = `${value.slice(0, dottedTail.index)}${dottedTail[1]}${high}:${low}`;
  }

  const parts = value.split('::');
  if (parts.length > 2) throw new NetworkPolicyError(`Invalid IPv6 address: ${ip}`);
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((parts.length === 1 && missing !== 0) || (parts.length === 2 && missing < 1)) {
    throw new NetworkPolicyError(`Invalid IPv6 address: ${ip}`);
  }
  const words = [...left, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...right].map((part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) throw new NetworkPolicyError(`Invalid IPv6 address: ${ip}`);
    return Number.parseInt(part, 16);
  });
  if (words.length !== 8) throw new NetworkPolicyError(`Invalid IPv6 address: ${ip}`);
  return words;
}

function mappedIpv4(words: number[]): string | undefined {
  if (words.slice(0, 5).some((word) => word !== 0) || words[5] !== 0xffff) return undefined;
  return `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
}

export function isBlockedIpv6(ip: string): boolean {
  const words = parseIpv6Words(ip);
  const mapped = mappedIpv4(words);
  if (mapped) return isBlockedIpv4(mapped);

  if (words.every((word) => word === 0)) return true; // unspecified ::/128
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true; // loopback ::1/128
  if ((words[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((words[0] & 0xffc0) === 0xfe80) return true; // link local fe80::/10
  if ((words[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  throw new NetworkPolicyError(`Invalid IP address: ${ip}`);
}

export const defaultAddressResolver: AddressResolver = async (hostname) => {
  if (isIP(hostname)) return [hostname];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return [...new Set(records.map((record) => record.address))];
};

export interface ValidatedTarget {
  url: URL;
  addresses: string[];
  selectedAddress: string;
}

export async function validatePublicUrl(
  rawUrl: string,
  resolver: AddressResolver = defaultAddressResolver,
): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetworkPolicyError('Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkPolicyError(`Unsupported URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new NetworkPolicyError('URLs containing credentials are not allowed');
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new NetworkPolicyError(`Blocked hostname: ${hostname || '<empty>'}`);
  }

  const addresses = await resolver(hostname);
  if (addresses.length === 0) throw new NetworkPolicyError(`Hostname did not resolve: ${hostname}`);

  const blocked = addresses.filter(isBlockedIp);
  if (blocked.length > 0) {
    throw new NetworkPolicyError(`Target resolves to blocked address: ${blocked.join(', ')}`);
  }

  return { url, addresses, selectedAddress: addresses[0] };
}
