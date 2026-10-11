import { describe, expect, it } from 'vitest';
import { connectHost, publicIPv4 } from './broker.ts';

describe('native broker destination policy', () => {
  it('accepts only exact provider authorities on 443', () => {
    expect(connectHost('api.anthropic.com:443', ['api.anthropic.com'])).toBe('api.anthropic.com');
    for (const authority of ['api.anthropic.com:80', 'api.anthropic.com.evil:443', 'API.anthropic.com:443', 'api.anthropic.com.:443', 'user@api.anthropic.com:443', '[::1]:443', '127.0.0.1:443', 'api.anthropic.com:443/path', 'api.anthropic.com:443\r\n']) {
      expect(connectHost(authority, ['api.anthropic.com'])).toBeNull();
    }
  });
  it('rejects local, private, mapped IPv6, multicast and special DNS answers', () => {
    for (const address of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::ffff:127.0.0.1', '::1', '0177.0.0.1']) expect(publicIPv4(address)).toBe(false);
    expect(publicIPv4('93.184.216.34')).toBe(true);
  });
});
