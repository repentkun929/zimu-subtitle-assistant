/**
 * WAV 编码的测试。
 *
 * 为什么这块特别需要测试：本地 Whisper 服务通常没有 ffmpeg，只能解 WAV。
 * 如果 WAV 头里的某个字段写错（采样率、位深、块对齐、数据长度），
 * 服务端会报“读不出音频”或识别出乱码，而现象和“音频本身有问题”很难区分。
 * 所以这里逐字段核对头部，并做一次真正的往返解析。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', 'dist');

/** 加载 dist 里的 wav-encoder.js（普通脚本，挂在 __ZIMU__ 上）。 */
async function loadEncoder() {
  const code = await readFile(path.join(distDir, 'content', 'wav-encoder.js'), 'utf8');
  const sandbox = { console, Uint8Array, Float32Array, ArrayBuffer, DataView, Math, Blob };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(code, { filename: 'content/wav-encoder.js' }).runInContext(sandbox);
  return sandbox.__ZIMU__;
}

/** 用 DataView 读 WAV 头，返回各字段，模拟服务端解析。 */
function parseWavHeader(buffer) {
  const view = new DataView(buffer);
  const ascii = (offset, len) =>
    String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(offset + i)));

  return {
    riff: ascii(0, 4),
    riffSize: view.getUint32(4, true),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    fmtSize: view.getUint32(16, true),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: view.getUint32(40, true),
    totalSize: buffer.byteLength
  };
}

test('WAV 头部字段全部正确（服务端能否读出音频全靠它）', async () => {
  const NS = await loadEncoder();
  const samples = new Float32Array(16000); // 1 秒 16kHz
  const buffer = NS.encodeWav(samples, 16000);
  const h = parseWavHeader(buffer);

  assert.equal(h.riff, 'RIFF');
  assert.equal(h.wave, 'WAVE');
  assert.equal(h.fmt, 'fmt ');
  assert.equal(h.data, 'data');

  // 这三个字段错一个，服务端就读不出正确内容
  assert.equal(h.audioFormat, 1, '必须是 1（PCM 无压缩）');
  assert.equal(h.channels, 1, '必须是单声道');
  assert.equal(h.sampleRate, 16000, '必须是 16kHz（Whisper 就是这么训练的）');
  assert.equal(h.bitsPerSample, 16, '必须是 16bit');

  // 派生字段
  assert.equal(h.byteRate, 16000 * 1 * 2, '字节率 = 采样率 × 声道 × 位深/8');
  assert.equal(h.blockAlign, 1 * 2, '块对齐 = 声道 × 位深/8');
  assert.equal(h.dataSize, 16000 * 2, '数据长度 = 采样数 × 2');
  assert.equal(h.totalSize, 44 + 16000 * 2, '总长度 = 44 字节头 + 数据');
  assert.equal(h.riffSize, 36 + 16000 * 2, 'RIFF 长度 = 36 + 数据长度');
});

test('采样值往返后基本一致（不能只是头部对、数据是错的）', async () => {
  const NS = await loadEncoder();
  const original = [0, 0.5, -0.5, 1, -1, 0.25, -0.25];
  const samples = new Float32Array(original);
  const buffer = NS.encodeWav(samples, 16000);

  const view = new DataView(buffer);
  const decoded = original.map((_, i) => view.getInt16(44 + i * 2, true) / 32768);

  for (let i = 0; i < original.length; i++) {
    // 16bit 量化误差在 1/32768 量级
    assert.ok(
      Math.abs(decoded[i] - original[i]) < 0.001,
      `第 ${i} 个采样值偏差过大：原始 ${original[i]}，解码 ${decoded[i]}`
    );
  }
});

test('超出 [-1,1] 的采样值被夹住，不会因溢出变成刺耳噪音', async () => {
  const NS = await loadEncoder();
  // 真实录音里偶尔会出现略超 1 的值（浮点误差、混音叠加）
  const samples = new Float32Array([2.5, -3.0, 1.2, -1.5]);
  const buffer = NS.encodeWav(samples, 16000);

  const view = new DataView(buffer);
  const values = [0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true));

  assert.equal(values[0], 32767, '正溢出应夹到最大正值，而不是回绕成负数');
  assert.equal(values[1], -32768, '负溢出应夹到最小负值');
  assert.equal(values[2], 32767);
  assert.equal(values[3], -32768);
});

test('空音频也能产出合法的 WAV（只是没有数据）', async () => {
  const NS = await loadEncoder();
  const buffer = NS.encodeWav(new Float32Array(0), 16000);
  const h = parseWavHeader(buffer);
  assert.equal(h.dataSize, 0);
  assert.equal(h.totalSize, 44);
  assert.equal(h.sampleRate, 16000, '头部仍必须合法，否则服务端解析会报错');
});

test('toWavBuffer 在无法解码时返回 null（调用方需要据此退回原始格式）', async () => {
  /* 关键行为：Web Audio 不可用或解码失败时必须返回 null 而不是抛错，
   * 否则内容脚本会整个流程中断，用户看到的就是“识别失败”却不知原因。 */
  const NS = await loadEncoder();
  const result = await NS.toWavBuffer(new Blob([new Uint8Array([1, 2, 3])]));
  assert.equal(result, null, '没有 AudioContext 时应安静地返回 null');
});

test('toWavBuffer 能把解码结果按 16kHz 包成 WAV', async () => {
  const NS = await loadEncoder();
  // 造一个假的 AudioContext：decodeAudioData 返回 16kHz 单声道正弦波
  const code = await readFile(path.join(distDir, 'content', 'wav-encoder.js'), 'utf8');
  const sandbox = {
    console,
    Uint8Array,
    Float32Array,
    ArrayBuffer,
    DataView,
    Math,
    Blob,
    AudioContext: class {
      constructor() {
        this.sampleRate = 16000;
      }
      async decodeAudioData() {
        const data = new Float32Array(1600);
        for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 10) * 0.8;
        return {
          numberOfChannels: 1,
          sampleRate: 16000,
          getChannelData: () => data
        };
      }
      async close() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(code, { filename: 'content/wav-encoder.js' }).runInContext(sandbox);

  const result = await sandbox.__ZIMU__.toWavBuffer(new Blob([new Uint8Array([1, 2, 3])]));
  assert.ok(result, '应成功转换');
  assert.equal(result.durationSec, 0.1, '1600 个采样 ÷ 16000 = 0.1 秒');

  const h = parseWavHeader(result.buffer);
  assert.equal(h.sampleRate, 16000);
  assert.equal(h.channels, 1);
  assert.equal(h.dataSize, 3200, '1600 个采样 × 2 字节');

  // 波形应当被保留，而不是一片静音
  const view = new DataView(result.buffer);
  let maxAbs = 0;
  for (let i = 0; i < 1600; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(view.getInt16(44 + i * 2, true)));
  }
  assert.ok(maxAbs > 20000, `波形应被保留下来，实际最大振幅 ${maxAbs}`);
});

/* ===========================================================================
 * decodeChunk：把“解码”和“算响度”合并成一次
 *
 * 背景：原来主控对同一段音频连着调了两次 measureLoudness（内容完全相同的
 * 两次解码），发送时 toWavBuffer 又解码第三次。三次 decodeAudioData +
 * 重采样 + 逐样本 WAV 编码全部落在页面主线程上，每块都要做一遍。
 * 主线程被占住之后，分块用的 setTimeout 会被推迟、窗口被跳过，
 * 音频出现空洞——用户看到的就是“字幕缺内容”。
 * ======================================================================== */

/** 造一个假的 AudioContext：decodeAudioData 返回指定的波形。 */
async function loadEncoderWithAudio(data) {
  const code = await readFile(path.join(distDir, 'content', 'wav-encoder.js'), 'utf8');
  const sandbox = {
    console,
    Uint8Array,
    Float32Array,
    ArrayBuffer,
    DataView,
    Math,
    Blob,
    AudioContext: class {
      constructor() {
        this.sampleRate = 16000;
      }
      async decodeAudioData() {
        return {
          numberOfChannels: 1,
          sampleRate: 16000,
          getChannelData: () => data.slice()
        };
      }
      async close() {}
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(code, { filename: 'content/wav-encoder.js' }).runInContext(sandbox);
  return sandbox.__ZIMU__;
}

/** 一段 1600 采样、峰值 0.8 的正弦波（0.1 秒 @16kHz）。 */
function sineWave(amplitude = 0.8) {
  const data = new Float32Array(1600);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 10) * amplitude;
  return data;
}

test('decodeChunk 一次解码同时给出 PCM 和响度', async () => {
  const NS = await loadEncoderWithAudio(sineWave());
  const decoded = await NS.decodeChunk(new Blob([new Uint8Array([1, 2, 3])]));

  assert.ok(decoded, '应能解码');
  assert.equal(decoded.sampleRate, 16000);
  assert.equal(decoded.durationSec, 0.1, '1600 个采样 ÷ 16000 = 0.1 秒');
  assert.ok(Math.abs(decoded.peak - 0.8) < 0.01, `峰值应约为 0.8，实际 ${decoded.peak}`);
  assert.ok(
    Math.abs(decoded.rms - 0.8 / Math.SQRT2) < 0.02,
    `正弦波的 RMS 约等于峰值/√2，实际 ${decoded.rms}`
  );
});

test('decodeChunk 对静音给出 0 响度（静音判定靠它，不能误报）', async () => {
  const NS = await loadEncoderWithAudio(new Float32Array(1600));
  const decoded = await NS.decodeChunk(new Blob([new Uint8Array([1, 2, 3])]));
  assert.ok(decoded, '空波形也能解码');
  assert.equal(decoded.rms, 0);
  assert.equal(decoded.peak, 0);
});

test('解码失败时 decodeChunk 安静地返回 null（调用方据此退回原始格式）', async () => {
  const NS = await loadEncoder(); // 没有 AudioContext
  assert.equal(await NS.decodeChunk(new Blob([new Uint8Array([1, 2, 3])])), null);
});

test('toWavBuffer 顺带返回响度，调用方不必再解码一遍', async () => {
  const NS = await loadEncoderWithAudio(sineWave());
  const result = await NS.toWavBuffer(new Blob([new Uint8Array([1, 2, 3])]));
  assert.ok(result);
  assert.ok(result.rms > 0.5, `应带上响度，实际 ${result.rms}`);
  assert.ok(result.peak > 0.7, `应带上峰值，实际 ${result.peak}`);
});
