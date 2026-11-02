/**
 * 云端识别客户端。跑在 background service worker 里。
 *
 * 协议选的是 OpenAI 兼容的 /audio/transcriptions：
 *   - OpenAI、硅基流动、Groq、自建网关、各家兼容层都能用同一套代码；
 *   - 想换供应商只要改 baseUrl + model，不用动扩展代码。
 *
 * API Key 只存在于 background 和 chrome.storage 里，页面脚本拿不到，
 * 避免在宿主页面留下可被读取的痕迹。
 */

import { resolveEndpointUrl } from './settings.js';
import { bytesToBase64 } from './binary.js';

/** 把服务端返回的各种字段形态都归一成一句文本。 */
function extractText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload.text === 'string') return payload.text;
  if (Array.isArray(payload.segments)) {
    return payload.segments.map((s) => s.text || '').join(' ').trim();
  }
  if (payload.data && typeof payload.data.text === 'string') return payload.data.text;
  if (Array.isArray(payload.results)) {
    return payload.results.map((r) => r.text || '').join(' ').trim();
  }
  if (payload.output && typeof payload.output.text === 'string') return payload.output.text;
  /* OpenAI 形状的对话响应 —— 阿里云百炼的 qwen3-asr-flash 走 /chat/completions
   * 时就是这一种：文字藏在 choices[0].message.content 里。
   * content 可能是字符串，也可能是 [{type:'text', text:'…'}] 这样的数组。 */
  if (Array.isArray(payload.choices) && payload.choices.length) {
    const first = payload.choices[0] || {};
    const message = first.message || first.delta || {};
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === 'string' ? part : (part && part.text) || ''))
        .join('')
        .trim();
    }
  }
  return '';
}

function guessExtension(mimeType) {
  const type = (mimeType || '').toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  return 'webm';
}

export class TranscriptionError extends Error {
  constructor(message, { status = 0, retryable = false, detail = '' } = {}) {
    super(message);
    this.name = 'TranscriptionError';
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

/**
 * 已知“只有文本大模型、没有语音识别接口”的服务商。
 *
 * 为什么要在发请求前就拦：这类服务商的域名看着很像能用的，
 * 用户拿自己已有的 Key 填进来是最自然的尝试。直接发请求的话，
 * 服务端只会回一个语焉不详的 400/404，用户很难判断到底是
 * “Key 不对”“地址写错”还是“这家根本不支持”。
 * 这里提前把结论说清楚，并给出可操作的替代方案。
 */
const TEXT_ONLY_PROVIDERS = [
  {
    match: /(^|\.)deepseek\.com$/i,
    name: 'DeepSeek',
    hint:
      'DeepSeek 的 API 只有文字对话、视觉和文件接口，没有音频转录接口，' +
      '它的模型也是文本模型，无法把录音转成文字。'
  },
  {
    match: /(^|\.)moonshot\.cn$/i,
    name: 'Moonshot / Kimi',
    hint: 'Moonshot 提供的是文本大模型接口，没有语音识别接口。'
  },
  {
    match: /(^|\.)bigmodel\.cn$/i,
    name: '智谱 GLM',
    hint:
      '智谱的 open.bigmodel.cn 是大模型接口。它另有独立的语音识别服务，' +
      '接口地址和协议都不同，不能填在这里。'
  }
];

/** 识别服务地址是否是“只有文本模型”的服务商（这类地址填了必然失败）。 */
export function detectTextOnlyProvider(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch (err) {
    return null;
  }
  return TEXT_ONLY_PROVIDERS.find((entry) => entry.match.test(host)) || null;
}

/**
 * 上传一块音频并取回文字。
 *
 * 支持两种协议，由 settings.apiStyle 选：
 *  · transcriptions —— multipart 上传文件，走 /audio/transcriptions（最通用）；
 *  · chat            —— 音频以 data URI 放进 messages，走 /chat/completions
 *                      （阿里云百炼的 qwen3-asr-flash、以及“生成式 ASR”类模型）。
 *
 * @param {Blob} blob
 * @param {object} settings 已经 normalize 过的设置
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{text: string, raw: any, elapsedMs: number}>}
 */
export async function transcribeBlob(blob, settings, options = {}) {
  const baseUrl = (settings.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new TranscriptionError('还没有配置识别服务地址，请先在设置里选择供应商或填写接口地址。');
  }

  const textOnly = detectTextOnlyProvider(baseUrl);
  if (textOnly) {
    throw new TranscriptionError(
      `${textOnly.name} 不能用来做字幕识别：${textOnly.hint}` +
        '请改用一个语音识别服务——国内可直连的硅基流动填 https://api.siliconflow.cn/v1、' +
        '模型选 Qwen/Qwen3-ASR-1.7B；或阿里云百炼填 ' +
        'https://dashscope.aliyuncs.com/compatible-mode/v1、模型选 qwen3-asr-flash。'
    );
  }

  /* 空音频块直接拦住，而且措辞不能说成“识别失败”。
   *
   * 这个坑很实际：用户点了“开启字幕”之后才播放视频，第一块录在暂停期间、
   * 内容为 0 字节。若报成“识别失败”，用户会去反复检查 API Key 和服务配置，
   * 方向完全错了——真实情况只是还没开始播放。空块也本来就不该占用一次请求。 */
  if (!blob || blob.size === 0) {
    throw new TranscriptionError(
      '这一次没有采集到音频内容（视频可能还没开始播放）。请让视频正常播放后再试。'
    );
  }

  const endpoint = resolveEndpointUrl(baseUrl, settings.apiStyle);
  const { headers, body } =
    settings.apiStyle === 'chat'
      ? await buildChatRequest(blob, settings)
      : buildUploadRequest(blob, settings);

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: options.signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new TranscriptionError(
      `连不上识别服务（${endpoint}）。检查网络，或改用本地中继 http://127.0.0.1:8787/v1。`,
      { retryable: true, detail: String((err && err.message) || err) }
    );
  }

  const elapsedMs = Date.now() - startedAt;
  const rawText = await response.text();
  let payload = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch (err) {
    payload = null;
  }

  if (!response.ok) {
    const detail = (payload && (payload.error?.message || payload.message || payload.msg)) || rawText.slice(0, 300);
    const retryable = response.status === 429 || response.status >= 500;
    throw new TranscriptionError(describeHttpError(response.status, detail, settings), {
      status: response.status,
      retryable,
      detail
    });
  }

  const text = extractText(payload);
  return { text, raw: payload, elapsedMs };
}

/** multipart 上传：最通用的那条路，绝大多数服务只认它。 */
function buildUploadRequest(blob, settings) {
  const form = new FormData();
  form.append('file', blob, `chunk.${guessExtension(blob.type)}`);
  form.append('model', settings.model || 'whisper-1');
  if (settings.language) form.append('language', settings.language);
  // 刻意不传 response_format：本插件靠“音频按视频时间轴分块”定位时间，
  // 不需要服务端时间戳。而部分国内服务只支持默认 json，
  // 传了 verbose_json 会直接 400，不如不传，兼容性最好。

  const headers = {};
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return { headers, body: form };
}

/**
 * chat 协议：把音频作为 data URI 放进 messages。
 *
 * 为什么用 data URI 而不是上传文件：这条协议压根没有“上传文件”的口子，
 * 音频只能以 URL 形式出现。我们手上只有刚录好的字节，
 * 于是按官方对“本地文件”的建议拼成 data URI（`data:audio/wav;base64,...`）。
 *
 * 关于 language：百炼把它放在 asr_options 里。不传则自动判断，
 * 传了能减少中英混说时的误判。
 */
async function buildChatRequest(blob, settings) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type || 'audio/wav';
  const body = {
    model: settings.model || 'qwen3-asr-flash',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: `data:${mime};base64,${bytesToBase64(bytes)}` }
          }
        ]
      }
    ],
    stream: false
  };
  if (settings.language) body.asr_options = { language: settings.language };

  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return { headers, body: JSON.stringify(body) };
}

function describeHttpError(status, detail, settings = {}) {
  const endpoint = resolveEndpointUrl(settings.baseUrl || '', settings.apiStyle);
  const base = {
    400:
      '服务返回 400：请求被拒绝。最常见的原因是**模型名和接口不配套**——' +
      '“在模型广场里能看到”不等于“这个端点能用”。' +
      (endpoint ? `本次请求发往 ${endpoint}。` : '') +
      '请检查：① 模型名与“调用协议”是否对应（阿里云百炼的 qwen3-asr-flash 走 chat completions，' +
      '不是 /audio/transcriptions）；② 该模型是否已在这个账号下开通。',
    401: '服务返回 401：API Key 无效或没填。',
    403: '服务返回 403：这个 Key 没有语音识别权限，或该模型未开通。',
    404: '服务返回 404：接口地址不对。注意 baseUrl 要精确到 /v1，' +
      '百炼是 .../compatible-mode/v1；若协议选错也会 404。',
    413: '服务返回 413：音频块太大，把“每块秒数”调小一点。',
    429: '服务返回 429：触发了限流，降低并发或稍后再试。',
    500: '服务返回 500：对方服务器出错。',
    502: '服务返回 502：网关错误，多为代理配置问题。',
    503: '服务返回 503：服务繁忙或该模型未开通。'
  }[status];
  const head = base || `服务返回 ${status}。`;
  return detail ? `${head} 详情：${detail}` : head;
}

/**
 * 探测服务是否可用。在设置面板里点“测试连接”时调用。
 */
export async function testConnection(settings, options = {}) {
  // 造 0.4 秒的静音 WAV 作为探测音频，成本几乎为零。
  const blob = makeSilentWav(0.4);
  const started = Date.now();
  const result = await transcribeBlob(blob, settings, options);
  return { ok: true, latencyMs: Date.now() - started, text: result.text };
}

/** 生成一小段静音 WAV（16kHz 单声道 16bit）。 */
export function makeSilentWav(seconds = 1) {
  const sampleRate = 16000;
  const samples = Math.max(1, Math.floor(sampleRate * seconds));
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Blob([buffer], { type: 'audio/wav' });
}
