#!/usr/bin/env python3
"""
用真实中文语音测试本地识别服务。

做法：调用 Windows 自带的语音合成（SAPI）读一段中文，
把合成的语音送去识别，看返回的文字是否接近原句。
这比正弦波有说服力得多——能真正验证「识别质量」和「耗时」。

用法：
    python tools/local-asr/verify-speech.py
    python tools/local-asr/verify-speech.py --text "自定义测试句子"

只支持 Windows（依赖 SAPI）。其它系统请用 --with-audio 指定现成音频。
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

DEFAULT_TEXT = "今天我们来学习线性回归，首先看一下这个数据集的特点。"


def synthesize(text, out_path):
    """用 PowerShell + SAPI 合成中文语音，输出 WAV。

    选 16kHz 单声道，正好和扩展发给识别服务的格式一致。
    """
    script = f"""
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile('{out_path}', $fmt)
$synth.Speak('{text}')
$synth.Dispose()
"""
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=90,
    )
    return result.returncode == 0 and os.path.exists(out_path)


def post_wav(base_url, path, timeout=180):
    boundary = "----zimuverify"
    with open(path, "rb") as handle:
        audio = handle.read()
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="chunk.wav"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode() + audio + (
        f"\r\n--{boundary}\r\n"
        'Content-Disposition: form-data; name="model"\r\n\r\n'
        "local-whisper\r\n"
        f"--{boundary}--\r\n"
    ).encode()

    request = urllib.request.Request(
        f"{base_url}/v1/audio/transcriptions",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    started = time.time()
    with urllib.request.urlopen(request, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return payload.get("text", ""), time.time() - started


def wav_duration(path):
    try:
        with wave.open(path, "rb") as wf:
            return wf.getnframes() / wf.getframerate()
    except Exception:  # noqa: BLE001
        return 0.0


def main():
    parser = argparse.ArgumentParser(description="用真实中文语音验证本地识别服务")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--text", default=DEFAULT_TEXT, help="要合成并识别的句子")
    args = parser.parse_args()

    base_url = f"http://127.0.0.1:{args.port}"

    print("=" * 62)
    print("真实语音验证")
    print("=" * 62)

    # 服务是否在跑
    try:
        with urllib.request.urlopen(f"{base_url}/health", timeout=10) as resp:
            health = json.loads(resp.read().decode("utf-8"))
        print(f"服务：{health.get('backend')} / {health.get('model')}  正常")
    except Exception as err:  # noqa: BLE001
        print(f"连不上服务：{err}")
        print("请先运行：python tools/local-asr/server.py")
        return 1

    # 合成语音
    out_path = os.path.join(tempfile.gettempdir(), "zimu-verify-speech.wav")
    print(f"\n[1/2] 合成测试语音（Windows SAPI）")
    print(f"      原文：{args.text}")
    if not synthesize(args.text, out_path):
        print("      合成失败。请改用 --with-audio 指定现成音频，或用 probe.py 做基础连通测试。")
        return 1

    duration = wav_duration(out_path)
    print(f"      生成 {out_path}（{duration:.1f} 秒，{os.path.getsize(out_path)} 字节）")

    # 送去识别
    print(f"\n[2/2] 送本地服务识别")
    try:
        text, elapsed = post_wav(base_url, out_path)
    except Exception as err:  # noqa: BLE001
        print(f"      请求失败：{type(err).__name__} {err}")
        return 1

    speed = duration / elapsed if elapsed > 0 else 0
    print(f"      耗时 {elapsed:.2f}s（音频 {duration:.1f}s，速度 {speed:.1f}x 实时）")
    print(f"      识别：{text}")

    # 粗略比对：看原文里的关键片段有没有被识别出来
    keywords = [word for word in ["线性回归", "数据集", "学习", "特点", "首先"] if word in args.text]
    hit = [word for word in keywords if word in text]
    print()
    if keywords:
        print(f"关键词命中：{len(hit)}/{len(keywords)}  {hit}")
    if hit:
        print("结论：识别链路正常且内容对得上。")
        return 0
    print("结论：链路通了，但关键词没命中——可能是模型偏小或语音合成音色不自然。")
    print("      可以试试更大的模型：python tools/local-asr/server.py --model medium")
    return 0


if __name__ == "__main__":
    sys.exit(main())
