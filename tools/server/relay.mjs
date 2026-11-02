#!/usr/bin/env node
/**
 * 本地中继服务（零依赖，只用 Node 内置模块）。
 *
 * 它解决两个很实际的问题：
 *  1. CORS：浏览器扩展虽有 host permission，但把请求绕本机一圈，
 *     调试时能看到完整请求/响应，排错容易得多；
 *  2. 安全：上游 API Key 只留在这台机器上，不必存进浏览器扩展。
 *
 * 用法：
 *   node tools/server/relay.mjs
 *   然后扩展设置里选“本地中继”，地址保持 http://127.0.0.1:8787/v1
 *
 * 配置（环境变量）：
 *   ZIMU_UPSTREAM   上游 baseUrl，例如 https://api.siliconflow.cn/v1
 *                   默认从 tools/server/relay.config.json 读
 *   ZIMU_API_KEY    上游 API Key
 *   ZIMU_MODEL      默认模型名
 *   ZIMU_PORT       监听端口，默认 8787
 *
 * 也支持把上游设成中转站（如 one-api / new-api），只要是 OpenAI 兼容协议即可。
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadFileConfig() {
  const file = path.join(here, 'relay.config.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[中继] relay.config.json 解析失败，已忽略：${err.message}`);
    return {};
  }
}

const fileConfig = loadFileConfig();
const config = {
  port: Number(process.env.ZIMU_PORT || fileConfig.port || 8787),
  upstream: (process.env.ZIMU_UPSTREAM || fileConfig.upstream || '').replace(/\/+$/, ''),
  apiKey: process.env.ZIMU_API_KEY || fileConfig.apiKey || '',
  model: process.env.ZIMU_MODEL || fileConfig.model || '',
  /** 允许哪些来源调用；扩展请求带 Origin: chrome-extension://... */
  allowOrigin: process.env.ZIMU_ALLOW_ORIGIN || fileConfig.allowOrigin || '*',
  /** 是否把识别文本打到日志里（默认只打长度，避免日志泄露课程内容） */
  logText: process.env.ZIMU_LOG_TEXT === '1' || fileConfig.logText === true,
  timeoutMs: Number(process.env.ZIMU_TIMEOUT_MS || fileConfig.timeoutMs || 120000)
};

const MAX_BODY_BYTES = 60 * 1024 * 1024; // 60MB，够 1 小时单声道 Opus

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': config.allowOrigin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders()
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB 上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 解析 multipart/form-data —— 只用于日志摘要和排查问题。
 * 转发本身不解析表单：直接把原始字节送给上游，最不容易出错。
 */
function summarizeMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) return null;
  const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]).trim();
  const text = buffer.toString('latin1');
  const parts = text.split(boundary).filter((p) => p.includes('name='));
  const summary = {};
  for (const part of parts) {
    const nameMatch = /name="([^"]+)"/.exec(part);
    if (!nameMatch) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    const value = headerEnd >= 0 ? part.slice(headerEnd + 4).replace(/\r\n$/, '') : '';
    summary[nameMatch[1]] = nameMatch[1] === 'file' ? `<${value.length} bytes>` : value.trim();
  }
  return summary;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (url.pathname === '/health' || url.pathname === '/') {
    sendJson(res, 200, {
      ok: true,
      service: 'zimu-relay',
      upstreamConfigured: Boolean(config.upstream),
      upstream: config.upstream || null,
      model: config.model || null,
      hasApiKey: Boolean(config.apiKey)
    });
    return;
  }

  if (!url.pathname.endsWith('/audio/transcriptions')) {
    sendJson(res, 404, {
      ok: false,
      error: `未知路径 ${url.pathname}。扩展应把 baseUrl 指向 http://127.0.0.1:${config.port}/v1`
    });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只支持 POST' });
    return;
  }

  if (!config.upstream) {
    sendJson(res, 500, {
      ok: false,
      error:
        '还没有配置上游服务。请创建 tools/server/relay.config.json，' +
        '写入 {"upstream":"https://api.siliconflow.cn/v1","apiKey":"sk-xxx","model":"FunAudioLLM/SenseVoiceSmall"}，' +
        '或用环境变量 ZIMU_UPSTREAM / ZIMU_API_KEY / ZIMU_MODEL 启动。'
    });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { ok: false, error: err.message });
    return;
  }

  const incomingContentType = req.headers['content-type'] || '';
  if (config.logText) {
    const summary = summarizeMultipart(body, incomingContentType);
    console.log(`[中继] 收到请求 ${JSON.stringify(summary)}`);
  }

  // 上游鉴权：优先用扩展传来的 Key，没传就用本机配置的
  const clientAuth = req.headers['authorization'];
  const authHeader = clientAuth && clientAuth !== 'Bearer ' ? clientAuth : config.apiKey ? `Bearer ${config.apiKey}` : '';

  const upstreamUrl = `${config.upstream}/audio/transcriptions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': incomingContentType || 'application/octet-stream',
        ...(authHeader ? { Authorization: authHeader } : {})
      },
      body,
      signal: controller.signal
    });

    const text = await upstreamRes.text();
    const elapsed = Date.now() - started;

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parsed = null;
    }

    const recognized = parsed
      ? parsed.text ||
        (Array.isArray(parsed.segments) ? parsed.segments.map((s) => s.text).join(' ') : '') ||
        (parsed.error && parsed.error.message) ||
        ''
      : text.slice(0, 200);

    console.log(
      `[中继] ${upstreamRes.status} ${elapsed}ms 音频 ${(body.length / 1024).toFixed(0)}KB ` +
        `→ ${config.logText ? JSON.stringify(recognized) : (parsed && parsed.text ? parsed.text.length + ' 字' : '(无文本)')}`
    );

    res.writeHead(upstreamRes.status, {
      'Content-Type': upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8',
      ...corsHeaders()
    });
    res.end(text);
  } catch (err) {
    const elapsed = Date.now() - started;
    const aborted = err && err.name === 'AbortError';
    console.error(`[中继] 失败 ${elapsed}ms：${err && err.message}`);
    sendJson(res, aborted ? 504 : 502, {
      ok: false,
      error: aborted
        ? `上游 ${config.upstream} 超过 ${config.timeoutMs}ms 未响应`
        : `连不上上游 ${upstreamUrl}：${(err && err.message) || err}`
    });
  } finally {
    clearTimeout(timer);
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log('字幕助手中继服务已启动');
  console.log(`  监听地址：http://127.0.0.1:${config.port}/v1`);
  console.log(`  健康检查：http://127.0.0.1:${config.port}/health`);
  console.log(`  上游服务：${config.upstream || '（未配置，请编辑 tools/server/relay.config.json）'}`);
  console.log(`  默认模型：${config.model || '（用扩展里填的）'}`);
  console.log(`  API Key：${config.apiKey ? '已从本机配置读取' : '未配置（将使用扩展里填的 Key）'}`);
  console.log('按 Ctrl+C 停止。');
});

process.on('SIGINT', () => {
  console.log('\n已停止中继服务。');
  server.close(() => process.exit(0));
});
