/**
 * 识别协议与供应商预设的测试。
 *
 * 背景：阿里云百炼的 qwen3-asr-flash **没有** /audio/transcriptions 这个口子，
 * 它的音频要从 /chat/completions 的 messages 里进去；而硅基流动、OpenAI、
 * 绝大多数兼容层走的是 multipart 上传。
 *
 * 这两条路的差别是“选错了就稳定失败”，而且失败得很安静（一个 400/404），
 * 用户很难自己看出是协议错了还是模型名错了。所以这里把三件事钉死：
 *  1. 协议 → 端点的映射；
 *  2. 两条路各自的请求形状；
 *  3. 两种响应形状都能取出文字（chat 的文字藏在 choices[0].message.content）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSettings, PROVIDERS, resolveEndpointUrl } from '../src/common/settings.js';
import { transcribeBlob } from '../src/common/asr-client.js';

test('调用协议决定请求端点，且已带端点时不重复拼接', () => {
  assert.equal(
    resolveEndpointUrl('https://api.siliconflow.cn/v1', 'transcriptions'),
    'https://api.siliconflow.cn/v1/audio/transcriptions'
  );
  assert.equal(
    resolveEndpointUrl('https://dashscope.aliyuncs.com/compatible-mode/v1', 'chat'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  );
  // 用户把端点整条粘进来也要能用
  assert.equal(
    resolveEndpointUrl('https://api.openai.com/v1/audio/transcriptions', 'transcriptions'),
    'https://api.openai.com/v1/audio/transcriptions'
  );
  assert.equal(
    resolveEndpointUrl('https://x.example.com/v1/chat/completions', 'chat'),
    'https://x.example.com/v1/chat/completions'
  );
  // 结尾多一个斜杠不该拼出双斜杠
  assert.equal(
    resolveEndpointUrl('https://api.siliconflow.cn/v1/', 'transcriptions'),
    'https://api.siliconflow.cn/v1/audio/transcriptions'
  );
  assert.equal(resolveEndpointUrl('', 'chat'), '');
});

test('apiStyle 只接受两个预设值，非法值退回默认', () => {
  assert.equal(normalizeSettings({}).apiStyle, 'transcriptions', '默认走最通用的上传协议');
  assert.equal(normalizeSettings({ apiStyle: 'chat' }).apiStyle, 'chat');
  assert.equal(normalizeSettings({ apiStyle: 'chatty' }).apiStyle, 'transcriptions');
  assert.equal(normalizeSettings({ apiStyle: null }).apiStyle, 'transcriptions');
  assert.equal(normalizeSettings({ apiStyle: '' }).apiStyle, 'transcriptions');
});

test('每个预设都要带齐地址/模型/协议，不能有半成品', () => {
  for (const [key, preset] of Object.entries(PROVIDERS)) {
    if (key === 'custom') continue; // 自定义本来就是留给用户填的
    assert.ok(preset.label, `${key} 缺 label`);
    assert.ok(preset.baseUrl, `${key} 缺 baseUrl`);
    assert.ok(preset.model, `${key} 缺 model`);
    assert.ok(preset.note, `${key} 缺 note`);
    assert.ok(
      ['transcriptions', 'chat'].includes(preset.apiStyle),
      `${key} 的 apiStyle 不合法：${preset.apiStyle}`
    );
  }
});

test('百炼那两个预设必须是 chat 协议，且地址精确到 compatible-mode/v1', () => {
  /* 这是最容易配错的一处：百炼的地址不是 api.openai.com 那种形状，
   * 端点也不是 /audio/transcriptions。写错的话表现是一个干净的 404，
   * 用户只会以为网络不通。 */
  for (const key of ['bailianQwenAsr', 'bailianFunAsr']) {
    assert.equal(PROVIDERS[key].apiStyle, 'chat', `${key} 必须走 chat 协议`);
    assert.match(
      PROVIDERS[key].baseUrl,
      /^https:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1$/,
      `${key} 的地址不对`
    );
  }
});

test('apiStyle=chat 时请求发到 /chat/completions，音频以 data URI 放进 messages', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: '这是识别结果' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6])], { type: 'audio/wav' });
    const result = await transcribeBlob(blob, {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-asr-flash',
      apiStyle: 'chat',
      language: 'zh',
      apiKey: 'sk-dash'
    });

    assert.equal(result.text, '这是识别结果', '要能从 choices[0].message.content 取到文字');
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    );
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-dash');

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'qwen3-asr-flash');
    assert.equal(body.stream, false, '逐块识别不需要流式，关掉省事');
    assert.equal(body.asr_options.language, 'zh');

    const part = body.messages[0].content[0];
    assert.equal(part.type, 'input_audio');
    assert.match(part.input_audio.data, /^data:audio\/wav;base64,/, '音频要拼成 data URI');
    assert.equal(part.input_audio.data.split(',')[1], 'AQIDBAUG', 'base64 内容要正确');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat 协议下 content 是数组时也能取到文字', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: [{ type: 'text', text: '分段' }, { type: 'text', text: '结果' }] } }]
      }),
      { status: 200 }
    );
  try {
    const result = await transcribeBlob(new Blob([new Uint8Array(4)]), {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-asr-flash',
      apiStyle: 'chat'
    });
    assert.equal(result.text, '分段结果');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat 协议下语言留空时不发 asr_options（让服务自己判断）', async () => {
  const originalFetch = globalThis.fetch;
  let seenBody = '';
  globalThis.fetch = async (url, init) => {
    seenBody = init.body;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  try {
    await transcribeBlob(new Blob([new Uint8Array(4)]), {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-asr-flash',
      apiStyle: 'chat',
      language: ''
    });
    assert.equal('asr_options' in JSON.parse(seenBody), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('两种协议下空音频块都不发请求', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  };
  try {
    for (const apiStyle of ['transcriptions', 'chat']) {
      await assert.rejects(
        () =>
          transcribeBlob(new Blob([]), {
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            apiStyle
          }),
        /没有采集到音频/
      );
    }
    assert.equal(fetchCalled, false, '空音频块不该发出任何请求');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('400 报错里带上实际请求地址，方便用户自己对照', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 400 });
  try {
    await assert.rejects(
      () =>
        transcribeBlob(new Blob([new Uint8Array(8)]), {
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen3-asr-flash',
          apiStyle: 'chat'
        }),
      (err) => {
        assert.match(err.message, /chat\/completions/, '要点出实际发去的端点');
        assert.match(err.message, /model not found/, '要带上上游的原始说明');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
