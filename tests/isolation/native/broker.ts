/** Исследовательский CONNECT-broker 0C. Не является AccessVerifier.
 * Доверенный transport seam предназначен только для локального стенда.
 * CONNECT проверяет authority и DNS, но не TLS SNI/HTTP authority внутри туннеля.
 */
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { connect, isIPv4 } from 'node:net';
import type { Socket } from 'node:net';

export function publicIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
  return a !== 0 && a !== 10 && a !== 127 && a < 224
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113);
}
export function connectHost(authority: string, hosts: readonly string[]): string | null {
  const match = /^([a-z0-9]+(?:[.-][a-z0-9]+)*):443$/.exec(authority);
  return match && hosts.includes(match[1]!) ? match[1]! : null;
}
export interface BrokerTransport {
  resolve(host: string): Promise<readonly string[]>;
  dial(address: string, port: number): Socket;
}
const nativeTransport: BrokerTransport = {
  resolve: async host => (await lookup(host, { family: 4, all: true })).map(result => result.address),
  dial: (host, port) => connect({ host, port }),
};
export async function startBroker(hosts: readonly string[], transport: BrokerTransport = nativeTransport): Promise<{ port: number; close(): Promise<void> }> {
  if (!hosts.length || hosts.some(host => connectHost(`${host}:443`, hosts) !== host)) throw new Error('Invalid provider allowlist');
  const allowedHosts = Object.freeze([...hosts]);
  let resolving = 0;
  const sockets = new Set<Socket>();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 3000, headersTimeout: 3000 }, (_req, res) => {
    res.writeHead(405, { Connection: 'close' }); res.end();
  });
  server.maxConnections = 16;
  server.on('connection', socket => {
    sockets.add(socket); socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => socket.destroy()); socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, client, head) => {
    const socket = client as Socket;
    const reject = () => { if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
    const host = connectHost(req.url ?? '', allowedHosts);
    if (!host || resolving >= 16 || head.length || req.headers['proxy-authorization'] || req.headers['transfer-encoding'] || req.headers['content-length']) { reject(); return; }
    resolving++;
    void (async () => {
      const addresses = await transport.resolve(host);
      if (socket.destroyed) return;
      if (!addresses.length || addresses.some(address => !publicIPv4(address))) { reject(); return; }
      // IP фиксируется после DNS проверки; повторного разрешения у dial нет.
      const upstream = transport.dial(addresses[0]!, 443);
      sockets.add(upstream); upstream.setTimeout(5000, () => upstream.destroy());
      upstream.once('close', () => { sockets.delete(upstream); socket.destroy(); });
      upstream.on('error', () => socket.destroy());
      socket.once('close', () => upstream.destroy());
      upstream.once('connect', () => {
        if (socket.destroyed) { upstream.destroy(); return; }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.pipe(upstream); upstream.pipe(socket);
      });
    })().catch(reject).finally(() => { resolving--; });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Broker bind failed');
  return { port: address.port, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
