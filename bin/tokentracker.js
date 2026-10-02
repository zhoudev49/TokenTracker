#!/usr/bin/env node
"use strict";

// npx / global entry for TokenTracker.
// Resolves CLI flags into environment variables, then spawns the compiled
// server (dist/src/server.js) so the `require.main === module` guard in the
// server still fires. The database defaults to ~/.token-tracker so that an
// npx-installed copy does not write into the npm cache directory.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const HELP = `TokenTracker — 本地 AI 编码工具 Token 用量仪表盘

用法:
  npx @zhoudev49/tokentracker [选项]
  tokentracker [选项]

选项:
  -p, --port <端口>       监听端口 (默认 3000)
  -h, --host <地址>       监听地址 (默认 127.0.0.1)
  -d, --data-dir <路径>   数据库目录 (默认 ~/.token-tracker)
      --help              显示本帮助并退出

启动后访问 http://127.0.0.1:<端口>
环境变量 PORT / HOST / TOKEN_TRACKER_DATA_DIR 同样生效，命令行参数优先。
`;

function parseArgs(argv) {
  const overrides = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eqIdx = arg.indexOf("=");
    let key = arg;
    let inlineVal;
    if (arg.startsWith("--") && eqIdx > 0) {
      key = arg.slice(0, eqIdx);
      inlineVal = arg.slice(eqIdx + 1);
    }
    const next = () => (inlineVal !== undefined ? inlineVal : argv[++i]);
    switch (key) {
      case "-p":
      case "--port":
        overrides.PORT = String(next());
        break;
      case "-h":
      case "--host":
        overrides.HOST = next();
        break;
      case "-d":
      case "--data-dir":
        overrides.TOKEN_TRACKER_DATA_DIR = path.resolve(next());
        break;
      case "--help":
      case "-?":
        process.stdout.write(HELP);
        process.exit(0);
      default:
        if (key.startsWith("-")) rest.push(arg);
        break;
    }
  }
  return { overrides, rest };
}

const { overrides, rest } = parseArgs(process.argv.slice(2));

if (!overrides.TOKEN_TRACKER_DATA_DIR && !process.env.TOKEN_TRACKER_DATA_DIR) {
  overrides.TOKEN_TRACKER_DATA_DIR = path.join(os.homedir(), ".token-tracker");
}

const serverPath = path.join(__dirname, "..", "dist", "src", "server.js");
if (!fs.existsSync(serverPath)) {
  process.stderr.write(
    "TokenTracker 尚未编译。请先运行 `npm run build`，或安装已发布的 npm 包。\n"
  );
  process.exit(1);
}

const childEnv = Object.assign({}, process.env, overrides);
if (rest.length) childEnv.TT_PASSTHROUGH_ARGS = rest.join(" ");

const child = spawn(process.execPath, [serverPath], {
  env: childEnv,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code === null ? 1 : code);
  }
});
