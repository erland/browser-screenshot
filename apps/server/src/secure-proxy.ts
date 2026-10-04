import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { AddressResolver } from './network-policy.js';
import { defaultAddressResolver, validatePublicUrl } from './network-policy.js';

export interface SecureProxy {
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

function rejectSocket(socket: Duplex, status = '403 Forbidden'): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export async function startSecureProxy(resolver: AddressResolver = defaultAddressResolver): Promise<SecureProxy> {
  const sockets = new Set<Duplex>();
  const trackSocket = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.on('error', () => { /* expected during browser/proxy teardown */ });
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) throw new Error('Missing proxy target URL');
      const target = await validatePublicUrl(req.url, resolver);
      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: target.url.host };
      delete headers['proxy-connection'];

      const upstream = http.request(
        {
          host: target.selectedAddress,
          port: target.url.port ? Number(target.url.port) : 80,
          method: req.method,
          path: `${target.url.pathname}${target.url.search}`,
          headers,
          family: target.selectedAddress.includes(':') ? 6 : 4,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch {
      res.writeHead(403, { connection: 'close' });
      res.end();
    }
  });

  server.on('connect', async (req, clientSocket, head) => {
    try {
      const authority = req.url ?? '';
      const separator = authority.lastIndexOf(':');
      const rawHost = separator > -1 ? authority.slice(0, separator) : authority;
      const port = separator > -1 ? Number(authority.slice(separator + 1)) : 443;
      const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CONNECT target');

      const validated = await validatePublicUrl(`https://${host}:${port}/`, resolver);
      const upstream = trackSocket(net.connect({
        host: validated.selectedAddress,
        port,
        family: validated.selectedAddress.includes(':') ? 6 : 4,
      }));
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once('error', () => rejectSocket(clientSocket, '502 Bad Gateway'));
    } catch {
      rejectSocket(clientSocket);
    }
  });

  server.on('connection', (socket) => trackSocket(socket));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Secure proxy failed to bind');

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
