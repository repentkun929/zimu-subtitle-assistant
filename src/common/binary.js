/**
 * 跨进程二进制数据的形态处理。
 *
 * 为什么单独成为一个模块：内容脚本通过 chrome.runtime.sendMessage 传过来的
 * 二进制，在结构上可能是 ArrayBuffer、也可能是 ArrayBufferView（Uint8Array 等），
 * 甚至退化成类数组对象。这一层判断写漏一种，后果就是“数据明明到了后台，
 * 却被判为无法识别”——用户看到的是每块都识别失败，而日志里数据大小是正常的，
 * 极难排查。所以把这段逻辑抽出来单独测。
 */

/**
 * base64 编解码：跨进程传二进制时用来绕开结构化克隆的问题。
 *
 * 为什么不用二进制对象直接传：实测在部分 Chrome + 扩展组合下，
 * chrome.runtime.sendMessage 不会保留 ArrayBuffer / TypedArray 的类型，
 * 接收端拿到的是**普通对象**（按索引存字节的那种），完全无法当作二进制使用。
 * 表现为“本地 98KB、后台说形态无法识别”，而且日志里数据大小一切正常。
 *
 * 字符串是消息通道里最可靠的基础类型，base64 只增加约 33% 体积
 * （98KB → 131KB），完全可以接受，换来的是跨版本的稳定。
 */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 用“特性检测”判断二进制类型，而不是 instanceof。
 *
 * 为什么不能用 instanceof：构造函数是按 realm（JS 执行环境）隔离的。
 * blob.arrayBuffer() 得到的 ArrayBuffer 可能来自另一个 realm，
 * 此时 `x instanceof ArrayBuffer` 会返回 false，导致“明明是合法字节却判为非法”
 * （测试里真实遇到过）。按 byteLength/byteOffset 这类结构特征判断则不受影响。
 */
function isArrayBufferLike(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.byteLength === 'number' &&
    typeof value.byteOffset !== 'number' // ArrayBuffer 没有 byteOffset，视图才有
  );
}

function isBinaryView(value) {
  return !!value && typeof value === 'object' && typeof value.byteOffset === 'number';
}

/** 把字节编码成 base64 字符串。字节可以是 TypedArray / ArrayBuffer / 类数组。 */
export function bytesToBase64(input) {
  let bytes;
  if (isArrayBufferLike(input)) bytes = new Uint8Array(input);
  else if (isBinaryView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  } else if (
    input &&
    typeof input !== 'string' && // 字符串也有 length，必须排除，否则会被编码成垃圾
    typeof input.length === 'number'
  ) {
    bytes = Uint8Array.from(input);
  } else {
    throw new Error('无法编码成 base64：不是有效的字节数据');
  }

  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;

    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? BASE64_CHARS[b2 & 63] : '=';
  }
  return out;
}

/** 把 base64 字符串解回 Uint8Array。 */
export function base64ToBytes(text) {
  if (typeof text !== 'string') throw new Error('无法解码 base64：输入不是字符串');

  const clean = text.replace(/[\s\r\n]/g, '');
  const len = clean.length;
  if (len % 4 !== 0) throw new Error('base64 字符串长度不合法');

  // 统计填充字符，算出真实字节数
  let padding = 0;
  if (len && clean[len - 1] === '=') padding++;
  if (len > 1 && clean[len - 2] === '=') padding++;
  const byteLength = (len / 4) * 3 - padding;

  const bytes = new Uint8Array(byteLength);
  let outIndex = 0;

  for (let i = 0; i < len; i += 4) {
    const c0 = BASE64_CHARS.indexOf(clean[i]);
    const c1 = BASE64_CHARS.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === '=' ? 0 : BASE64_CHARS.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === '=' ? 0 : BASE64_CHARS.indexOf(clean[i + 3]);

    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) throw new Error('base64 字符串含非法字符');

    if (outIndex < byteLength) bytes[outIndex++] = (c0 << 2) | (c1 >> 4);
    if (outIndex < byteLength) bytes[outIndex++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (outIndex < byteLength) bytes[outIndex++] = ((c2 & 3) << 6) | c3;
  }

  return bytes;
}

/**
 * 判断是不是“二进制容器”——TypedArray 与 DataView 都属于这一类。
 *
 * 两处细节都踩过：
 *  · DataView **没有 length 属性**，只有 byteLength，所以必须先认 ArrayBuffer.isView；
 *  · 字符串也有 length，不加排除会被当成二进制，悄悄产出一个垃圾 Blob。
 */
function isArrayLikeBinary(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value === 'string') return false;
  if (isArrayBufferLike(value)) return false;
  if (isBinaryView(value)) return true;
  // 跨进程克隆后退化成普通类数组对象的情况
  return typeof value.length === 'number' && value.length >= 0;
}

/**
 * 把消息里的音频数据还原成 Blob。
 *
 * 支持的形态（按可靠性排序）：
 *  · base64 字符串 —— **现在的首选传输方式**，见文件顶部说明；
 *  · ArrayBuffer / TypedArray / DataView —— 保留支持，某些环境可用；
 *  · 类数组普通对象 —— 上面那些形态被克隆降级后的样子，按元素转字节；
 *  · Blob —— 兼容旧版内容脚本。
 */
export function bufferToBlob(message) {
  if (!message) return null;
  const mimeType = message.mimeType || 'audio/webm';

  if (message.blob instanceof Blob) return message.blob;

  // 首选：base64 字符串
  if (typeof message.base64 === 'string' && message.base64.length) {
    try {
      return new Blob([base64ToBytes(message.base64)], { type: mimeType });
    } catch (err) {
      return null;
    }
  }

  const raw = message.buffer;
  if (isArrayBufferLike(raw)) return new Blob([raw], { type: mimeType });

  if (isArrayLikeBinary(raw)) {
    try {
      /* 真实视图（TypedArray / DataView）必须按“字节”取，不能按“元素”取：
       * Uint8Array.from(new Int16Array([1,2])) 只会得到 2 个字节（把 1、2 当成
       * 两个元素值），而它实际代表 4 个字节。所以视图要按 byteOffset/byteLength
       * 从底层缓冲里切出字节段。 */
      if (isBinaryView(raw)) {
        const start = raw.byteOffset || 0;
        const bytes = new Uint8Array(raw.buffer, start, raw.byteLength);
        return new Blob([bytes.slice()], { type: mimeType });
      }
      // 非视图的类数组对象（跨进程克隆退化的形态）：按元素逐个转字节
      return new Blob([Uint8Array.from(raw)], { type: mimeType });
    } catch (err) {
      return null;
    }
  }

  return null;
}

/** 描述收到的音频数据形态，用于诊断日志。 */
export function describeBinary(message) {
  if (!message) return '空消息';
  if (typeof message.base64 === 'string') return `base64字符串(${message.base64.length}字符)`;
  const raw = message.buffer;
  if (message.blob instanceof Blob) return `Blob(${message.blob.size}字节)`;
  if (isArrayBufferLike(raw)) return `ArrayBuffer(${raw.byteLength}字节)`;
  if (isBinaryView(raw)) {
    return `${(raw.constructor && raw.constructor.name) || '视图'}(${raw.byteLength}字节)`;
  }
  if (isArrayLikeBinary(raw)) return `类数组(${raw.length}个元素)`;
  if (raw && typeof raw === 'object') {
    const keys = Object.keys(raw).length;
    return `普通对象(${keys}个键，疑似二进制被克隆降级)`;
  }
  return raw ? `未知二进制形态(${typeof raw})` : '没有二进制字段';
}
