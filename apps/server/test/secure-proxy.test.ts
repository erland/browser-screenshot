import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { startSecureProxy } from '../src/secure-proxy.js';
import { validatePublicUrl } from '../src/network-policy.js';

function proxyHttpStatus(proxyUrl: string, absoluteUrl: string): Promise<number> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: 'GET',
      path: absoluteUrl,
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

function proxyConnectStatus(proxyUrl: string, authority: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.once('data', (chunk) => {
      resolve(chunk.toString('utf8').split('\r\n')[0]);
      socket.destroy();
    });
  });
}

describe('secure proxy', () => {
  it('rejects private HTTP proxy targets', async () => {
    const proxy = await startSecureProxy();
    try {
      await expect(proxyHttpStatus(proxy.url, 'http://127.0.0.1:8080/private')).resolves.toBe(403);
      await expect(proxyHttpStatus(proxy.url, 'http://169.254.169.254/latest/meta-data')).resolves.toBe(403);
    } finally {
      await proxy.close();
    }
  });

  it('rejects private HTTPS CONNECT targets', async () => {
    const proxy = await startSecureProxy();
    try {
      await expect(proxyConnectStatus(proxy.url, '127.0.0.1:443')).resolves.toContain('403 Forbidden');
      await expect(proxyConnectStatus(proxy.url, '169.254.169.254:443')).resolves.toContain('403 Forbidden');
    } finally {
      await proxy.close();
    }
  });
  it('blocks DNS rebinding from public to private address for HTTP and CONNECT', async () => {
    let lookups = 0;
    const resolver = async (hostname: string): Promise<string[]> => {
      expect(hostname).toBe('rebinding.example.test');
      lookups++;
      return lookups === 1 ? ['1.1.1.1'] : ['127.0.0.1'];
    };
    const proxy = await startSecureProxy(resolver);
    try {
      // Positive control: the same resolver initially points to a public IP.
      const initial = await validatePublicUrl('http://rebinding.example.test/', resolver);
      expect(initial.selectedAddress).toBe('1.1.1.1');
      // The proxy must resolve again and reject the now-private address.
      await expect(proxyHttpStatus(proxy.url, 'http://rebinding.example.test/private')).resolves.toBe(403);
      await expect(proxyConnectStatus(proxy.url, 'rebinding.example.test:443')).resolves.toContain('403 Forbidden');
      expect(lookups).toBe(3);
    } finally {
      await proxy.close();
    }
  });

});
