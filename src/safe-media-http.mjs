import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { mediaError } from './media-storage.mjs';

const blocked4 = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked4.addSubnet(address, prefix);
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new BlockList();
for (const [address,prefix] of [['2001::',32],['2001:db8::',32],['2002::',16]]) blocked6.addSubnet(address,prefix,'ipv6');
export function isPublicMediaAddress(address) {
  if (isIP(address) === 4) return !blocked4.check(address, 'ipv4');
  return isIP(address) === 6 && global6.check(address, 'ipv6') && !blocked6.check(address, 'ipv6');
}
export async function resolveMediaTarget(value, lookup = dns.lookup) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw mediaError('REMOTE_MEDIA_INVALID', '仅允许无凭据的 HTTPS 443 媒体地址。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !isPublicMediaAddress(item.address))) throw mediaError('REMOTE_MEDIA_ADDRESS_FORBIDDEN', '媒体目标包含禁止访问的网络地址。');
  return { url, addresses };
}

// DNS is resolved once per hop and pinned into the actual TLS connection.
// Keep the original hostname for certificate verification and SNI.
export async function openMediaResponse(value, { signal, lookup = dns.lookup, requestImpl = https.request, idleTimeoutMs = 15_000, maxRedirects = 5 } = {}) {
  let target = value;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    signal?.throwIfAborted();
    const { url, addresses } = await abortableResolution(target, lookup, signal);
    const response = await new Promise((resolve, reject) => {
      const request = requestImpl(url, { signal, agent: false, headers: { 'user-agent': 'SoloToChina-Media-Recovery/2.0' },
        lookup: (_hostname, options, callback) => options?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
      }, resolve);
      request.on('error', reject);
      request.setTimeout(idleTimeoutMs, () => request.destroy(mediaError('REMOTE_MEDIA_STALLED', '远程媒体响应无进展。', 504)));
      request.on('socket', socket => socket.once('secureConnect', () => {
        const allowed = new BlockList();
        for (const item of addresses) allowed.addAddress(item.address, item.family === 6 ? 'ipv6' : 'ipv4');
        const remote = socket.remoteAddress || '';
        if (!allowed.check(remote, isIP(remote) === 6 ? 'ipv6' : 'ipv4')) request.destroy(mediaError('REMOTE_MEDIA_ADDRESS_CHANGED', '实际连接地址不匹配已验证的目标。'));
      }));
      request.end();
    });
    if ([301,302,303,307,308].includes(response.statusCode)) {
      response.destroy();
      if (!response.headers.location || hop === maxRedirects) throw mediaError('REMOTE_MEDIA_REDIRECT_LIMIT', '媒体重定向次数超出限制。');
      target = new URL(response.headers.location, url);
      continue;
    }
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode,
      headers: { get: key => response.headers[key.toLowerCase()] || null }, body: response, cancel: () => response.destroy() };
  }
}

async function abortableResolution(target, lookup, signal) {
  if (!signal) return resolveMediaTarget(target, lookup);
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([resolveMediaTarget(target, lookup), new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, {once:true});
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
