#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 只读探查：/opt/dbee-gateway 运行的代码是否包含 0039 安全修复
# ═══════════════════════════════════════════════════════════════════════
# 判定方式：
#   ① 每个修复文件 grep 特征串（只有新版才有的标识符）
#   ② systemd 进程启动时间 vs 代码文件 mtime —— 文件比进程新 = 修复未加载
#   ③ healthz 探活 + 运行中进程的 cmdline 确认
# 不做任何写操作。
set -uo pipefail

SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@"; }

APP=/opt/dbee-gateway
LIB=$APP/lib

echo "═══ A) 部署目录与运行状态 ═══"
if [ ! -d "$APP" ]; then
  echo "!! $APP 不存在 —— 网关从未部署或路径不同"
  SUDO systemctl status dbee-gateway --no-pager -n 5 2>/dev/null || echo "(无 dbee-gateway 服务)"
  exit 0
fi
ls -la "$APP" | head -8
echo
echo "-- systemd 服务 --"
SUDO systemctl is-active dbee-gateway
SUDO systemctl show dbee-gateway -p ActiveEnterTimestamp -p ExecMainPID -p FragmentPath 2>/dev/null
PID=$(SUDO systemctl show dbee-gateway -p ExecMainPID --value 2>/dev/null)
echo "PID=$PID"
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  echo "-- 进程启动时间（/proc）--"
  ps -o pid,lstart,etime,cmd -p "$PID"
fi

echo
echo "═══ B) 代码文件 mtime（与进程启动时间对比）═══"
ls -la --time-style=full-iso "$LIB"/*.mjs 2>/dev/null | awk '{print $6, $7, $9}'

echo
echo "═══ C) 0039 修复特征串探针 ═══"
probe() { # probe <file> <pattern> <desc>
  local f="$1" pat="$2" desc="$3"
  if [ ! -f "$f" ]; then echo "  MISSING  $f"; return; fi
  if grep -qE "$pat" "$f"; then
    echo "  ✓ NEW    $desc"
  else
    echo "  ✗ OLD    $desc  （文件存在但无特征串 → 旧版）"
  fi
}
# http.mjs：XFF 信任边界
probe "$LIB/http.mjs"    'isTrustedPeer'                 '⑤ XFF 可信代理判定 isTrustedPeer（http.mjs）'
probe "$LIB/http.mjs"    'trustedProxies'                '⑤ clientIp 接受 trustedProxies 选项（http.mjs）'
# config.mjs：0039 新配置项
probe "$LIB/config.mjs"  'llmGateEnabled'                '③ llmGateEnabled 配置（config.mjs）'
probe "$LIB/config.mjs"  'appleAllowedEnvs'              '④ appleAllowedEnvs 环境白名单（config.mjs）'
probe "$LIB/config.mjs"  'trustedProxyIps'               '⑤ trustedProxyIps 配置（config.mjs）'
probe "$LIB/config.mjs"  'llmMaxConcurrentStreams'       '③ llmMaxConcurrentStreams 配置（config.mjs）'
# llm.mjs：服务端权益闸门
probe "$LIB/llm.mjs"     'llm_gate'                      '③ llm_gate 数据库闸门调用（llm.mjs）'
probe "$LIB/llm.mjs"     'fallbackLimiter'               '③ 包装识别兜底日限额（llm.mjs）'
probe "$LIB/llm.mjs"     'activeStreams'                 '⑤ 并发流上限计数（llm.mjs）'
probe "$LIB/llm.mjs"     'AbortSignal\.any'              '⑤ 断连+超时合并取消 AbortSignal.any（llm.mjs）'
probe "$LIB/llm.mjs"     'validateInput'                 '③ 输入规模校验 validateInput（llm.mjs）'
# iap.mjs：Apple 环境白名单
probe "$LIB/iap.mjs"     'environment_mismatch'          '④ 收据环境白名单 environment_mismatch（iap.mjs）'
probe "$LIB/iap.mjs"     'appleAllowedEnvs'              '④ 白名单校验引用（iap.mjs）'
# db.mjs：withUserIdentity
probe "$LIB/db.mjs"      'withUserIdentity'              '③ withUserIdentity GUC 注入（db.mjs）'
# dbproxy.mjs：流式透传 + AbortController
probe "$LIB/dbproxy.mjs" 'getReader'                     '⑤ 响应流式透传 getReader（dbproxy.mjs）'
probe "$LIB/dbproxy.mjs" "res\.on\('close'"              '⑤ 客户端断连 AbortController（dbproxy.mjs）'
# app.mjs：LLM 注入业务池 + clientIp 白名单
probe "$LIB/app.mjs"     'usageLimiter, pool'            '③ LLM 处理器注入 dbee_app 业务池（app.mjs）'
probe "$LIB/app.mjs"     'trustedProxies'                '⑤ 限流 ipKey 走 clientIp 白名单（app.mjs）'

echo
echo "═══ D) healthz 与运行时行为 ═══"
curl -sf -m 5 http://127.0.0.1:8080/.cloud/healthz | head -c 600
echo
echo "-- 最近 15 行网关日志（找 llm_gate / environment 相关运行痕迹）--"
SUDO journalctl -u dbee-gateway --no-pager -n 15 2>/dev/null | tail -15

echo
echo "═══ E) 数据库侧 0039/0040 快速复核 ═══"
SUDO -u postgres psql -d dbee -tAc "
SELECT 'llm_gate: ' || (SELECT count(*) FROM pg_proc WHERE proname='llm_gate')
    || ' | honey_balance: ' || (SELECT count(*) FROM pg_proc WHERE proname='honey_balance')
    || ' | leaderboard_cache: ' || (SELECT count(*) FROM pg_class WHERE relname='leaderboard_cache')
    || ' | grant_honey: ' || (SELECT count(*) FROM pg_proc WHERE proname='grant_honey')
"
SUDO -u postgres psql -d dbee -tAc "
SELECT 'migrations: ' || coalesce(string_agg(version, ',' ORDER BY version), '(none)')
FROM schema_migrations WHERE version IN ('0039','0040')
" 2>/dev/null || echo "(schema_migrations 表不可读或不存在)"

echo
echo "═══ 探查完成 ═══"
