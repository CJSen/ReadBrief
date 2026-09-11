#!/usr/bin/env node
// 单一版本源:根目录 .version。构建时把版本同步到 tauri.conf.json、Cargo.toml 与 README.md,
// 保证打包产物、Rust crate、关于页 getVersion()、README 徽章全部来自同一处。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const version = readFileSync(resolve(root, ".version"), "utf8").trim();
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[sync-version] .version 格式无效: "${version}"（应为 x.y.z）`);
  process.exit(1);
}

// 1) tauri.conf.json —— 决定打包产物版本(getVersion / dmg 版本号)
const confPath = resolve(root, "src-tauri/tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
if (conf.version !== version) {
  conf.version = version;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
  console.log(`[sync-version] tauri.conf.json -> ${version}`);
} else {
  console.log(`[sync-version] tauri.conf.json 已是最新 (${version})`);
}

// 2) Cargo.toml —— 保持 Rust crate 版本一致
const cargoPath = resolve(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const next = cargo.replace(/^version = ".*"$/m, `version = "${version}"`);
if (next !== cargo) {
  writeFileSync(cargoPath, next);
  console.log(`[sync-version] Cargo.toml -> ${version}`);
} else {
  console.log(`[sync-version] Cargo.toml 已是最新 (${version})`);
}

// 3) Cargo.lock —— 让本地 crate 版本与 Cargo.toml 对齐
//    Cargo.lock 只能由 cargo 自身写入。调用 cargo update 同步 readbrief 的版本,
//    避免「脚本改了 Cargo.toml、但 lock 仍停在旧版本」导致提交 / --locked 构建不一致。
const cargoLockPath = resolve(root, "src-tauri/Cargo.lock");
let lockVersion = null;
if (existsSync(cargoLockPath)) {
  const lock = readFileSync(cargoLockPath, "utf8");
  const m = lock.match(/name = "readbrief"\r?\nversion = "([^"]+)"/);
  if (m) lockVersion = m[1];
}
if (lockVersion !== version) {
  try {
    execSync(`cargo update -p readbrief --precise ${version}`, {
      cwd: resolve(root, "src-tauri"),
      stdio: "pipe",
    });
    console.log(`[sync-version] Cargo.lock -> ${version}`);
  } catch (e) {
    console.warn(
      `[sync-version] 未能同步 Cargo.lock（请确认 cargo 可用）: ${
        e.stderr?.toString().trim() || e.message
      }`
    );
  }
} else {
  console.log(`[sync-version] Cargo.lock 已是最新 (${version})`);
}

// 4) README.md —— 版本徽章（badge/version-x.y.z-orange）
const readmePath = resolve(root, "README.md");
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, "utf8");
  const nextReadme = readme.replace(
    /(badge\/version-)\d+\.\d+\.\d+/g,
    `$1${version}`
  );
  if (nextReadme !== readme) {
    writeFileSync(readmePath, nextReadme);
    console.log(`[sync-version] README.md -> ${version}`);
  } else {
    console.log(`[sync-version] README.md 已是最新 (${version})`);
  }
} else {
  console.warn("[sync-version] 未找到 README.md，跳过");
}
