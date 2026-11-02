/**
 * 跨进程二进制形态处理的测试。
 *
 * 这组测试来自一个真实故障：内容脚本报“本地 98438 字节”，后台也收到了数据，
 * 但因为只判断了 ArrayBuffer、没判断 ArrayBufferView，98KB 的数据被判成
 * “形态无法识别”，结果是每块都识别失败。日志里数据大小正常，极难定位。
 * 所以这里把每种可能到达的形态都覆盖一遍。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bufferToBlob, describeBinary, bytesToBase64, base64ToBytes } from '../src/common/binary.js';

test('base64 编解码能原样往返（音频传输靠它）', () => {
  const samples = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([255]),
    new Uint8Array([0, 1]),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array(1000).map((_, i) => i % 256),
    // 真实音频的典型大小
    new Uint8Array(98438).map((_, i) => (i * 7) % 256)
  ];

  for (const original of samples) {
    const encoded = bytesToBase64(original);
    const decoded = base64ToBytes(encoded);
    assert.equal(decoded.length, original.length, `长度不一致（原 ${original.length}）`);
    assert.deepEqual([...decoded], [...original], `内容不一致（原 ${original.length} 字节）`);
  }
});

test('base64 编码结果与 Buffer 的标准实现一致', () => {
  // 用 Node 的 Buffer 做交叉验证，确保编码本身符合标准
  const bytes = new Uint8Array(300).map((_, i) => (i * 13) % 256);
  const mine = bytesToBase64(bytes);
  const reference = Buffer.from(bytes).toString('base64');
  assert.equal(mine, reference, 'base64 编码必须与标准实现一致');
});

test('bytesToBase64 支持 ArrayBuffer、视图与带偏移的视图', () => {
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
  const view = new Uint8Array(backing.buffer, 2, 3);

  assert.equal(bytesToBase64(backing.buffer), Buffer.from([9, 9, 1, 2, 3, 9, 9]).toString('base64'));
  assert.equal(bytesToBase64(view), Buffer.from([1, 2, 3]).toString('base64'), '视图只应编码自己覆盖的字节');
  assert.equal(bytesToBase64(new Int16Array([1, 2])), Buffer.from(new Int16Array([1, 2]).buffer).toString('base64'));
});

test('base64 解码能识别非法输入', () => {
  assert.throws(() => base64ToBytes('abc'), /长度不合法/, '长度不是 4 的倍数应报错');
  assert.throws(() => base64ToBytes('ab!d'), /非法字符/);
  assert.throws(() => base64ToBytes(123), /不是字符串/);
  assert.throws(() => bytesToBase64('字符串不是字节'), /不是有效的字节数据/);
});

test('decode 能容忍换行与空白（消息传输可能带入）', () => {
  const original = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const encoded = bytesToBase64(original);
  const withWhitespace = `${encoded.slice(0, 4)}\n${encoded.slice(4)}`;
  assert.deepEqual([...base64ToBytes(withWhitespace)], [...original]);
});

test('bufferToBlob 优先使用 base64 字段（现在的传输方式）', async () => {
  const original = new Uint8Array([11, 22, 33, 44]);
  const blob = bufferToBlob({
    base64: bytesToBase64(original),
    mimeType: 'audio/webm'
  });
  assert.ok(blob instanceof Blob);
  assert.equal(blob.size, 4);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [11, 22, 33, 44]);
});

test('base64 损坏时返回 null 而不是抛错', () => {
  assert.equal(bufferToBlob({ base64: '这不是合法的base64!!!' }), null);
  assert.equal(bufferToBlob({ base64: '' }), null);
});

test('ArrayBuffer 形态：正常还原', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const blob = bufferToBlob({ buffer: bytes.buffer, mimeType: 'audio/webm' });
  assert.ok(blob instanceof Blob);
  assert.equal(blob.size, 5);
  assert.equal(blob.type, 'audio/webm');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4, 5]);
});

test('ArrayBufferView 形态：必须能还原（用户实际遇到的就是这种）', async () => {
  const bytes = new Uint8Array([9, 8, 7, 6]);
  // 注意：这里传的是视图本身，不是它的 .buffer
  const blob = bufferToBlob({ buffer: bytes, mimeType: 'audio/webm' });
  assert.ok(blob instanceof Blob, 'ArrayBufferView 必须能被识别');
  assert.equal(blob.size, 4);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [9, 8, 7, 6]);
});

test('带偏移的视图不会把底层缓冲的多余部分算进来', async () => {
  const backing = new Uint8Array([0, 0, 1, 2, 3, 0, 0]);
  const view = new Uint8Array(backing.buffer, 2, 3); // 只取中间的 1,2,3
  const blob = bufferToBlob({ buffer: view });
  assert.equal(blob.size, 3, '应只包含视图覆盖的 3 个字节');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
});

test('其他 TypedArray 与 DataView 也能还原', async () => {
  const int16 = new Int16Array([1, 2]);
  const blobFromInt16 = bufferToBlob({ buffer: int16 });
  assert.equal(blobFromInt16.size, int16.byteLength, 'Int16Array 必须按字节数取，而不是元素个数');

  const bytes = new Uint8Array([4, 5, 6]);
  const view = new DataView(bytes.buffer);
  const blobFromView = bufferToBlob({ buffer: view });
  assert.equal(blobFromView.size, 3);
  assert.deepEqual([...new Uint8Array(await blobFromView.arrayBuffer())], [4, 5, 6]);
});

test('带偏移的 DataView 按字节段取，不把底层缓冲全算进来', async () => {
  /* 这条用例专门锁住“视图长度 ≠ 底层缓冲长度”这个差异：
   * 如果实现按底层 buffer 取字节，就会得到 10 而不是 3。
   * DataView 没有 length 属性，只有 byteLength，容易在类型判断上被漏掉。 */
  const backing = new Uint8Array([9, 9, 7, 8, 9, 9, 9, 9, 9, 9]);
  const view = new DataView(backing.buffer, 2, 3); // 覆盖 7,8,9 三个字节
  const blob = bufferToBlob({ buffer: view });
  assert.ok(blob, 'DataView 必须能被识别');
  assert.equal(blob.size, 3, '只应包含 DataView 覆盖的 3 个字节');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [7, 8, 9]);
});

test('Blob 形态：兼容旧版内容脚本', async () => {
  const original = new Blob([new Uint8Array([5, 5, 5])], { type: 'audio/webm' });
  const blob = bufferToBlob({ blob: original });
  assert.equal(blob, original);
});

test('类数组对象形态：兜底也能还原', async () => {
  const blob = bufferToBlob({ buffer: { 0: 1, 1: 2, 2: 3, length: 3 } });
  assert.ok(blob instanceof Blob);
  assert.equal(blob.size, 3);
});

test('空消息、缺字段、无法识别的类型都返回 null 而不抛错', () => {
  assert.equal(bufferToBlob(null), null);
  assert.equal(bufferToBlob({}), null);
  assert.equal(bufferToBlob({ buffer: null }), null);
  assert.equal(bufferToBlob({ buffer: 'not-binary' }), null);
  assert.equal(bufferToBlob({ buffer: 12345 }), null);
});

test('mimeType 缺省时给一个可用的默认类型', () => {
  const blob = bufferToBlob({ buffer: new Uint8Array([1]).buffer });
  assert.equal(blob.type, 'audio/webm');
});

test('describeBinary 能说清每种形态（诊断日志靠它定位）', () => {
  assert.match(describeBinary({ buffer: new Uint8Array(100).buffer }), /ArrayBuffer\(100字节\)/);
  // 用户遇到的情况必须显示成具体视图类型，而不是含糊的 “view”
  assert.match(describeBinary({ buffer: new Uint8Array(98438) }), /Uint8Array\(98438字节\)/);
  assert.match(describeBinary({ buffer: new Uint8Array(10) }), /Uint8Array/);
  assert.match(describeBinary({ blob: new Blob([new Uint8Array(7)]) }), /Blob\(7字节\)/);
  assert.match(describeBinary({ buffer: { length: 3 } }), /类数组\(3个元素\)/);
  assert.match(describeBinary({ buffer: 'x' }), /未知二进制形态/);
  assert.match(describeBinary({}), /没有二进制字段/);
});
