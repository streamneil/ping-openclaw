#!/bin/bash
# Openclaw 协议探查脚本

BASE="/Users/neil/.npm-global/lib/node_modules/openclaw"

echo "======== 1. docs 目录 ========"
ls "$BASE/docs/" 2>/dev/null
cat "$BASE/docs/"*.md 2>/dev/null | head -300

echo ""
echo "======== 2. dist 目录结构 ========"
ls "$BASE/dist/"

echo ""
echo "======== 3. 搜索 webchat/gateway/chat 相关 mjs 文件 ========"
find "$BASE/dist" -name "*.mjs" | grep -v node_modules | xargs grep -l "webchat\|gateway\|chat/send\|chat/message\|sendMessage" 2>/dev/null

echo ""
echo "======== 4. gateway 路由处理（关键：method 名称列表）========"
find "$BASE/dist" -name "*.mjs" | grep -v node_modules | xargs grep -h "method\|webchat\|chat/\|'send'\|\"send\"" 2>/dev/null | grep -v "^[[:space:]]*//" | sort -u | head -80

echo ""
echo "======== 5. webchat 相关完整代码段 ========"
find "$BASE/dist" -name "*.mjs" | grep -v node_modules | xargs grep -h -A5 -B2 "webchat\|chat/send\|chat/message" 2>/dev/null | head -150

echo ""
echo "======== 6. README ========"
cat "$BASE/README.md" 2>/dev/null | head -200
