# 官网下载页 / 更新日志自动化

## 已完成（全链自动化，发版后无需手改官网）

**痛点**：每次发版后官网下载页仍是旧版本链接（需额外手动改一次），且更新日志手抄在下载页、随版本累积无限膨胀。

**方案**：让官网在构建时自动消费发版事实源（GitHub Release），由 CI 在发布完成后触发官网重建，闭环自动刷新。

### CI 侧（`.github/`）
- `changelog_lib.py`（新建）：共享的 Conventional Commits 解析逻辑，单一来源（type → 中文 label）。
- `gen-release-notes.py`（改造）：复用 `changelog_lib`，输出与旧版逐字节一致。
- `gen-latest-json.py`（新建）：读取 `GITHUB_REF_NAME` + 回查的真实资产 `RB_ASSETS_JSON`，生成固定名 `latest.json`（版本号 / 变更分组 / 两架构 dmg 真实直链 + 体积）；缺 dmg 则 `exit(1)` 阻止发布错误清单。
- `workflows/release.yml`（改造）：新增 `concurrency: group: release`；`publish-release` job 增加「Collect assets → Generate latest.json → 幂等上传 latest.json → Publish release → Trigger docs site rebuild」；仅正式版（`prerelease == false`）才 POST Cloudflare Deploy Hook。

### 官网侧（`docs/site/`）
- `.vitepress/data/release.data.ts`（新建）：VitePress data loader，构建时 Node 端 fetch `latest.json`（CDN 永久地址，天然跳过 prerelease）+ Releases API（最近 5 版），网络不可达时降级本地 `.version` + 引导去 Releases 页面，绝不抛异常。
- `.vitepress/theme/components/DownloadCards.vue`（新建）：版本号 / dmg 直链 / 体积 / 「本次更新」要点全部数据驱动；缺 asset 时降级到 Releases 页。
- `.vitepress/theme/components/ChangelogList.vue`（新建）：独立更新日志页，展示最近 5 版分组变更。
- `download.md`（改造）：改用 `<DownloadCards />`，删除硬编码版本号与手抄更新日志，保留公证提示与「从源码构建」。
- `changelog.md`（新建）：`<ChangelogList />` + 更早版本链 GitHub。
- `.vitepress/config.ts`（改造）：导航新增「更新日志」。
- `.vitepress/theme/index.ts`（改造）：注册 `DownloadCards` 与 `ChangelogList`。

## 待你本地验证
```bash
cd docs/site
npm run docs:dev      # 热更新预览（含 data loader 真实抓取）
# 或
npm run docs:build    # 生产构建，验证 data loader 抓取与产物
```
> 注意：构建/部署请在本地终端执行（沙箱会拦截对 `docs/site/.vitepress/dist/` 的写入）。
> 首次在尚无任何 `latest.json` 的仓库下构建会走降级（按钮指向 Releases 页）；发布首个走新 CI 的正式版后，官网即自动点亮。

## 未做（用户要求先不动）
- `src/lib/update/checkUpdate.ts` 暂不切到 `latest.json`，仍直连 GitHub Releases API。
