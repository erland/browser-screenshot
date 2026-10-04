import { describe, expect, it } from 'vitest';
import { isBlockedIp, validatePublicUrl, type AddressResolver } from '../src/network-policy.js';

const publicResolver: AddressResolver = async () => ['93.184.216.34'];

describe('network policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a00:1',
    '::ffff:c0a8:101',
  ])('blocks non-public address %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:808:808'])('allows public address %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it('rejects localhost and URL credentials', async () => {
    await expect(validatePublicUrl('http://localhost:3000', publicResolver)).rejects.toThrow(/Blocked hostname/);
    await expect(validatePublicUrl('https://user:pass@example.com', publicResolver)).rejects.toThrow(/credentials/);
  });

  it('rejects hostnames when any DNS result is private', async () => {
    const rebindingResolver: AddressResolver = async () => ['93.184.216.34', '127.0.0.1'];
    await expect(validatePublicUrl('https://example.test', rebindingResolver)).rejects.toThrow(/blocked address/);
  });

  it('accepts an http or https URL resolving only to public addresses', async () => {
    await expect(validatePublicUrl('https://example.test/path', publicResolver)).resolves.toMatchObject({
      selectedAddress: '93.184.216.34',
    });
  });
});
