#!/usr/bin/env node
/**
 * 打包脚本：src/ -> dist/
 *
 * 只做一件有技术含量的事：把 src/common/transcript.js 转成普通脚本。
 *
 * 背景：manifest 里声明的 content script 必须是普通脚本（不支持 import），
 * 而 background service worker 又必须是 ES module。同一份字幕处理逻辑
 * 两边都要用，最省事的做法就是“源码保持 ES module，打包时生成内容脚本版本”，
 * 这样源码只有一份，不会出现两份实现慢慢跑偏的问题。
 *
 * 其余文件都是原样拷贝，没有压缩、没有依赖，产物直接可读可调试。
 */

import { readFile, writeFile, mkdir, rm, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

/**
 * 把 common 下的 ES module 转成挂在 window.__ZIMU__ 上的普通脚本。
 *
 * 转换规则非常克制，只处理这个项目实际用到的语法：
 *   export function foo(     -> function foo(
 *   export class Foo         -> class Foo
 *   export const X =         -> const X =
 * 末尾统一把导出的名字挂到命名空间上。
 */
function toClassicScript(moduleSource, exportNames, sourceFile = 'src/common/*.js') {
  // 生成的文件自带说明头，源码顶部的文件级注释就不必再复制一遍
  let code = moduleSource.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, '');
  const names = [];

  code = code.replace(/^export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/gm, (m, asyncKw, name) => {
    names.push(name);
    return `${asyncKw || ''}function ${name}`;
  });

  code = code.replace(/^export\s+class\s+([A-Za-z0-9_$]+)/gm, (m, name) => {
    names.push(name);
    return `class ${name}`;
  });

  code = code.replace(/^export\s+(const|let|var)\s+([A-Za-z0-9_$]+)/gm, (m, kind, name) => {
    names.push(name);
    return `${kind} ${name}`;
  });

  if (/^\s*export\s/m.test(code)) {
    throw new Error('transcript.js 里还有没被转换的 export 语法，请更新 build.mjs 的转换规则。');
  }

  const unique = [...new Set([...names, ...exportNames])];
  const attach = unique.map((name) => `  NS.${name} = ${name};`).join('\n');

  return `/**
 * 本文件由 tools/build.mjs 从 ${sourceFile} 自动生成，请勿手改。
 * 生成原因：content script 不支持 ES module，只能把公共逻辑转成普通脚本。
 */

(function () {
  const NS = (globalThis.__ZIMU__ = globalThis.__ZIMU__ || {});

${indent(code, 2)}

${attach}
})();
`;
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim() ? pad + line : line))
    .join('\n');
}

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const fromPath = path.join(from, entry.name);
    const toPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(fromPath, toPath);
    } else if (entry.isFile()) {
      await cp(fromPath, toPath);
    }
  }
}

/** 内容脚本里对公共逻辑的引用方式，改用命名空间，保持老写法也能用。 */
const TRANSCRIPT_EXPORTS = [
  'normalizeText',
  'isMeaningful',
  'dedupeAgainstPrevious',
  'dedupePrefixRatio',
  'splitIntoSegments',
  'SubtitleTrack',
  'toSRT',
  'toVTT',
  'toPlainText'
];

/**
 * 需要“内联成普通脚本”的公共模块。
 *
 * 内容脚本不支持 ES module，所以这些模块要在打包时转成挂在
 * window.__ZIMU__ 上的普通脚本，后台与内容脚本共用同一份源码。
 */
const CLASSIC_INLINE_MODULES = [
  { file: 'common/transcript.js', exports: TRANSCRIPT_EXPORTS, note: '字幕文本处理' },
  {
    file: 'common/binary.js',
    exports: ['bytesToBase64', 'base64ToBytes', 'bufferToBlob', 'describeBinary'],
    note: '跨进程二进制/base64 处理'
  },
  {
    /* 内容脚本要用 isLocalRelayUrl 提前判断“识别服务在不在本机”。
     *
     * 为什么非要内联：流式只有本机服务支持，而采集窗口的长度要在**开始录音前**
     * 就定下来。若不提前判断，云端用户会先按 1.6s 的流式切片录几秒，
     * 等后台回一句“不支持流式”再回滚——那几秒音频就白丢了。
     * 规则只保留一份（settings.js），在这里内联，避免两份实现跑偏。 */
    file: 'common/settings.js',
    exports: ['isLocalRelayUrl'],
    note: '供应商预设与本地地址判定'
  }
];

async function main() {
  if (existsSync(distDir)) await rm(distDir, { recursive: true, force: true });

  await copyDir(srcDir, distDir);

  // 逐个把公共模块转成内容脚本可用的普通脚本
  for (const entry of CLASSIC_INLINE_MODULES) {
    const source = await readFile(path.join(srcDir, entry.file), 'utf8');
    const classic = toClassicScript(source, entry.exports, `src/${entry.file}`);
    const outPath = path.join(distDir, 'content', path.basename(entry.file));
    await writeFile(outPath, classic, 'utf8');
  }

  // 更新 manifest：把生成的 transcript.js 插到最前面，
  // 其余内容脚本保持依赖顺序——capture 定义采集器，audio-source 决定音频来源，
  // overlay 提供叠加层，subtitles 最后做总控
  const manifestPath = path.join(distDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.content_scripts[0].js = [
    'content/transcript.js',
    'content/binary.js',
    'content/settings.js',
    'content/capture.js',
    'content/wav-encoder.js',
    'content/audio-source.js',
    'content/overlay.js',
    'content/subtitles.js'
  ];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // 把 src 里的 ES module 检查一遍，避免 background 里 import 路径写错
  await checkModuleImports(distDir);

  /* manifest 里引用的文件必须真实存在。
   * 少一个文件 Chrome 会拒绝加载整个扩展，而且报错很含糊，
   * 用户只会看到“加载已解压的扩展程序时出错”。提前拦住。 */
  const referenced = await checkManifestReferences(manifest, distDir);

  // 语法检查：扩展里写错一个括号，Chrome 只会静默不加载，很难查。
  // 这里在打包阶段就把它挡住。
  const checked = await validateSyntax(distDir);

  const files = await listFiles(distDir);
  console.log(`打包完成：${files.length} 个文件 -> ${path.relative(root, distDir)}`);
  console.log(`manifest 引用校验通过：${referenced} 个文件`);
  console.log(`语法检查通过（普通脚本 ${checked.classic} 个，ES module ${checked.module} 个）`);
  for (const f of files) console.log('  ' + path.relative(distDir, f));
}

/** 校验 manifest 引用的每个文件都存在。 */
async function checkManifestReferences(manifest, dir) {
  const paths = [];
  if (manifest.background?.service_worker) paths.push(manifest.background.service_worker);
  if (manifest.action?.default_popup) paths.push(manifest.action.default_popup);
  if (manifest.options_ui?.page) paths.push(manifest.options_ui.page);
  for (const entry of manifest.content_scripts || []) {
    paths.push(...(entry.js || []));
    paths.push(...(entry.css || []));
  }
  for (const entry of manifest.web_accessible_resources || []) {
    paths.push(...(entry.resources || []));
  }

  for (const relative of paths) {
    if (!existsSync(path.join(dir, relative))) {
      throw new Error(`manifest 引用了不存在的文件：${relative}`);
    }
  }
  return paths.length;
}

/**
 * 检查每个 JS 文件能否被解析。
 *
 * 内容脚本是普通脚本，service worker / popup 是 ES module，两者解析规则不同
 * （顶层 import 在普通脚本里就是语法错误），所以分开处理：
 *  - 普通脚本：vm.Script 直接解析；
 *  - ES module：必须交给真正的 module loader，用独立子进程 import 一遍。
 *    这里把“运行时报错”和“语法报错”严格区分开——popup 里 document 未定义
 *    属于运行时问题，不该让发布流程失败，但真正的语法错误必须让流程停下来。
 */
async function validateSyntax(dir) {
  const files = (await listFiles(dir)).filter((f) => f.endsWith('.js'));
  const classic = files.filter((f) => !isModuleFile(dir, f));
  const modules = files.filter((f) => isModuleFile(dir, f));

  for (const file of classic) {
    const relative = path.relative(dir, file);
    try {
      new vm.Script(await readFile(file, 'utf8'), { filename: relative });
    } catch (err) {
      throw new Error(`语法错误（普通脚本）${relative}：${err.message}`);
    }
  }

  if (modules.length) await validateModulesInChildProcess(dir, modules);

  return { classic: classic.length, module: modules.length };
}

function isModuleFile(dir, file) {
  const relative = path.relative(dir, file).split(path.sep).join('/');
  return (
    relative.startsWith('background/') || relative.startsWith('popup/') || relative.startsWith('common/')
  );
}

/** 在子进程里 import 每个 module：只把 SyntaxError 当作失败。 */
async function validateModulesInChildProcess(dir, modules) {
  const checker = path.join(here, 'check-modules.mjs');
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [checker, ...modules], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) {
    throw new Error(`ES module 语法检查未通过：\n${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** 简单校验：background 里 import 的相对路径必须真实存在。 */
async function checkModuleImports(dir) {
  const entry = path.join(dir, 'background', 'service-worker.js');
  const code = await readFile(entry, 'utf8');
  const specs = [...code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of specs) {
    const resolved = path.resolve(path.dirname(entry), spec);
    if (!existsSync(resolved)) {
      throw new Error(`service-worker.js 引用了不存在的模块：${spec}`);
    }
  }
  console.log(`已校验 background 的 ${specs.length} 个 import 路径`);
}

async function listFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out.sort();
}

main().catch((err) => {
  console.error('打包失败：', err.message);
  process.exit(1);
});
