#!/usr/bin/env node
// 单一版本源:根目录 .version。构建时把版本同步到 tauri.conf.json 与 Cargo.toml,
// 保证打包产物、Rust crate、关于页 getVersion() 全部来自同一处。
import { readFileSync, writeFileSync } from "node:fs";
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
