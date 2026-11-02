#!/usr/bin/env python3
"""
本地 Whisper 识别服务。

给「网络课程字幕助手」扩展提供一个跑在自己电脑上的语音识别后端，
接口与 OpenAI 的 /audio/transcriptions 完全兼容，所以扩展那边只要把
接口地址改成 http://127.0.0.1:8788/v1 就能用，模型名随便填。

为什么本地识别能把延迟从十几秒压到几秒：
  云端接口每次请求都要排队 + 网络往返，实测稳定在 8~15 秒；
  本地模型省掉了排队和往返，只需要算力时间。在这类 8 核 CPU 上，
  用 faster-whisper 的 small 模型处理 4~6 秒音频通常 1~4 秒就出结果。

依赖（二选一，推荐前者，速度差 4 倍以上）：
    pip install faster-whisper
    pip install openai-whisper        # 慢，但兼容性更广

启动：
    python tools/local-asr/server.py
    python tools/local-asr/server.py --model small --port 8788
    python tools/local-asr/server.py --model medium --compute-type int8

常用参数：
    --model         tiny / base / small / medium / large-v3（默认 small）
                    中文用 small 起步；想更准用 medium（更慢、更吃内存）
    --port          监听端口，默认 8788
    --compute-type  int8（省内存，推荐）/ int8_float16 / float32
    --device        cpu（默认）/ cuda
    --language      zh（默认中文；改成 auto 自动判断）
    --warmup        启动时先跑一次空音频，把模型加载好（默认开）

注意：本服务只监听 127.0.0.1，不对外网开放。
"""

import argparse
import json
import os
import re
import struct
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Windows 控制台默认不是 UTF-8，中文日志会变成乱码。
# 主动切到 UTF-8，否则用户看到的启动提示全是问号。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# ---------------------------------------------------------------------------
# 全局状态：模型只加载一次，多线程共享（识别本身用锁串行化）
# ---------------------------------------------------------------------------
MODEL = None
MODEL_LOCK = threading.Lock()
BACKEND = None
ARGS = None
STATS = {"requests": 0, "totalMs": 0, "audioMs": 0}


def log(*parts):
    print("[本地识别]", *parts, flush=True)


# 默认使用国内镜像：huggingface.co 在国内基本连不上，
# 而模型下载依赖它。镜像站是完整同步的，内容一致。
DEFAULT_HF_ENDPOINT = "https://hf-mirror.com"


def configure_hf_mirror(endpoint):
    """把模型下载指向镜像站。

    必须在 import faster_whisper / huggingface_hub **之前**设置环境变量，
    因为库在导入时就读取 HF_ENDPOINT 并缓存下来了。
    """
    if not endpoint:
        return
    os.environ.setdefault("HF_ENDPOINT", endpoint)
    # 有些库还认这两个老名字，一并设上，避免遗漏
    os.environ.setdefault("HUGGINGFACE_CO_URL_HOME", endpoint)
    log(f"模型下载源：{os.environ['HF_ENDPOINT']}")


def patch_av_open_compat():
    """兼容 av 新旧版本的参数差异（faster-whisper 的解码路径）。

    这是踩过的坑：faster-whisper 1.2.1 解码音频时调用
        fw_audio.av.open(path, mode="r", metadata_errors="ignore")
    而较新的 av（19.x）**删掉了 metadata_errors 参数**，于是抛 TypeError。
    更麻烦的是 faster-whisper 在 transcribe() 开头**无条件**调用解码，
    所以任何输入都会失败——整个后端不可用，而报错只有一句
    “open() got an unexpected keyword argument 'metadata_errors'”，
    完全看不出该改哪里。

    处理方式：替换 faster_whisper 的 decode_audio 入口。
      · 已经是采样数组 → 直接规整成 float32（不碰 av）；
      · WAV 文件 → 用标准库解（最快，也不受 av 版本影响）；
      · 其它格式 → 交给原实现，调用前把它用的 av.open 换成忽略多余参数的版本。
    既不改第三方源码，也不用降级 av
    （av 旧版在 Python 3.13 上没有预编译包，降级会直接失败）。

    @returns {string} 描述信息，供启动日志展示
    """
    try:
        import av
        import faster_whisper.audio as fw_audio
        import faster_whisper.transcribe as fw_transcribe
        import numpy as np

        original_decode = fw_audio.decode_audio

        def looks_like_samples(value):
            """判断是不是“采样数组”。

            必须覆盖 numpy 数组**和普通 list/tuple**：调用方可能直接传
            list 而不是 ndarray（我们的调试脚本就是这么传的，一开始漏判了）。
            同时也排除 bytes/bytearray——那是文件内容，不是采样。
            """
            if isinstance(value, (bytes, bytearray, str)):
                return False
            if isinstance(value, np.ndarray):
                return True
            if isinstance(value, (list, tuple)):
                return len(value) > 0 and isinstance(value[0], (int, float))
            return False

        def to_float32_samples(value):
            """把各种采样容器统一成 float32 一维数组。"""
            if isinstance(value, np.ndarray):
                return np.asarray(value, dtype=np.float32).reshape(-1)
            return np.asarray(list(value), dtype=np.float32).reshape(-1)

        def compatible_decode_audio(input_file, sampling_rate=16000, **kwargs):
            # 1) 已经是采样数据
            if looks_like_samples(input_file):
                return to_float32_samples(input_file)

            # 2) WAV 文件：标准库直接解
            if isinstance(input_file, (str, bytes, os.PathLike)) and not isinstance(input_file, (bytes, bytearray)):
                parsed = read_wav_as_float32(os.fspath(input_file))
                if parsed is not None:
                    audio = np.asarray(parsed["audio"], dtype=np.float32)
                    if parsed["rate"] != sampling_rate and parsed["rate"] > 0:
                        # 简单线性重采样，够用且不引入新依赖
                        index = np.arange(0, len(audio), parsed["rate"] / sampling_rate)
                        audio = np.interp(index, np.arange(len(audio)), audio).astype(np.float32)
                    return audio

            # 3) 其它格式：走原实现，但把它用的 av.open 换成忽略多余参数的版本。
            #    注意要替换 faster_whisper.audio 模块里的 av 名——
            #    它是 `from av import open` 导入的，改 av 模块本身不生效。
            original_open = fw_audio.av.open

            def tolerant_open(*args, **inner_kwargs):
                inner_kwargs.pop("metadata_errors", None)
                return original_open(*args, **inner_kwargs)

            fw_audio.av.open = tolerant_open
            try:
                return original_decode(input_file, sampling_rate=sampling_rate, **kwargs)
            finally:
                fw_audio.av.open = original_open

        # 两个模块都要换：transcribe.py 在模块顶层 import 了它，用的是自己的名字
        fw_audio.decode_audio = compatible_decode_audio
        fw_transcribe.decode_audio = compatible_decode_audio
        return (
            f"已接管音频解码（av {getattr(av, '__version__', '?')}）："
            "采样数组直通、WAV 走标准库、其它格式自动忽略 av 不支持的参数"
        )
    except Exception as err:  # noqa: BLE001 - 兼容层失败不该阻止启动
        return f"引入解码兼容层时出错（继续尝试）：{err}"


# ---------------------------------------------------------------------------
# 加载模型
# ---------------------------------------------------------------------------
def load_model():
    """按 faster-whisper → openai-whisper 的顺序尝试加载。"""
    global MODEL, BACKEND

    # 先修掉 av 的 API 差异，否则解码音频时必然抛 TypeError
    log(patch_av_open_compat())

    try:
        from faster_whisper import WhisperModel

        log(f"正在加载 faster-whisper 模型 {ARGS.model}（首次会自动下载，请耐心等待）…")
        started = time.time()
        try:
            MODEL = WhisperModel(
                ARGS.model,
                device=ARGS.device,
                compute_type=ARGS.compute_type,
                download_root=ARGS.model_dir or None,
            )
        except Exception as err:  # noqa: BLE001
            # 下载失败是最常见的情况，单独给出可操作的提示
            message = str(err)
            if any(word in message for word in ("ConnectTimeout", "Connection", "Hub", "snapshot", "resolve")):
                log("模型下载失败。可能的原因与处理：")
                log(f"  1. 网络连不上模型源（当前用 {os.environ.get('HF_ENDPOINT', 'huggingface.co')}）")
                log("     换镜像重试：--hf-endpoint https://hf-mirror.com")
                log("  2. 想完全离线：先从别的机器把模型目录拷到")
                log(f"     {ARGS.model_dir}")
                log("     然后用 --model-dir 指向它")
                log("  3. 也可以改用云端识别：设置里选「硅基流动」，不再需要下载模型")
            raise

        BACKEND = "faster-whisper"
        log(f"加载完成，耗时 {time.time() - started:.1f}s，后端 faster-whisper")
        return
    except ImportError:
        log("未安装 faster-whisper，尝试 openai-whisper…")
    except Exception as err:  # noqa: BLE001 - 要把真实原因打给用户看
        log(f"faster-whisper 加载失败：{err}")
        log("尝试退回 openai-whisper…")

    try:
        import whisper

        log(f"正在加载 openai-whisper 模型 {ARGS.model}…")
        started = time.time()
        MODEL = whisper.load_model(ARGS.model, download_root=ARGS.model_dir or None)
        BACKEND = "openai-whisper"
        log(f"加载完成，耗时 {time.time() - started:.1f}s，后端 openai-whisper")
        return
    except ImportError:
        pass
    except Exception as err:  # noqa: BLE001
        log(f"openai-whisper 加载失败：{err}")

    log("=" * 60)
    log("没有可用的 Whisper 后端。请先安装依赖（任选其一）：")
    log("    pip install faster-whisper      ← 推荐，速度快很多")
    log("    pip install openai-whisper")
    log("=" * 60)
    sys.exit(2)


# ---------------------------------------------------------------------------
# 音频读取：优先按 WAV 解析（扩展会直接送 WAV），否则交给 Whisper 自己解码
# ---------------------------------------------------------------------------
def read_wav_as_float32(path):
    """把 16bit PCM WAV 读成 [-1,1] 的 float 列表；不是 WAV 就返回 None。"""
    try:
        with wave.open(path, "rb") as wf:
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            rate = wf.getframerate()
            frames = wf.readframes(wf.getnframes())
            if width != 2:
                return None

            count = len(frames) // 2
            samples = struct.unpack("<%dh" % count, frames[: count * 2])

            # 多声道混成单声道
            if channels > 1:
                mono = []
                for i in range(0, len(samples) - channels + 1, channels):
                    mono.append(sum(samples[i : i + channels]) / channels)
                samples = mono

            audio = [s / 32768.0 for s in samples]
            return {"audio": audio, "rate": rate}
    except Exception:  # noqa: BLE001 - 不是 WAV 很正常，走别的路径
        return None


def audio_duration_ms(path):
    """尽量拿到音频时长，用于日志统计。"""
    try:
        with wave.open(path, "rb") as wf:
            return int(wf.getnframes() / wf.getframerate() * 1000)
    except Exception:  # noqa: BLE001
        return 0


# ---------------------------------------------------------------------------
# 识别
# ---------------------------------------------------------------------------
def transcribe(path):
    """识别一个音频文件，返回文本。"""
    started = time.time()
    language = None if ARGS.language in ("auto", "", None) else ARGS.language

    text = ""
    with MODEL_LOCK:  # 模型不是线程安全的，串行调用
        if BACKEND == "faster-whisper":
            wav = read_wav_as_float32(path)
            if wav is not None:
                segments, _info = MODEL.transcribe(
                    wav["audio"],
                    language=language,
                    beam_size=ARGS.beam_size,
                    vad_filter=False,
                    condition_on_previous_text=False,
                )
            else:
                # 交给 faster-whisper 自己的解码器（能处理 webm/mp3 等）
                segments, _info = MODEL.transcribe(
                    path,
                    language=language,
                    beam_size=ARGS.beam_size,
                    vad_filter=False,
                    condition_on_previous_text=False,
                )
            # 丢掉“非语音上编出来的内容”——音乐/音效段最容易出这种假字幕
            text = "".join(seg.text for seg in segments if not is_hallucination(seg))
        else:
            result = MODEL.transcribe(
                path,
                language=language,
                beam_size=ARGS.beam_size,
                condition_on_previous_text=False,
                fp16=False,
            )
            raw_segments = result.get("segments") or []
            if raw_segments:
                text = "".join(
                    (seg.get("text", "") if isinstance(seg, dict) else seg.text)
                    for seg in raw_segments
                    if not is_hallucination(seg)
                )
            else:
                text = result.get("text", "")

    elapsed = time.time() - started
    return clean_text(text), elapsed


def clean_text(text):
    """去掉 Whisper 在静音段常见的幻觉输出，并规整空白。"""
    if not text:
        return ""
    lowered = text.strip()
    # 整段就是标注的情况
    if re.fullmatch(r"[\[\]（）()\s]*(音乐|掌声|噪声|静音|无声|music|applause|noise|silence)[\[\]（）()\s]*",
                    lowered, flags=re.IGNORECASE):
        return ""
    # 去掉行内标注
    lowered = re.sub(r"[\[（(]\s*(音乐|掌声|噪声|静音|无声|music|applause|noise|silence)\s*[\]）)]",
                     " ", lowered, flags=re.IGNORECASE)
    lowered = re.sub(r"\s+", " ", lowered)
    return lowered.strip()


# 非语音幻觉的置信度门限。实测数据（small / int8 / zh）：
#   真实中文语音   no_speech_prob ≈ 0.002，avg_logprob ≈ -0.19
#   220Hz 正弦音   no_speech_prob ≈ 0.845，avg_logprob ≈ -0.84 → 被编成“字幕製作人Zither Harp”
# 两者分离度极大，所以取「no_speech 偏高 **且** 置信度偏低」两条同时成立才丢弃，
# 这样带背景音乐的课堂人声（no_speech 可能到 0.3~0.5，但 logprob 仍接近 0）不会被误杀。
#
# 注意：Whisper 自带的 logprob 门限是 -1.0，实测**挡不住**上面这个幻觉
#（-0.84 > -1.0），所以这里的门限必须比它宽松（更接近 0）才有效。
NO_SPEECH_PROB_LIMIT = 0.6
MEAN_LOGPROB_LIMIT = -0.5


def is_hallucination(seg):
    """判断一个 segment 是不是「在非语音上编出来的内容」。

    只认能取到置信度字段的 segment；取不到就放行——宁可多留内容，不可误删真话。
    """
    if isinstance(seg, dict):
        no_speech = seg.get("no_speech_prob")
        logprob = seg.get("avg_logprob")
    else:
        no_speech = getattr(seg, "no_speech_prob", None)
        logprob = getattr(seg, "avg_logprob", None)
    if no_speech is None or logprob is None:
        return False
    try:
        return float(no_speech) > NO_SPEECH_PROB_LIMIT and float(logprob) < MEAN_LOGPROB_LIMIT
    except (TypeError, ValueError):
        return False


def audio_is_silent(path, rms_threshold=0.004):
    """用能量判断这段音频是不是基本静音。

    为什么需要它：Whisper 遇到静音或非语音输入时会**编内容**——
    实测一段纯正弦波会被识别成莫名其妙的文字。那种“假字幕”比没有字幕更糟，
    因为用户无法分辨。所以在识别前先看能量，静音直接返回空。

    返回 {silent, rms, peak}；不是 WAV 时返回 silent=False（交给后端自己判断）。
    """
    parsed = read_wav_as_float32(path)
    if parsed is None:
        return {"silent": False, "rms": None, "peak": None}

    audio = parsed["audio"]
    if not audio:
        return {"silent": True, "rms": 0.0, "peak": 0.0}

    # 抽样统计即可，不必遍历每个采样
    step = max(1, len(audio) // 20000)
    total = 0.0
    peak = 0.0
    count = 0
    for i in range(0, len(audio), step):
        value = audio[i]
        total += value * value
        magnitude = abs(value)
        if magnitude > peak:
            peak = magnitude
        count += 1

    rms = (total / max(1, count)) ** 0.5
    return {"silent": rms < rms_threshold and peak < 0.05, "rms": rms, "peak": peak}


# ---------------------------------------------------------------------------
# 流式识别：连续投喂 + 滚动解码
# ---------------------------------------------------------------------------
#
# 为什么要有这一套：
#   分段模式（/audio/transcriptions）的延迟下限是「分块秒数 + 识别耗时」，
#   因为客户端必须先把一块录满才发得出去。用户实测把分块从 12 秒压到 5 秒
#   之后连贯性明显变好，但仍有几秒延迟——那几秒是**等窗口录满**的时间，
#   不是识别慢。想把延迟再压下去，只能让服务端提前开始识别、边识别边出字。
#
# 做法（业界常用的 LocalAgreement 思路，这里是简化版）：
#   1. 客户端按 ~1.6 秒切片持续投喂，服务端维护一段「尚未定稿」的音频缓冲；
#   2. 每收到约 0.8 秒新音频就把这段缓冲整体再解码一次；
#   3. 相邻两次解码结果里**文本完全一致的前缀**才算数——Whisper 对同一段
#      固定音频的结果是稳定的，而正在说话的尾巴每次都会变。把稳定前缀定稿
#      发出去，尾巴留着等下次。
#   4. 万一一直没能定稿（例如整段是没有停顿的长句），超过
#      STREAM_MAX_UNCOMMITTED_SECONDS 就把第一条强制定稿，避免无限等待。
#
# 与分段模式的取舍：
#   延迟从「一个窗口 + 识别」降到约 1~2 秒，但同一段音频会被反复解码，
#   CPU 占用明显上升。所以它只在**本机服务**上启用——云端按次计费，
#   反复解码等于反复收费。

SR = 16000
STREAMS = {}

# 攒够这么多新音频就再解码一次。越小越灵敏、越费 CPU。
STREAM_MIN_DECODE_SECONDS = 0.8
# 未定稿音频的上限。超过就把第一条强制定稿，保证字幕不会无限期押后。
STREAM_MAX_UNCOMMITTED_SECONDS = 5.0
# 会话空闲多久就回收（客户端崩了/换了页面时不会一直占内存）。
STREAM_IDLE_TIMEOUT_SECONDS = 120.0


def common_prefix_len(a, b):
    """两个列表从头开始完全相同的元素个数。"""
    limit = min(len(a), len(b))
    i = 0
    while i < limit and a[i] == b[i]:
        i += 1
    return i


def pick_commit_count(prev_texts, cur_texts, force):
    """这一次解码结果里，有多少条可以定稿。

    @param {list[str]} prev_texts 上一次解码得到的各段文本
    @param {list[str]} cur_texts  这一次解码得到的各段文本
    @param {bool} force           是否允许在完全不一致时也强制定稿一条

    「一致」指的是相邻两次解码在同一段音频上给出了同样的文本。
    只在一侧出现的内容一律不算——那正是还在变化的部分。
    """
    if not cur_texts:
        return 0
    agree = common_prefix_len(list(prev_texts), list(cur_texts))
    if force and agree == 0:
        return 1
    return agree


def drop_stale_streams(now_ts):
    for key in [k for k, v in STREAMS.items() if now_ts - v["last_seen"] > STREAM_IDLE_TIMEOUT_SECONDS]:
        STREAMS.pop(key, None)


def decode_pcm_segments(pcm):
    """识别一段 float32 PCM（16kHz 单声道），返回 [{start, end, text}]。

    时间是**相对这段音频开头**的秒数，调用方再叠加这段音频在视频时间轴上的起点。
    """
    language = None if ARGS.language in ("auto", "", None) else ARGS.language
    if BACKEND == "faster-whisper":
        segments, _info = MODEL.transcribe(
            pcm,
            language=language,
            beam_size=ARGS.beam_size,
            vad_filter=False,
            condition_on_previous_text=False,
        )
    else:
        result = MODEL.transcribe(
            pcm,
            language=language,
            beam_size=ARGS.beam_size,
            condition_on_previous_text=False,
            fp16=False,
        )
        segments = result.get("segments", [])

    out = []
    for seg in segments:
        if isinstance(seg, dict):
            raw_text, start, end = seg.get("text", ""), seg.get("start", 0), seg.get("end", 0)
        else:
            raw_text, start, end = seg.text, seg.start, seg.end
        # 非语音上编出来的内容在这里丢掉：流式模式下尤其重要——
        # 同一段缓冲会被反复解码，若幻觉文本在两次解码里一致，
        # 「最长公共前缀」会把它当成稳定内容**定稿提交**，比批量模式更容易漏出来。
        if is_hallucination(seg):
            continue
        text = clean_text(raw_text)
        if not text:
            continue
        start, end = float(start), float(end)
        if end <= start:
            continue
        out.append({"start": start, "end": end, "text": text})
    return out


def stream_feed(session_id, wav_path, media_start, media_end, flush):
    """投喂一小段音频，返回本次新定稿的字幕。

    音频按**媒体时间**（video.currentTime）对齐：与已缓冲部分重叠的裁掉，
    中间断档的补静音——否则缓冲区的长度和视频时间轴对不上，
    定稿出来的时间戳会整体漂移。
    """
    import numpy as np

    parsed = read_wav_as_float32(wav_path) if wav_path else None
    if parsed is not None:
        audio = np.asarray(parsed["audio"], dtype=np.float32)
        rate = parsed["rate"] or SR
        if rate != SR and audio.size:
            index = np.arange(0, len(audio), rate / SR)
            audio = np.interp(index, np.arange(len(audio)), audio).astype(np.float32)
    else:
        audio = np.zeros(0, dtype=np.float32)

    now_ts = time.time()
    with MODEL_LOCK:
        drop_stale_streams(now_ts)
        session = STREAMS.get(session_id)
        if session is None:
            session = {
                "pcm": np.zeros(0, dtype=np.float32),
                "media_end": None,
                "prev": [],
                "committed": [],
                "last_decoded_len": 0,
                "decodes": 0,
                "decode_ms": 0.0,
            }
            STREAMS[session_id] = session
        session["last_seen"] = now_ts

        # ---- 追加音频 ----
        if audio.size and media_start is not None and media_end is not None:
            if session["media_end"] is None:
                session["media_end"] = float(media_end)
                skip_seconds = 0.0
                gap_seconds = 0.0
            else:
                buffered_end = session["media_end"]
                skip_seconds = max(0.0, buffered_end - float(media_start))
                gap_seconds = max(0.0, float(media_start) - buffered_end)

            cut = min(int(round(skip_seconds * SR)), audio.size)
            appended = audio[cut:]
            if gap_seconds > 0.05:
                appended = np.concatenate([np.zeros(int(round(gap_seconds * SR)), dtype=np.float32), appended])
            if appended.size:
                session["pcm"] = np.concatenate([session["pcm"], appended])
            session["media_end"] = max(session["media_end"] or float(media_end), float(media_end))

        buf_seconds = len(session["pcm"]) / SR
        new_samples = len(session["pcm"]) - session["last_decoded_len"]
        should_decode = bool(session["pcm"].size) and (
            flush or new_samples >= int(STREAM_MIN_DECODE_SECONDS * SR)
        )

        committed = []
        if should_decode:
            started = time.time()
            cur = decode_pcm_segments(session["pcm"])
            session["decodes"] += 1
            session["decode_ms"] += (time.time() - started) * 1000

            cur_texts = [s["text"] for s in cur]
            force = flush or buf_seconds >= STREAM_MAX_UNCOMMITTED_SECONDS
            count = len(cur) if flush else pick_commit_count(session["prev"], cur_texts, force)

            if count > 0:
                head_media = (session["media_end"] or 0.0) - buf_seconds
                for seg in cur[:count]:
                    committed.append({
                        "start": round(head_media + seg["start"], 3),
                        "end": round(head_media + seg["end"], 3),
                        "text": seg["text"],
                    })
                # 定稿到哪就把缓冲裁到哪：剩下的部分下次接着解
                drop = min(int(round(cur[count - 1]["end"] * SR)), len(session["pcm"]))
                session["pcm"] = session["pcm"][drop:]
                session["prev"] = cur_texts[count:]
            else:
                session["prev"] = cur_texts

            session["last_decoded_len"] = len(session["pcm"])
            session["committed"].extend(s["text"] for s in committed)

        result = {
            "ok": True,
            "segments": committed,
            "text": "".join(s["text"] for s in committed),
            "pending": "" if flush else "".join(session["prev"]),
            "committedChars": len("".join(session["committed"])),
            "decodes": session["decodes"],
            "avgDecodeMs": round(session["decode_ms"] / session["decodes"], 1) if session["decodes"] else 0,
        }
        if flush:
            STREAMS.pop(session_id, None)
        return result


def _to_float(value, default=None):
    if value is None:
        return default
    try:
        return float(value.decode("utf-8", "replace").strip())
    except (ValueError, AttributeError):
        return default


# ---------------------------------------------------------------------------
# 极简 multipart/form-data 解析
# ---------------------------------------------------------------------------
def parse_multipart(body, content_type):
    match = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not match:
        return {}
    boundary = ("--" + match.group(1)).encode("latin-1")

    parts = {}
    for chunk in body.split(boundary):
        if b"\r\n\r\n" not in chunk:
            continue
        header_blob, payload = chunk.split(b"\r\n\r\n", 1)
        payload = payload.rstrip(b"\r\n")
        if payload.endswith(b"--"):
            payload = payload[:-2]
        header_text = header_blob.decode("latin-1", errors="replace")
        name_match = re.search(r'name="([^"]+)"', header_text)
        if not name_match:
            continue
        parts[name_match.group(1)] = payload
    return parts


# ---------------------------------------------------------------------------
# HTTP 处理
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 关掉默认的逐请求日志，改用自定义的
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802 - BaseHTTPRequestHandler 的命名约定
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/health") or self.path == "/":
            avg = STATS["totalMs"] / STATS["requests"] if STATS["requests"] else 0
            self._json(200, {
                "ok": True,
                "service": "zimu-local-asr",
                "backend": BACKEND,
                "model": ARGS.model,
                "language": ARGS.language,
                "requests": STATS["requests"],
                "avgMs": round(avg, 1),
                "note": "把扩展的接口地址设为 http://127.0.0.1:%d/v1" % ARGS.port,
            })
            return
        self._json(404, {"ok": False, "error": "未知路径：" + self.path})

    def _handle_stream(self, parts):
        """处理一段流式投喂（见 stream_feed 的说明）。"""
        session_id = (parts.get("session") or b"").decode("utf-8", "replace").strip()
        if not session_id:
            self._json(400, {"error": {"message": "流式请求缺少 session 标识"}})
            return

        flush = (parts.get("flush") or b"0").decode("utf-8", "replace").strip() in ("1", "true", "yes")
        audio = parts.get("file")
        tmp_path = None
        try:
            if audio:
                with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
                    tmp.write(audio)
                    tmp_path = tmp.name
            result = stream_feed(
                session_id,
                tmp_path,
                _to_float(parts.get("start")),
                _to_float(parts.get("end")),
                flush,
            )
            STATS["requests"] += 1
            if result.get("segments"):
                log(
                    "流式定稿 %d 条（第 %d 次解码，平均 %.0fms）：%s"
                    % (
                        len(result["segments"]),
                        result["decodes"],
                        result["avgDecodeMs"],
                        " / ".join(s["text"] for s in result["segments"])[:80],
                    )
                )
            self._json(200, result)
        except Exception as err:  # noqa: BLE001
            log(f"流式识别失败：{err}")
            self._json(500, {"error": {"message": f"流式识别失败：{err}"}})
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    def do_POST(self):  # noqa: N802
        supported = (
            self.path.endswith("/audio/transcriptions") or self.path.endswith("/audio/stream")
        )
        if not supported:
            self._json(404, {
                "ok": False,
                "error": "未知路径 %s。扩展应把接口地址指向 http://127.0.0.1:%d/v1"
                         % (self.path, ARGS.port),
            })
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._json(400, {"error": {"message": "请求体为空"}})
            return

        body = self.rfile.read(length)
        parts = parse_multipart(body, self.headers.get("Content-Type", ""))

        if self.path.endswith("/audio/stream"):
            self._handle_stream(parts)
            return

        audio = parts.get("file")
        if not audio:
            self._json(400, {"error": {"message": "请求里没有 file 字段"}})
            return

        suffix = ".wav"
        content_type = self.headers.get("Content-Type", "")
        if "webm" in content_type:
            suffix = ".webm"
        elif "ogg" in content_type:
            suffix = ".ogg"
        elif "mp4" in content_type or "m4a" in content_type:
            suffix = ".m4a"

        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(audio)
                tmp_path = tmp.name

            # 先看能量：静音/非语音直接返回空，避免 Whisper 编内容
            energy = audio_is_silent(tmp_path)
            if energy["silent"]:
                STATS["requests"] += 1
                log(f"判定为静音（RMS {energy['rms']:.5f}），跳过识别")
                self._json(200, {"text": ""})
                return

            started = time.time()
            text, elapsed = transcribe(tmp_path)
            STATS["requests"] += 1
            STATS["totalMs"] += elapsed * 1000

            audio_ms = audio_duration_ms(tmp_path)
            if audio_ms:
                STATS["audioMs"] += audio_ms
                speed = (audio_ms / 1000) / elapsed if elapsed > 0 else 0
                ratio = f"，音频 {audio_ms/1000:.1f}s，速度 {speed:.1f}x 实时"
            else:
                ratio = ""

            preview = text if ARGS.verbose else (text[:40] + "…" if len(text) > 40 else text)
            log(f"{elapsed:.2f}s{ratio} → {preview or '(空)'}")

            self._json(200, {"text": text})
        except Exception as err:  # noqa: BLE001 - 任何异常都要让扩展看到原因
            log(f"识别失败：{err}")
            self._json(500, {"error": {"message": f"本地识别失败：{err}"}})
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
def parse_args():
    parser = argparse.ArgumentParser(description="本地 Whisper 识别服务（供字幕助手扩展使用）")
    parser.add_argument("--model", default=os.environ.get("ZIMU_ASR_MODEL", "small"),
                        help="模型大小：tiny/base/small/medium/large-v3（默认 small）")
    parser.add_argument("--port", type=int, default=int(os.environ.get("ZIMU_ASR_PORT", "8788")))
    parser.add_argument("--device", default=os.environ.get("ZIMU_ASR_DEVICE", "cpu"))
    parser.add_argument("--compute-type", default=os.environ.get("ZIMU_ASR_COMPUTE", "int8"),
                        help="int8（省内存，推荐）/ float32 / int8_float16")
    parser.add_argument("--language", default=os.environ.get("ZIMU_ASR_LANG", "zh"))
    parser.add_argument("--beam-size", type=int, default=int(os.environ.get("ZIMU_ASR_BEAM", "1")),
                        help="1 最快；调大更准但更慢")
    parser.add_argument("--model-dir", default=os.environ.get("ZIMU_ASR_MODEL_DIR", ""),
                        help="模型缓存目录，默认放在用户目录下")
    parser.add_argument("--hf-endpoint", default=os.environ.get("HF_ENDPOINT", DEFAULT_HF_ENDPOINT),
                        help="模型下载源，默认 https://hf-mirror.com（国内可达）")
    parser.add_argument("--verbose", action="store_true", help="日志里打印完整识别文本")
    parser.add_argument("--no-warmup", action="store_true", help="启动时不做预热")
    parser.add_argument("--stream-min-decode", type=float,
                        default=float(os.environ.get("ZIMU_STREAM_MIN_DECODE", "0.8")),
                        help="流式模式攒够多少秒新音频就再解码一次（越小越灵敏、越费 CPU）")
    parser.add_argument("--stream-max-uncommitted", type=float,
                        default=float(os.environ.get("ZIMU_STREAM_MAX_UNCOMMITTED", "5.0")),
                        help="流式模式未定稿音频的上限（秒），超过就强制定稿一条")
    parser.add_argument("--selftest", action="store_true",
                        help="只检查解析逻辑与 WAV 读写，不加载模型（用于快速验证环境）")
    return parser.parse_args()


def run_selftest():
    """不依赖模型的自检：验证 multipart 解析、WAV 读写、文本清洗。

    存在的意义：加载模型要下载几百 MB，一旦失败用户很难判断是
    “网络问题”“依赖没装”还是“代码有 bug”。先跑这个能快速定位。
    """
    print("=" * 62)
    print("自检模式（不加载模型）")
    print("=" * 62)
    failures = 0

    def check(name, condition, detail=""):
        nonlocal failures
        if condition:
            print(f"  [通过] {name}")
        else:
            failures += 1
            print(f"  [失败] {name} {detail}")

    # 1. WAV 读写往返
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            path = tmp.name
        rate = 16000
        tone = [int(12000 * (1 if i % 2 else -1)) for i in range(rate // 2)]
        with wave.open(path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(rate)
            wf.writeframes(struct.pack("<%dh" % len(tone), *tone))

        parsed = read_wav_as_float32(path)
        check("WAV 读取", parsed is not None and len(parsed["audio"]) == len(tone),
              f"实际 {parsed and len(parsed['audio'])} 个采样，期望 {len(tone)}")
        check("WAV 采样率识别", parsed is not None and parsed["rate"] == rate)
        check("WAV 时长计算", audio_duration_ms(path) == 500,
              f"实际 {audio_duration_ms(path)}ms")
        os.unlink(path)
    except Exception as err:  # noqa: BLE001
        check("WAV 读写", False, f"异常：{err}")

    # 2. multipart 解析（模拟扩展发来的请求体）
    try:
        boundary = "----zimu-test-boundary"
        audio_bytes = b"RIFFfake-audio-data"
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="chunk.wav"\r\n'
            "Content-Type: audio/wav\r\n\r\n"
        ).encode() + audio_bytes + (
            f"\r\n--{boundary}\r\n"
            'Content-Disposition: form-data; name="model"\r\n\r\n'
            "local-whisper\r\n"
            f"--{boundary}--\r\n"
        ).encode()
        parts = parse_multipart(body, f"multipart/form-data; boundary={boundary}")
        check("multipart 解析出文件", parts.get("file") == audio_bytes,
              f"实际 {parts.get('file')!r}")
        check("multipart 解析出字段", parts.get("model") == b"local-whisper",
              f"实际 {parts.get('model')!r}")
    except Exception as err:  # noqa: BLE001
        check("multipart 解析", False, f"异常：{err}")

    # 3. 文本清洗（Whisper 在静音段的幻觉必须去掉）
    cases = [
        ("[音乐]", ""),
        ("（掌声）", ""),
        ("音乐", ""),
        ("大家好，我们开始上课。", "大家好，我们开始上课。"),
        ("前面的话 [音乐] 后面的话", "前面的话 后面的话"),
        ("  ", ""),
    ]
    for raw, expected in cases:
        got = clean_text(raw)
        check(f"清洗 {raw!r}", got == expected, f"实际 {got!r}，期望 {expected!r}")

    # 4. 流式定稿判定（LocalAgreement 的核心）
    #
    # 这一条必须能在不加载模型的情况下验：它决定了「哪些字可以现在就发出去」，
    # 判错会导致重复字幕（发早了）或字幕迟迟不出（发晚了），
    # 而这两种故障在真实页面上都很难一眼看出来。
    check("最长公共前缀", common_prefix_len(["a", "b"], ["a", "b", "c"]) == 2)
    check("最长公共前缀（完全不同）", common_prefix_len(["a"], ["b"]) == 0)
    check("最长公共前缀（空）", common_prefix_len([], ["a"]) == 0)

    commit_cases = [
        (["一", "二"], ["一", "二"], False, 2, "两次完全一致 → 全部定稿"),
        (["一", "二"], ["一", "三"], False, 1, "只有前一半一致 → 只定稿前半"),
        (["一", "二"], ["三", "四"], False, 0, "完全不一致 → 一条都不定稿"),
        (["一", "二"], ["三", "四"], True, 1, "完全不一致但超时 → 强制定稿一条"),
        (["一"], ["一", "二"], True, 1, "超时时也要遵守一致前缀"),
        ([], ["一"], False, 0, "首次解码不定稿（要等下一次确认）"),
        (["一"], [], False, 0, "本次没有内容 → 不定稿"),
    ]
    for prev_texts, cur_texts, force, expected, why in commit_cases:
        got = pick_commit_count(prev_texts, cur_texts, force)
        check(f"定稿判定：{why}", got == expected, f"实际 {got}，期望 {expected}")

    # 5. 非语音幻觉过滤
    #
    # 门限来自实测（见 NO_SPEECH_PROB_LIMIT 处的注释）：
    # 真实中文语音 no_speech≈0.002、logprob≈-0.19；纯正弦音 no_speech≈0.845、logprob≈-0.84。
    # 这里把「语音必须放行、幻觉必须拦住」两方向都钉住，避免以后调门限时把真人声误杀。
    check("幻觉过滤：真实语音放行",
          not is_hallucination({"no_speech_prob": 0.002, "avg_logprob": -0.191}))
    check("幻觉过滤：正弦音幻觉被拦",
          is_hallucination({"no_speech_prob": 0.845, "avg_logprob": -0.840}))
    check("幻觉过滤：带背景音的语音仍放行（logprob 高）",
          not is_hallucination({"no_speech_prob": 0.55, "avg_logprob": -0.30}))
    check("幻觉过滤：置信度缺失时放行（不误删）",
          not is_hallucination({"text": "没有置信度字段"}))
    check("幻觉过滤：对象形态也识别",
          is_hallucination(type("S", (), {"no_speech_prob": 0.9, "avg_logprob": -0.7})()))

    # 6. 后端可用性（只检查能不能 import，不下载模型）
    backend_found = False
    try:
        import faster_whisper  # noqa: F401
        print("  [信息] 已安装 faster-whisper（推荐后端，速度快）")
        backend_found = True
    except ImportError:
        print("  [信息] 未安装 faster-whisper")
    try:
        import whisper  # noqa: F401
        print("  [信息] 已安装 openai-whisper")
        backend_found = True
    except ImportError:
        print("  [信息] 未安装 openai-whisper")
    check("至少有一个 Whisper 后端", backend_found,
          "请执行 pip install faster-whisper")

    print("=" * 62)
    if failures:
        print(f"自检未通过：{failures} 项失败")
        return 1
    print("自检全部通过。去掉 --selftest 即可正式启动。")
    return 0


def main():
    global ARGS, STREAM_MIN_DECODE_SECONDS, STREAM_MAX_UNCOMMITTED_SECONDS
    ARGS = parse_args()
    STREAM_MIN_DECODE_SECONDS = ARGS.stream_min_decode
    STREAM_MAX_UNCOMMITTED_SECONDS = ARGS.stream_max_uncommitted

    if ARGS.selftest:
        sys.exit(run_selftest())

    # 模型缓存放项目目录之外，避免被误提交或被清理工具删掉
    if not ARGS.model_dir:
        ARGS.model_dir = os.path.join(os.path.expanduser("~"), ".cache", "zimu-whisper")

    # 必须在加载模型前设置下载源（库在导入时就会读取这个环境变量）
    configure_hf_mirror(ARGS.hf_endpoint)

    load_model()

    if not ARGS.no_warmup:
        log("预热中（把模型跑热，避免第一次识别等太久）…")
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
                # 0.5 秒静音 WAV
                rate = 16000
                with wave.open(tmp.name, "wb") as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(rate)
                    wf.writeframes(b"\x00\x00" * int(rate * 0.5))
                warm_path = tmp.name
            started = time.time()
            transcribe(warm_path)
            os.unlink(warm_path)
            log(f"预热完成，耗时 {time.time() - started:.2f}s")
        except Exception as err:  # noqa: BLE001
            log(f"预热失败（不影响使用）：{err}")

    server = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    log("=" * 62)
    log(f"服务已启动：http://127.0.0.1:{ARGS.port}/v1")
    log(f"健康检查：  http://127.0.0.1:{ARGS.port}/health")
    log(f"流式识别：  http://127.0.0.1:{ARGS.port}/v1/audio/stream"
        f"（每 {STREAM_MIN_DECODE_SECONDS}s 新音频解一次，未定稿上限 {STREAM_MAX_UNCOMMITTED_SECONDS}s）")
    log(f"后端：{BACKEND}   模型：{ARGS.model}   语言：{ARGS.language}")
    log("在扩展设置里：供应商选「自定义」，接口地址填 http://127.0.0.1:%d/v1" % ARGS.port)
    log("模型名随便填（本地服务忽略它），API Key 留空。")
    log("按 Ctrl+C 停止。")
    log("=" * 62)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("已停止。")
        server.server_close()


if __name__ == "__main__":
    main()
