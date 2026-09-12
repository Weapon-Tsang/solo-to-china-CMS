import { crc32, deflateSync } from 'node:zlib';

// A complete one-pixel RGBA PNG with real chunk lengths, CRCs and pixel data.
// The WebM contains a complete VP8 keyframe, not only a media signature.
const pngChunk = (type, bytes) => {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
};
export const png = Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]),
  pngChunk('IHDR', Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0])),
  pngChunk('IDAT', deflateSync(Buffer.from([0,255,0,0,255]))),
  pngChunk('IEND', Buffer.alloc(0)),
]);
const element = (id, body) => {
  body = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const size = body.length < 127 ? Buffer.from([128 | body.length]) : Buffer.from([64 | (body.length >> 8), body.length & 255]);
  return Buffer.concat([Buffer.from(id, 'hex'), size, body]);
};
const uint = (id, value) => element(id, [value]);
const frame = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64').subarray(20);
export const webm = Buffer.concat([
  element('1a45dfa3', Buffer.concat([uint('4286',1),uint('42f7',1),uint('42f2',4),uint('42f3',8),element('4282','webm'),uint('4287',2),uint('4285',2)])),
  element('18538067', Buffer.concat([
    element('1549a966', Buffer.concat([element('2ad7b1',[15,66,64]),element('4d80','fixture'),element('5741','fixture')])),
    element('1654ae6b', element('ae', Buffer.concat([uint('d7',1),uint('73c5',1),uint('83',1),element('86','V_VP8'),element('e0',Buffer.concat([uint('b0',1),uint('ba',1)]))]))),
    element('1f43b675', Buffer.concat([uint('e7',0),element('a3',Buffer.concat([Buffer.from([129,0,0,128]),frame]))])),
  ])),
]);
