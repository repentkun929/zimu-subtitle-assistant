#!/usr/bin/env node
/**
 * 在独立进程里 import 一批 ES module，只用来验证“语法是否合法”。
 *
 * 单独放一个文件的原因：popup.js 在被 import 时就会去碰 document，
 * 在 Node 里必然抛 ReferenceError。这类运行时错误不该判定为语法错误，
 * 所以这里把它捕获并忽略；只有 SyntaxError 才让进程以非 0 退出。
 *
 * 由 tools/build.mjs 调用，一般不单独执行。
 */

const files = process.argv.slice(2);
let syntaxErrors = 0;

for (const file of files) {
  try {
    await import(new URL(`file://${file.replace(/\\/g, '/')}`).href);
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`语法错误 ${file}：${err.message}`);
      syntaxErrors++;
    }
    // 其他错误（缺少 DOM、缺少 chrome API）属于运行环境问题，忽略
  }
}

if (syntaxErrors > 0) {
  console.error(`共 ${syntaxErrors} 个文件存在语法错误。`);
  process.exit(1);
}
process.exit(0);
