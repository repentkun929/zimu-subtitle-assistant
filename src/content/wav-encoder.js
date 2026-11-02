/**
 * 把录音转成 16kHz 单声道 WAV。
 *
 * 为什么需要转这一步（这是让本地 Whisper 能用的关键）：
 *
 * MediaRecorder 录出来的是 WebM/Opus。云端识别服务有完整的解码能力，
 * 能直接吃 WebM；但**本地服务通常没有 ffmpeg**，只能解 WAV 这类无压缩格式。
 * 如果在本地服务里再装 ffmpeg，用户要多一个依赖、多一层出错可能。
 *
 * 所以改成在浏览器里转：用 Web Audio 解码成 PCM，再按 WAV 格式写头。
 * 好处是本地服务只需要 Python 标准库的 wave 模块就能读，依赖降到最低。
 *
 * 代价是体积：16kHz 单声道 16bit 约 32KB/秒，6 秒的块约 192KB
 * （Opus 只要约 48KB）。走本机端口时这点差别可以忽略。
 */
(function () {
  const NS = (globalThis.__ZIMU__ = globalThis.__ZIMU__ || {});

  /** WAV 目标参数：Whisper 就是按 16kHz 训练的，对齐它省掉服务端重采样。 */
  const TARGET_RATE = 16000;

  /**
   * 把任意音频 Blob 解码成 16kHz 单声道 Float32。
   * 解码失败返回 null（调用方自己决定退回方案）。
   */
  async function decodeToMono16k(blob) {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx) return null;

    let ctx = null;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      // 用 16kHz 建上下文，浏览器会自动重采样，省掉我们手写重采样逻辑
      ctx = new AudioCtx({ sampleRate: TARGET_RATE });
      const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));

      if (decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice();

      // 多声道混成单声道
      const left = decoded.getChannelData(0);
      const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
      const mixed = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) mixed[i] = (left[i] + right[i]) / 2;
      return mixed;
    } catch (err) {
      return null;
    } finally {
      try {
        ctx?.close();
      } catch (err) {
        /* 忽略关闭失败 */
      }
    }
  }

  /** 把 Float32 PCM 包成 16bit 单声道 WAV 的 ArrayBuffer。 */
  function encodeWav(samples, sampleRate) {
    const dataSize = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeString = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt 块长度
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // 单声道
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // 字节率
    view.setUint16(32, 2, true); // 块对齐
    view.setUint16(34, 16, true); // 位深
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      // 夹到 [-1,1] 再转 16bit 有符号，避免爆音
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
    return buffer;
  }

  /**
   * 量一段 PCM 的响度（RMS 与峰值）。
   *
   * 单独抽出来是因为它必须和“解码”合并：解码是整条链路上最贵的操作，
   * 之前每块音频要解码三遍（两次静音检测 + 一次转 WAV），全在页面主线程上。
   */
  function loudnessOf(samples) {
    if (!samples || !samples.length) return { rms: 0, peak: 0 };
    let sum = 0;
    let peak = 0;
    const step = Math.max(1, Math.floor(samples.length / 20000));
    let count = 0;
    for (let i = 0; i < samples.length; i += step) {
      const value = samples[i];
      sum += value * value;
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
      count++;
    }
    return { rms: Math.sqrt(sum / Math.max(1, count)), peak };
  }

  /**
   * 把录音 Blob 解码成 16kHz 单声道 PCM，顺带算出响度。
   *
   * 为什么要把这两件事合在一起：解码（decodeAudioData + 重采样）是全流程里
   * 最贵的一步，而调用方既要用 PCM 转 WAV，又要用响度做静音判定。
   * 分开调用就会把同一段音频解码两遍——每块两次，加上主线程本来就在
   * 解码视频，很容易把主线程占满，进而把分块定时器推迟、音频出现空洞。
   *
   * @returns {Promise<{samples: Float32Array, sampleRate: number, durationSec: number, rms: number, peak: number}|null>}
   */
  async function decodeChunk(blob) {
    const samples = await decodeToMono16k(blob);
    if (!samples || !samples.length) return null;
    const { rms, peak } = loudnessOf(samples);
    return {
      samples,
      sampleRate: TARGET_RATE,
      durationSec: samples.length / TARGET_RATE,
      rms,
      peak
    };
  }

  /**
   * 把录音 Blob 转成 WAV ArrayBuffer。
   *
   * @returns {Promise<{buffer: ArrayBuffer, durationSec: number, rms: number, peak: number}|null>}
   *          解码失败返回 null，调用方应退回发送原始格式。
   */
  async function toWavBuffer(blob) {
    const decoded = await decodeChunk(blob);
    if (!decoded) return null;
    return {
      buffer: encodeWav(decoded.samples, TARGET_RATE),
      durationSec: decoded.durationSec,
      rms: decoded.rms,
      peak: decoded.peak
    };
  }

  NS.toWavBuffer = toWavBuffer;
  NS.decodeChunk = decodeChunk;
  NS.loudnessOf = loudnessOf;
  NS.encodeWav = encodeWav;
  NS.WAV_SAMPLE_RATE = TARGET_RATE;
})();

