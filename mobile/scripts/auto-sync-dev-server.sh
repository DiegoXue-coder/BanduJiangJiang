#!/bin/bash
# 自动同步开发服务器脚本——给需要"一直挂着"的开发机用（比如华为电脑24小时
# 服务这台），不用每次手动重启才能拿到最新代码。
#
# 原理很简单：轮询而不是推送触发（webhook需要把这台机器暴露到公网接收
# GitHub回调，对一台开发机来说太重，轮询完全够用）——每隔一段时间对比
# 一次远程仓库的最新commit，发现变化就拉取、按需装依赖、重启Expo开发
# 服务器，让服务器上跑的代码跟git上的最新代码保持一致。
#
# 用法：
#   ./mobile/scripts/auto-sync-dev-server.sh [轮询间隔秒数] [lan|tunnel]
#   默认60秒轮询一次、用tunnel模式（不需要同WiFi，适合24小时挂着用）
#
# 用 Ctrl+C 停止——会顺带杀掉当前拉起的开发服务器子进程，不会留孤儿进程。

set -e
cd "$(dirname "$0")/../.."  # 回到仓库根目录

POLL_INTERVAL="${1:-60}"
MODE="${2:-tunnel}"

if [[ "$MODE" != "lan" && "$MODE" != "tunnel" ]]; then
  echo "模式只能是 lan 或 tunnel，收到的是: $MODE" >&2
  exit 1
fi

SERVER_PID=""

start_server() {
  echo "[$(date '+%H:%M:%S')] 启动 Expo 开发服务器（$MODE 模式）..."
  npm --prefix mobile run "$MODE" &
  SERVER_PID=$!
}

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] 停止旧服务器进程 (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}

cleanup() {
  echo "[$(date '+%H:%M:%S')] 收到退出信号，清理中..."
  stop_server
  exit 0
}
trap cleanup INT TERM

git fetch origin main --quiet
LAST_COMMIT="$(git rev-parse origin/main)"
echo "[$(date '+%H:%M:%S')] 当前已是最新提交 ${LAST_COMMIT:0:7}"
start_server

while true; do
  sleep "$POLL_INTERVAL"
  git fetch origin main --quiet
  NEW_COMMIT="$(git rev-parse origin/main)"
  if [ "$NEW_COMMIT" != "$LAST_COMMIT" ]; then
    echo "[$(date '+%H:%M:%S')] 检测到新提交 ${NEW_COMMIT:0:7}（原 ${LAST_COMMIT:0:7}），开始同步..."
    stop_server
    # 拉取前不检查本地脏改动——这台机器只用来跑开发服务器，不应该有未提交
    # 的本地改动；如果真有，git pull失败会让脚本在下面的set -e处直接退出，
    # 不会静默覆盖，需要人工去处理冲突
    git pull origin main
    npm --prefix mobile install
    start_server
    LAST_COMMIT="$NEW_COMMIT"
    echo "[$(date '+%H:%M:%S')] 同步完成，服务器已用最新代码重启"
  fi
done
