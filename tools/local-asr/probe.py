#!/usr/bin/env python3
"""
本地识别服务的连通性测试。

用途：
  1. 服务启动后，确认它能真正识别音频（不只是进程活着）；
  2. 出问题时能分清是“服务没起来”“请求格式不对”还是“识别本身失败”。

用法：
    python tools/local-asr/probe.py
    python tools/local-asr/probe.py --port 8788 --with-audio 你的音频.wav

不带参数时自己合成一段 1 秒正弦波做测试——它不是语音，识别出空文本是正常的，
关键是验证「请求能通、能返回合法 JSON」。
"""

import argparse
import json
import math
import os
import struct
import sys
import tempfile
import urllib.error
import urllib.request
import wave

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


def make_test_wav(seconds=1.0, rate=16000, amplitude=8000, tone=True):
    """合成测试音频。

    amplitude=0 时是纯静音，用来验证服务会不会把静音误识别成内容
    （Whisper 在静音上会产生幻觉，服务器应当先判静音直接返回空）。
    """
    path = os.path.join(tempfile.gettempdir(), "zimu-probe.wav")
    if tone and amplitude > 0:
        samples = [
            int(amplitude * math.sin(2 * math.pi * 440 * i / rate))
            for i in range(int(rate * seconds))
        ]
    else:
        samples = [0] * int(rate * seconds)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack("<%dh" % len(samples), *samples))
    return path


def build_multipart(audio_bytes, boundary, filename="chunk.wav"):
    return (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode() + audio_bytes + (
        f"\r\n--{boundary}\r\n"
        'Content-Disposition: form-data; name="model"\r\n\r\n'
        "local-whisper\r\n"
        f"--{boundary}--\r\n"
    ).encode()


def main():
    parser = argparse.ArgumentParser(description="测试本地识别服务是否可用")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--with-audio", help="用你自己的音频文件测试（推荐，能看到真实识别结果）")
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()

    base = f"http://127.0.0.1:{args.port}"

    # 1) 健康检查
    print(f"[1/2] 健康检查 {base}/health")
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=10) as resp:
            health = json.loads(resp.read().decode("utf-8"))
        print("      服务正常：", json.dumps(health, ensure_ascii=False))
    except urllib.error.URLError as err:
        print(f"      连不上服务：{err}")
        print("      请先在另一个窗口运行：python tools/local-asr/server.py")
        return 1
    except Exception as err:  # noqa: BLE001
        print(f"      健康检查失败：{type(err).__name__} {err}")
        return 1

    # 2) 发一段音频
    audio_path = args.with_audio or make_test_wav()
    is_synthetic = not args.with_audio
    if not os.path.exists(audio_path):
        print(f"      音频文件不存在：{audio_path}")
        return 1
    size = os.path.getsize(audio_path)
    print(f"[2/2] 识别测试：{audio_path}（{size} 字节）")

    boundary = "----zimuprobe"
    with open(audio_path, "rb") as handle:
        body = build_multipart(handle.read(), boundary)

    request = urllib.request.Request(
        f"{base}/v1/audio/transcriptions",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )

    failures = 0
    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        text = payload.get("text")
        print(f"      HTTP {resp.status} → text = {text!r}")
        if is_synthetic:
            print("      ↑ 正弦波不是语音。返回空是理想结果；返回文字说明模型在“编内容”，")
            print("        那种假字幕比没有字幕更糟，所以服务端会先做能量判断。")
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        print(f"      HTTP {err.code} 失败：{detail[:600]}")
        failures += 1

    # 3) 静音测试：必须返回空文本，不能编内容
    if is_synthetic:
        print("[3/3] 静音测试（验证不会在无声处编出假字幕）")
        silent_path = make_test_wav(seconds=1.0, tone=False)
        boundary = "----zimuprobe2"
        with open(silent_path, "rb") as handle:
            silent_body = build_multipart(handle.read(), boundary)
        silent_request = urllib.request.Request(
            f"{base}/v1/audio/transcriptions",
            data=silent_body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(silent_request, timeout=args.timeout) as resp:
                silent_payload = json.loads(resp.read().decode("utf-8"))
            silent_text = silent_payload.get("text")
            if silent_text == "":
                print("      HTTP 200 → text = ''  ← 正确，静音被挡住了")
            else:
                print(f"      HTTP 200 → text = {silent_text!r}  ← 不该有内容！")
                failures += 1
        except Exception as err:  # noqa: BLE001
            print(f"      请求失败：{type(err).__name__} {err}")
            failures += 1

    if failures:
        print(f"存在 {failures} 项异常。")
        return 1
    print("全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
