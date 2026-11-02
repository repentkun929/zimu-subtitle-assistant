/**
 * 中继服务的端到端测试：
 *   node --test "test/**\/*.test.mjs"
 *
 * 做法是起两个真实进程——一个假上游（模拟 OpenAI 兼容的 /audio/transcriptions），
 * 一个真正的中继服务——然后发真实 HTTP 请求。
 * 这样验证的是真链路，不是 mock 出来的行为。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const relayPath = path.join(here, '..', 'tools', 'server', 'relay.mjs');

/** 启动一个假的 OpenAI 兼容上游，记录收到的请求。 */
function startFakeUpstream({ status = 200, body = { text: '这是识别结果' } } = {}) {
  const received = { auth: null, bytes: 0, contentType: '', count: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.count++;
      received.auth = req.headers.authorization || null;
      received.contentType = req.headers['content-type'] || '';
      received.bytes = Buffer.concat(chunks).length;
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, received, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/** 启动中继服务，等它打印出监听信息。 */
function startRelay(env) {
  const child = spawn(process.execPath, [relayPath], {
    // 注意：必须继承 process.env，否则连 Node 自己都找不到运行时环境；
    // 要覆盖的变量放在后面即可。
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = { text: '' };
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`中继启动超时，输出：${output.text}`)), 8000);
    child.stdout.on('data', (d) => {
      output.text += d.toString();
      if (output.text.includes('监听地址')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (d) => (output.text += d.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`中继提前退出，code=${code}，输出：${output.text}`));
    });
  });
  return { child, ready, output };
}

function stopProcess(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 2000);
  });
}


/**
 * 取一个当前空闲的端口。
 *
 * 这里不能写死端口：中继测试是唯一一个起真实进程的用例，
 * 而写死的端口一旦被机器上别的常驻服务占着（实测 18787 被本机
 * 另一个 Node 服务监听），整套测试就会红成“中继挂了”，
 * 让人去查一个根本不存在的中继缺陷。
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** 用真实 multipart 表单发一块假音频。 */
async function postChunk(port, { auth, bytes = 2048 } = {}) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/webm' }), 'chunk.webm');
  form.append('model', 'test-model');
  const response = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: auth ? { Authorization: auth } : {},
    body: form
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

test('中继服务：转发音频并回传识别文本', async (t) => {
  const upstream = await startFakeUpstream({ body: { text: '同学们好，今天讲二叉树' } });
  const port = await freePort();
  const relay = startRelay({
    ZIMU_PORT: String(port),
    ZIMU_UPSTREAM: upstream.origin,
    ZIMU_API_KEY: 'sk-upstream-key',
    ZIMU_MODEL: 'test-model'
  });

  t.after(async () => {
    await stopProcess(relay.child);
    await new Promise((r) => upstream.server.close(r));
  });

  await relay.ready;

  const result = await postChunk(port, { bytes: 4096 });
  assert.equal(result.status, 200, `中继应返回 200，实际 ${result.status}`);
  assert.equal(result.json.text, '同学们好，今天讲二叉树');

  assert.equal(upstream.received.count, 1, '上游应恰好收到一次请求');
  assert.equal(upstream.received.auth, 'Bearer sk-upstream-key', '应带上本机配置的上游 Key');
  assert.match(upstream.received.contentType, /multipart\/form-data/, '应保持 multipart 内容类型');
  assert.ok(upstream.received.bytes > 4096, `音频字节应被完整转发，实际 ${upstream.received.bytes}`);
});

test('中继服务：扩展自带的 Key 优先于本机配置', async (t) => {
  const upstream = await startFakeUpstream();
  const port = await freePort();
  const relay = startRelay({
    ZIMU_PORT: String(port),
    ZIMU_UPSTREAM: upstream.origin,
    ZIMU_API_KEY: 'sk-local'
  });

  t.after(async () => {
    await stopProcess(relay.child);
    await new Promise((r) => upstream.server.close(r));
  });
  await relay.ready;

  await postChunk(port, { auth: 'Bearer sk-from-extension' });
  assert.equal(upstream.received.auth, 'Bearer sk-from-extension');
});

test('中继服务：上游报错时状态码原样透传', async (t) => {
  const upstream = await startFakeUpstream({
    status: 401,
    body: { error: { message: 'Invalid API key' } }
  });
  const port = await freePort();
  const relay = startRelay({
    ZIMU_PORT: String(port),
    ZIMU_UPSTREAM: upstream.origin,
    ZIMU_API_KEY: 'sk-bad'
  });

  t.after(async () => {
    await stopProcess(relay.child);
    await new Promise((r) => upstream.server.close(r));
  });
  await relay.ready;

  const result = await postChunk(port);
  assert.equal(result.status, 401, '鉴权失败必须让扩展看得见');
  assert.equal(result.json.error.message, 'Invalid API key');
});

test('中继服务：没配上游时给出可操作的错误提示', async (t) => {
  const port = await freePort();
  // 用环境变量显式置空，模拟“用户还没配置”的初始状态。
  // 注意不能靠切换工作目录来隔离：配置路径是相对脚本自身解析的。
  const relay = startRelay({ ZIMU_PORT: String(port), ZIMU_UPSTREAM: '', ZIMU_API_KEY: '', ZIMU_MODEL: '' });

  t.after(async () => {
    await stopProcess(relay.child);
  });

  await relay.ready;

  const result = await postChunk(port);
  assert.equal(result.status, 500);
  assert.match(result.json.error, /relay\.config\.json/, '错误信息应告诉用户怎么配置');
});

test('中继服务：/health 汇报配置状态', async (t) => {
  const upstream = await startFakeUpstream();
  const port = await freePort();
  const relay = startRelay({
    ZIMU_PORT: String(port),
    ZIMU_UPSTREAM: upstream.origin,
    ZIMU_API_KEY: 'sk-x',
    ZIMU_MODEL: 'm1'
  });

  t.after(async () => {
    await stopProcess(relay.child);
    await new Promise((r) => upstream.server.close(r));
  });
  await relay.ready;

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.upstreamConfigured, true);
  assert.equal(json.model, 'm1');
  assert.equal(json.hasApiKey, true);
  // 健康检查绝不能把 Key 本身泄露出去
  assert.ok(!JSON.stringify(json).includes('sk-x'), '不应回显 API Key');
});

test('中继服务：未知路径返回 404 且提示正确写法', async (t) => {
  const upstream = await startFakeUpstream();
  const port = await freePort();
  const relay = startRelay({ ZIMU_PORT: String(port), ZIMU_UPSTREAM: upstream.origin });

  t.after(async () => {
    await stopProcess(relay.child);
    await new Promise((r) => upstream.server.close(r));
  });
  await relay.ready;

  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST' });
  assert.equal(response.status, 404);
  const json = await response.json();
  assert.match(json.error, new RegExp(`127\.0\.0\.1:${port}\/v1`));
});
