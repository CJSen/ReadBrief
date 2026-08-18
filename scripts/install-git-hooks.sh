#!/bin/sh
# 把 scripts/git-hooks/ 下的钩子安装到 .git/hooks/（加执行权限）。
# 钩子源文件进版本库，本脚本在 clone/重装后执行一次即可：
#   sh scripts/install-git-hooks.sh
set -e

ROOT="$(git rev-parse --show-toplevel)"
SRC="$ROOT/scripts/git-hooks"
DEST="$ROOT/.git/hooks"

[ -d "$SRC" ] || { echo "未找到钩子目录: $SRC"; exit 1; }
[ -d "$DEST" ] || mkdir -p "$DEST"

installed=0
for f in "$SRC"/*; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  cp "$f" "$DEST/$name"
  chmod +x "$DEST/$name"
  echo "已安装 .git/hooks/$name"
  installed=$((installed + 1))
done

[ "$installed" -gt 0 ] || { echo "scripts/git-hooks 下没有钩子文件"; exit 1; }
echo "Git 钩子安装完成。"
