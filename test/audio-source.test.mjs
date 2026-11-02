/**
 * 音频来源选择的测试。
 *
 * 存在的理由：用户平台上的播放器（MSE/blob 自绘）用 video.captureStream()
 * 拿不到可编码的音频数据，必须能退回“抓取整个标签页声音”。
 * 这条降级逻辑一旦判断错，用户就会遇到“点了开启字幕但什么都没发生”。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');

/** 造一个假的 MediaStream。 */
function makeStream(label = 'fake') {
  const track = { label, kind: 'audio', stop() {} };
  return {
    id: label,
    getAudioTracks: () => [track],
    getTracks: () => [track],
    addEventListener: () => {}
  };
}

/**
 * 造一个同时含视频轨和音频轨的流，模拟 video.captureStream() 的真实返回。
 * 这是复现核心 bug 的关键：早期版本把这种流整个交给 MediaRecorder，
 * 结果把画面一起录了进去。
 */
function makeVideoAudioStream() {
  const audioTrack = { label: 'audio', kind: 'audio', stop() {} };
  const videoTrack = { label: 'video', kind: 'video', stop() {} };
  return {
    id: 'video+audio',
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => [videoTrack],
    getTracks: () => [audioTrack, videoTrack],
    addEventListener: () => {}
  };
}

async function loadAudioSource({ media, tabStream, tabError, getUserMedia } = {}) {
  const code = await readFile(path.join(distDir, 'content', 'audio-source.js'), 'utf8');
  const sandbox = {
    console,
    // 重试逻辑里用到了等待（等 Chrome 释放上一次抓取）
    setTimeout,
    clearTimeout,
    navigator: {
      mediaDevices: {
        getUserMedia:
          getUserMedia ||
          (async () => {
            if (tabError) throw tabError;
            return tabStream || makeStream('tab');
          })
      }
    },
    window: { isSecureContext: true },
    location: { href: 'https://example.com/lesson' },
    URL,
    Error,
    // 该修复会新建只含音频轨的 MediaStream
    MediaStream: class {
      constructor(tracks) {
        this.tracks = tracks;
      }
      getAudioTracks() {
        return this.tracks.filter((t) => t.kind === 'audio');
      }
      getVideoTracks() {
        return this.tracks.filter((t) => t.kind === 'video');
      }
      getTracks() {
        return this.tracks.slice();
      }
      addEventListener() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(code, { filename: 'audio-source.js' }).runInContext(sandbox);

  const sent = [];
  const sendToBackground = async (message) => {
    sent.push(message);
    if (message.type === 'zimu:acquire-tab-stream') {
      if (tabError && !getUserMedia) return { ok: true, streamId: 'stream-1' };
      return { ok: true, streamId: 'stream-1' };
    }
    return { ok: true };
  };

  return { NS: sandbox.__ZIMU__, sent, sendToBackground };
}

test('element 模式：直接用视频元素的流', async () => {
  const elementStream = makeStream('element');
  const { NS, sent, sendToBackground } = await loadAudioSource();
  const media = { captureStream: () => elementStream };

  const result = await NS.acquireStream(media, {
    captureMode: 'element',
    sendToBackground,
    log: () => {}
  });
  assert.equal(result.mode, 'element');
  assert.equal(result.stream, elementStream);
  assert.equal(sent.length, 0, 'element 模式不该去申请标签页音频');
});

test('必须丢弃视频轨：否则会把画面一起录进去', async () => {
  /* 这是本项目最严重的 bug，务必长期锁住：
   *
   * video.captureStream() 不带参数时返回的流**同时含视频轨和音频轨**。
   * 早期版本把它整个交给 MediaRecorder，于是画面也被录了下来——
   * 12 秒的块从应有的约 96KB 膨胀到 1.4~3.4MB。
   * 后果不只是浪费流量：语音识别服务拿到带视频轨的 WebM 解不出音轨，
   * **返回空文本**，用户看到的现象正是“采集正常、上传成功、但始终没有字幕”。
   */
  const { NS, sendToBackground } = await loadAudioSource();
  const media = { captureStream: () => makeVideoAudioStream() };

  const result = await NS.acquireStream(media, {
    captureMode: 'element',
    sendToBackground,
    log: () => {}
  });

  assert.equal(result.mode, 'element');
  assert.equal(
    result.stream.getVideoTracks().length,
    0,
    '交给录音器的流里绝不能有视频轨'
  );
  assert.equal(result.stream.getAudioTracks().length, 1, '音频轨要保留');
});

test('纯音频流不额外包装（保持原对象，避免多余副作用）', async () => {
  const audioOnly = makeStream('audio-only');
  audioOnly.getVideoTracks = () => [];
  const { NS, sendToBackground } = await loadAudioSource();

  const result = await NS.acquireStream({ captureStream: () => audioOnly }, {
    captureMode: 'element',
    sendToBackground,
    log: () => {}
  });
  assert.equal(result.stream, audioOnly, '本来就没有视频轨时不该重新包装');
});

test('auto 模式：元素可用时不申请标签页音频', async () => {
  const elementStream = makeStream('element');
  const { NS, sent, sendToBackground } = await loadAudioSource();
  const media = { captureStream: () => elementStream };

  const result = await NS.acquireStream(media, {
    captureMode: 'auto',
    sendToBackground,
    log: () => {}
  });
  assert.equal(result.mode, 'element');
  assert.equal(sent.length, 0, 'auto 模式在元素可用时不该多此一举');
});

test('auto 模式：元素流没有音轨时自动改用标签页', async () => {
  const { NS, sent, sendToBackground } = await loadAudioSource();
  const emptyStream = { getAudioTracks: () => [], getTracks: () => [], addEventListener: () => {} };
  const media = { captureStream: () => emptyStream };

  const result = await NS.acquireStream(media, {
    captureMode: 'auto',
    sendToBackground,
    log: () => {}
  });
  assert.equal(result.mode, 'tab', '应降级到标签页模式');
  assert.ok(sent.some((m) => m.type === 'zimu:acquire-tab-stream'), '应向 background 申请 streamId');
  assert.match(result.note, /标签页/);
});

test('auto 模式：captureStream 抛异常时也降级', async () => {
  const { NS, sendToBackground } = await loadAudioSource();
  const media = {
    captureStream: () => {
      const err = new Error('The element does not have any audio');
      err.name = 'NotSupportedError';
      throw err;
    }
  };

  const result = await NS.acquireStream(media, {
    captureMode: 'auto',
    sendToBackground,
    log: () => {}
  });
  assert.equal(result.mode, 'tab');
});

test('element 模式：读不到就报错，不偷偷降级', async () => {
  const { NS, sendToBackground } = await loadAudioSource();
  const media = { captureStream: () => ({ getAudioTracks: () => [] }) };

  await assert.rejects(
    () =>
      NS.acquireStream(media, {
        captureMode: 'element',
        sendToBackground,
        log: () => {}
      }),
    (err) => {
      assert.equal(err.name, 'AudioSourceError');
      assert.match(err.message, /没有音轨/);
      return true;
    }
  );
});

test('tab 模式：直接申请标签页音频，不看视频元素', async () => {
  const { NS, sent, sendToBackground } = await loadAudioSource();
  const media = { captureStream: () => makeStream('element') };

  const result = await NS.acquireStream(media, {
    captureMode: 'tab',
    sendToBackground,
    log: () => {}
  });
  assert.equal(result.mode, 'tab');
  assert.equal(sent.length, 1, 'tab 模式应只申请一次 streamId');
});

test('getUserMedia 用的必须是扩展专用的 chromeMediaSource 约束', async () => {
  let capturedConstraints = null;
  const { NS, sendToBackground } = await loadAudioSource({
    getUserMedia: async (constraints) => {
      capturedConstraints = constraints;
      return makeStream('tab');
    }
  });

  await NS.acquireStream({ captureStream: () => ({ getAudioTracks: () => [] }) }, {
    captureMode: 'tab',
    sendToBackground,
    log: () => {}
  });

  assert.ok(capturedConstraints, '应调用 getUserMedia');
  assert.equal(capturedConstraints.video, false, '只要音频，不要视频');
  assert.equal(capturedConstraints.audio.mandatory.chromeMediaSource, 'tab');
  assert.equal(capturedConstraints.audio.mandatory.chromeMediaSourceId, 'stream-1');
});

test('“上一次抓取还没释放”时自动等待并重试一次', async () => {
  /* 这是用户实测撞到的错误：Cannot capture a tab with an active stream。
   * 它是时序问题（上一次抓取还没完全释放），等一会儿重试通常就能成功，
   * 直接报错给用户是很差的体验。 */
  let calls = 0;
  const releases = [];
  const { NS, sendToBackground } = await (async () => {
    const base = await loadAudioSource();
    return {
      NS: base.NS,
      sendToBackground: async (message) => {
        calls++;
        if (calls === 1) {
          return { ok: false, error: "Failed to execute 'getMediaStreamId': Cannot capture a tab with an active stream." };
        }
        return { ok: true, streamId: 'stream-after-retry' };
      }
    };
  })();

  const stream = await NS.acquireTabStream(sendToBackground, {
    releasePrevious: async () => releases.push('released'),
    log: () => {}
  });

  assert.ok(stream, '重试成功后应返回音频流');
  assert.equal(calls, 2, '应重试一次');
  assert.ok(releases.length >= 2, '重试前后都应尝试释放上一次抓取');
});

test('申请前会先释放上一次的抓取', async () => {
  const order = [];
  const { NS } = await loadAudioSource();
  const sendToBackground = async () => {
    order.push('request');
    return { ok: true, streamId: 's1' };
  };

  await NS.acquireTabStream(sendToBackground, {
    releasePrevious: async () => order.push('release'),
    log: () => {}
  });

  assert.deepEqual(order, ['release', 'request'], '必须先释放再申请，否则 Chrome 会拒绝');
});

test('background 没给 streamId 时给出可读的错误', async () => {
  const { NS } = await loadAudioSource();
  await assert.rejects(
    () =>
      NS.acquireStream({ captureStream: () => ({ getAudioTracks: () => [] }) }, {
        captureMode: 'tab',
        sendToBackground: async () => ({ ok: false, error: '标签页没有在播放声音' }),
        log: () => {}
      }),
    (err) => {
      assert.equal(err.name, 'AudioSourceError');
      assert.match(err.message, /标签页没有在播放声音/);
      return true;
    }
  );
});

test('getUserMedia 被拒时代入原始错误名，便于定位', async () => {
  const denied = new Error('Permission denied');
  denied.name = 'NotAllowedError';
  const { NS, sendToBackground } = await loadAudioSource({
    getUserMedia: async () => {
      throw denied;
    }
  });

  await assert.rejects(
    () =>
      NS.acquireStream({ captureStream: () => ({ getAudioTracks: () => [] }) }, {
        captureMode: 'tab',
        sendToBackground,
        log: () => {}
      }),
    (err) => {
      assert.equal(err.name, 'AudioSourceError');
      assert.match(err.message, /被拒绝/);
      assert.equal(err.detail, 'NotAllowedError');
      return true;
    }
  );
});
