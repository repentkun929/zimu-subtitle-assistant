/**
 * 识别服务客户端的测试。
 *
 * 重点不是"能不能发请求"，而是**错误提示是否好用**——
 * 用户拿自己已有的 API Key 填进来试，是这个插件最可能的第一次失败场景。
 * 如果这时只回一个 400/404，用户会以为是自己 Key 或地址写错了，反复折腾。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectTextOnlyProvider,
  transcribeBlob,
  makeSilentWav,
  TranscriptionError
} from '../src/common/asr-client.js';

test('能识别出只有文本模型、没有语音接口的服务商', () => {
  const deepseek = detectTextOnlyProvider('https://api.deepseek.com/v1');
  assert.ok(deepseek, '应识别出 DeepSeek');
  assert.equal(deepseek.name, 'DeepSeek');

  assert.ok(detectTextOnlyProvider('https://api.deepseek.com'), '不带 /v1 也要能识别');
  assert.ok(detectTextOnlyProvider('https://api.moonshot.cn/v1'));
  assert.ok(detectTextOnlyProvider('https://open.bigmodel.cn/api/paas/v4'));
});

test('真正的语音识别服务不会被误判', () => {
  for (const url of [
    'https://api.siliconflow.cn/v1',
    'https://api.openai.com/v1',
    'http://127.0.0.1:8787/v1',
    'https://gw.example.com/tenant-a/v1'
  ]) {
    assert.equal(detectTextOnlyProvider(url), null, `${url} 不该被判为纯文本服务商`);
  }
});

test('填了 DeepSeek 时给出可操作的中文错误', async () => {
  const blob = new Blob([new Uint8Array(16)], { type: 'audio/webm' });
  await assert.rejects(
    () => transcribeBlob(blob, { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }),
    (err) => {
      assert.ok(err instanceof TranscriptionError);
      assert.match(err.message, /DeepSeek/, '应点名 DeepSeek');
      assert.match(err.message, /没有音频转录接口/, '应说明原因');
      assert.match(err.message, /api\.siliconflow\.cn/, '应给出可用的替代地址');
      return true;
    }
  );
});

test('没填地址时提示去设置里配置', async () => {
  const blob = new Blob([new Uint8Array(16)], { type: 'audio/webm' });
  await assert.rejects(
    () => transcribeBlob(blob, { baseUrl: '' }),
    /还没有配置识别服务地址/
  );
});

test('空音频块不会被当成“识别失败”（避免误导用户去查 Key）', async () => {
  /* 真实踩过的坑：用户点了开启字幕后才播放视频，第一块录在暂停期间、内容为空。
   * 若报成“识别失败：音频数据无效或为空”，用户会去反复检查 API Key 和
   * 服务配置——方向完全错了。这里锁住“不发请求、也不说成失败”这个行为。 */
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  };
  try {
    await assert.rejects(
      () => transcribeBlob(new Blob([]), { baseUrl: 'https://api.siliconflow.cn/v1' }),
      (err) => {
        assert.ok(err instanceof TranscriptionError);
        assert.match(err.message, /没有采集到音频/, '应说明是没采到音频');
        assert.match(err.message, /播放/, '应提示先把视频播放起来');
        assert.doesNotMatch(err.message, /识别失败/, '不能说成识别失败');
        return true;
      }
    );
    assert.equal(fetchCalled, false, '空音频块不该发出请求');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('正常服务商会把请求发到 /audio/transcriptions', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ text: '识别出来的文字' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const blob = new Blob([new Uint8Array(32)], { type: 'audio/webm;codecs=opus' });
    const result = await transcribeBlob(blob, {
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'FunAudioLLM/SenseVoiceSmall',
      language: 'zh',
      apiKey: 'sk-test'
    });

    assert.equal(result.text, '识别出来的文字');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.siliconflow.cn/v1/audio/transcriptions');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
    // 刻意不传 response_format：部分国内服务只支持默认 json，传了会 400
    assert.equal(calls[0].init.body.get('response_format'), null);
    assert.equal(calls[0].init.body.get('model'), 'FunAudioLLM/SenseVoiceSmall');
    assert.equal(calls[0].init.body.get('language'), 'zh');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('地址已经带 /audio/transcriptions 时不重复拼接', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  globalThis.fetch = async (url) => {
    seenUrl = url;
    return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
  };
  try {
    await transcribeBlob(new Blob([new Uint8Array(8)]), {
      baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
      model: 'whisper-1'
    });
    assert.equal(seenUrl, 'https://api.openai.com/v1/audio/transcriptions');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('上游报错时翻译成看得懂的中文并标注可否重试', async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    { status: 401, body: { error: { message: 'Invalid API key' } }, expect: /API Key 无效/, retryable: false },
    { status: 429, body: { error: { message: 'rate limited' } }, expect: /限流/, retryable: true },
    { status: 413, body: { error: { message: 'too large' } }, expect: /音频块太大/, retryable: false }
  ];

  try {
    for (const item of cases) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify(item.body), { status: item.status });
      await assert.rejects(
        () => transcribeBlob(new Blob([new Uint8Array(8)]), { baseUrl: 'https://api.openai.com/v1' }),
        (err) => {
          assert.match(err.message, item.expect);
          assert.equal(err.status, item.status);
          assert.equal(err.retryable, item.retryable);
          return true;
        }
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('连不上时给出可操作的建议', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  try {
    await assert.rejects(
      () => transcribeBlob(new Blob([new Uint8Array(8)]), { baseUrl: 'https://api.openai.com/v1' }),
      (err) => {
        assert.match(err.message, /连不上识别服务/);
        assert.match(err.message, /127\.0\.0\.1:8787/, '应提示可以改用本地中继');
        assert.equal(err.retryable, true);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('探测用的静音 WAV 是合法的 16kHz 单声道文件', async () => {
  const blob = makeSilentWav(0.5);
  assert.equal(blob.type, 'audio/wav');
  const view = new DataView(await blob.arrayBuffer());
  const ascii = (offset, len) =>
    String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(offset + i)));
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(view.getUint16(22, true), 1, '应为单声道');
  assert.equal(view.getUint32(24, true), 16000, '采样率应为 16000');
  assert.equal(view.getUint16(34, true), 16, '位深应为 16');
  assert.equal(blob.size, 44 + Math.floor(16000 * 0.5) * 2);
});

test('服务端返回各种字段形态都能取出文本', async () => {
  const originalFetch = globalThis.fetch;
  const shapes = [
    [{ text: '纯文本字段' }, '纯文本字段'],
    [{ segments: [{ text: '第一段' }, { text: '第二段' }] }, '第一段 第二段'],
    [{ data: { text: '嵌套在 data 里' } }, '嵌套在 data 里'],
    [{ results: [{ text: '结果一' }, { text: '结果二' }] }, '结果一 结果二']
  ];
  try {
    for (const [payload, expected] of shapes) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
      const result = await transcribeBlob(new Blob([new Uint8Array(8)]), {
        baseUrl: 'https://example.com/v1'
      });
      assert.equal(result.text, expected, `解析失败：${JSON.stringify(payload)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
