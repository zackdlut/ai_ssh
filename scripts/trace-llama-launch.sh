#!/usr/bin/env bash
#
# 排查 llama-server（或任意常驻进程）是被谁、以什么方式拉起来的。
#
# 用法：
#   ./trace-llama-launch.sh                      # 默认查 llama-server / 端口 8123
#   ./trace-llama-launch.sh -p llama-server -P 8123
#   ./trace-llama-launch.sh -w 600               # 额外监控 600 秒，捕捉自动重启
#   ./trace-llama-launch.sh --audit              # 加装 auditd 规则，记录下次 exec 的父进程
#
# 建议用 sudo 运行：/proc/<pid>/environ、其他用户的 bash_history、auditd
# 都需要 root 才能读到。非 root 时脚本会跳过这些项并给出提示。

set -uo pipefail

PATTERN="llama-server"
PORT="8123"
WATCH_SECS=0
DO_AUDIT=0

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--pattern) PATTERN="${2:?}"; shift 2 ;;
    -P|--port)    PORT="${2:?}";    shift 2 ;;
    -w|--watch)   WATCH_SECS="${2:?}"; shift 2 ;;
    --audit)      DO_AUDIT=1; shift ;;
    -h|--help)    sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1（-h 查看用法）" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; Y=$'\033[33m'; G=$'\033[32m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; DIM=""; Y=""; G=""; R=""; N=""
fi

SELF=$$
SCRIPT_NAME=$(basename "$0")

SUDO=""
IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then
  IS_ROOT=1
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
  # 已缓存凭据就直接用，否则提示一次再试，避免脚本中途卡在密码提示上。
  if sudo -n true 2>/dev/null; then
    IS_ROOT=1
  else
    echo "${Y}需要 root 才能读取 environ / 他人 history，下面会请求一次 sudo 密码。${N}"
    if sudo -v; then IS_ROOT=1; else SUDO=""; fi
  fi
fi
[ "$IS_ROOT" -eq 1 ] || echo "${Y}警告：无 root 权限，部分检查将被跳过。${N}"

section() { printf '\n%s══ %s %s\n' "$B" "$1" "$N"; }
note()    { printf '   %s%s%s\n' "$DIM" "$1" "$N"; }
have()    { command -v "$1" >/dev/null 2>&1; }

# 统一输出：有结果就原样打印，没有就提示。grep 在遇到权限错误时会返回 2，
# 直接用 `|| note` 会误报，所以先把输出收进变量再判断。
show() {
  local out="$1"
  if [ -n "$out" ]; then printf '%s\n' "$out"; else note "无匹配"; fi
}

# 找目标进程。必须排除脚本自身及其父 shell —— 它们的命令行里含有 PATTERN，
# 否则 pgrep -f 会把自己也算进来，后面所有判断都会跑偏。
find_pids() {
  local raw p cl out=""
  raw=$(pgrep -f "$PATTERN.*$PORT" 2>/dev/null)
  [ -n "$raw" ] || raw=$(pgrep -f "$PATTERN" 2>/dev/null)
  for p in $raw; do
    [ "$p" = "$SELF" ] && continue
    cl=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)
    [ -n "$cl" ] || continue
    case "$cl" in
      *"$SCRIPT_NAME"*) continue ;;
      *pgrep*)          continue ;;
    esac
    out="$out$p"$'\n'
  done
  printf '%s' "$out" | sed '/^$/d'
}

# 只在可控范围内递归搜索。根目录、/usr 这类系统树会淹没输出且毫无意义。
is_searchable() {
  case "$1" in
    /|/usr|/usr/lib|/usr/lib64|/usr/local|/usr/bin|/usr/sbin|/usr/share|\
/bin|/sbin|/lib|/lib64|/etc|/var|/opt|/home|/data|/root|/proc|/sys|/dev|/tmp|/run)
      return 1 ;;
  esac
  [ -d "$1" ]
}

PIDS=$(find_pids)
LAUNCH_KIND="unknown"

section "1. 进程定位（pattern=$PATTERN port=$PORT）"
if [ -z "$PIDS" ]; then
  echo "${Y}当前没有匹配的进程在运行。${N}"
  note "进程可能已退出；后面的磁盘搜索仍然有效，可用于定位启动配置。"
else
  ps -o pid,ppid,uid,user,lstart,etime,rss,cmd -p "$(echo "$PIDS" | tr '\n' ',' | sed 's/,$//')" 2>/dev/null
fi

PID=$(echo "$PIDS" | head -1)
ENVDUMP=""

if [ -n "$PID" ]; then
  section "2. 进程身份"
  echo "${B}exe / cwd${N}"
  show "$($SUDO ls -l "/proc/$PID/exe" "/proc/$PID/cwd" 2>/dev/null)"
  note "cwd 通常就是当初执行启动命令 / 脚本的目录"

  echo
  echo "${B}完整命令行${N}"
  $SUDO cat "/proc/$PID/cmdline" 2>/dev/null | tr '\0' ' '; echo

  echo
  echo "${B}父进程链${N}"
  if have pstree; then
    pstree -sp "$PID" 2>/dev/null
  else
    walk="$PID"
    while [ -n "$walk" ] && [ "$walk" != "0" ]; do
      ps -o pid,ppid,cmd -p "$walk" --no-headers 2>/dev/null
      walk=$(ps -o ppid= -p "$walk" 2>/dev/null | tr -d ' ')
    done
  fi
  note "PPID=1 表示已被 init 收养（nohup/setsid/disown 或 systemd 服务），无法靠 ppid 直接追溯"

  echo
  echo "${B}cgroup${N}"
  show "$(cat "/proc/$PID/cgroup" 2>/dev/null)"

  echo
  echo "${B}关键环境变量${N}"
  if [ "$IS_ROOT" -eq 1 ]; then
    ENVDUMP=$($SUDO cat "/proc/$PID/environ" 2>/dev/null | tr '\0' '\n')
    show "$(printf '%s\n' "$ENVDUMP" | grep -E '^(INVOCATION_ID|JOURNAL_STREAM|SSH_CONNECTION|SSH_CLIENT|SSH_TTY|TMUX|STY|SUDO_USER|USER|LOGNAME|PWD|OLDPWD|CUDA_VISIBLE_DEVICES)=')"
  else
    note "跳过（需要 root）"
  fi

  section "3. 启动来源判定"
  CGROUP=$(cat "/proc/$PID/cgroup" 2>/dev/null)
  if printf '%s' "$ENVDUMP" | grep -q '^INVOCATION_ID=' || printf '%s' "$CGROUP" | grep -q 'system\.slice'; then
    LAUNCH_KIND="systemd"
    echo "${G}判定：systemd 服务拉起${N}"
    UNIT=$(printf '%s' "$CGROUP" | grep -oE '[a-zA-Z0-9@._-]+\.service' | head -1)
    [ -n "$UNIT" ] && echo "   单元：${B}$UNIT${N}"
    if have systemctl; then
      echo
      systemctl status --no-pager -n 0 "$PID" 2>/dev/null | head -8
      if [ -n "$UNIT" ]; then
        echo
        echo "${B}单元定义${N}"
        systemctl cat "$UNIT" --no-pager 2>/dev/null | head -40
        echo
        echo "${B}重启策略${N}"
        systemctl show "$UNIT" -p Restart -p RestartSec -p ExecStart -p User -p WorkingDirectory 2>/dev/null
      fi
    fi
  elif printf '%s' "$CGROUP" | grep -q 'user\.slice'; then
    LAUNCH_KIND="session"
    SESSION=$(printf '%s' "$CGROUP" | grep -oE 'session-[0-9]+' | head -1 | sed 's/session-//')
    echo "${G}判定：某个登录会话中手工启动${N}"
    if [ -n "$SESSION" ] && have loginctl; then
      echo
      loginctl session-status "$SESSION" --no-pager 2>/dev/null | head -12
    fi
    echo
    echo "${B}近期登录记录${N}"
    last -15 2>/dev/null
    echo
    echo "${B}存活的 tmux / screen 会话（进程可能挂在里面）${N}"
    show "$(ps -eo user,pid,cmd 2>/dev/null | grep -E 'tmux|SCREEN|screen ' | grep -v grep)"
  else
    echo "${Y}判定：无法从 cgroup / environ 确定，需要靠第 5、8 步（磁盘搜索 / exec 追踪）${N}"
  fi

  section "4. 端口占用与活跃连接"
  if have ss; then
    echo "${B}监听${N}"
    show "$($SUDO ss -ltnp 2>/dev/null | grep ":$PORT")"
    echo
    echo "${B}已建立的连接${N}"
    out=$($SUDO ss -tnp 2>/dev/null | grep ":$PORT")
    if [ -n "$out" ]; then printf '%s\n' "$out"; else note "无活跃连接（很可能是空跑占着显存）"; fi
  else
    note "未安装 ss，跳过"
  fi

  echo
  echo "${B}打开的日志文件（看最后写入时间可判断是否还在被调用）${N}"
  show "$($SUDO ls -l "/proc/$PID/fd" 2>/dev/null | grep -iE '\.log|\.out|\.txt' | head -10)"
else
  section "2-4. 跳过（进程未运行）"
fi

section "5. 磁盘搜索：启动脚本与服务定义"
# 从活着的进程里提取更多搜索锚点（模型文件名等），提高命中率。
ANCHORS=("$PATTERN" "$PORT")
if [ -n "$PID" ]; then
  for tok in $($SUDO cat "/proc/$PID/cmdline" 2>/dev/null | tr '\0' '\n'); do
    case "$tok" in
      */*.gguf) ANCHORS+=("$(basename "$tok")") ;;
    esac
  done
fi
note "搜索锚点：${ANCHORS[*]}"
GREP_PAT=$(printf '%s|' "${ANCHORS[@]}" | sed 's/|$//')

echo
echo "${B}systemd 单元文件${N}"
show "$($SUDO grep -rIlE "$GREP_PAT" \
  /etc/systemd/system/ /lib/systemd/system/ /usr/lib/systemd/system/ \
  /home/*/.config/systemd/ /root/.config/systemd/ 2>/dev/null)"

echo
echo "${B}名字可疑的 systemd 单元${N}"
if have systemctl; then
  show "$(systemctl list-units --all --no-pager --no-legend 2>/dev/null | grep -iE 'llama|coder|qwen|sft')"
else
  note "跳过"
fi

echo
echo "${B}systemd 定时器${N}"
if have systemctl; then
  show "$(systemctl list-timers --all --no-pager --no-legend 2>/dev/null | head -15)"
else
  note "跳过"
fi

echo
echo "${B}cron${N}"
show "$($SUDO grep -rIlE "$GREP_PAT" /etc/cron.d/ /etc/crontab /var/spool/cron/ 2>/dev/null)"
if [ "$IS_ROOT" -eq 1 ]; then
  while IFS=: read -r u _; do
    out=$($SUDO crontab -l -u "$u" 2>/dev/null | grep -E "$GREP_PAT")
    [ -n "$out" ] && printf '   %s: %s\n' "$u" "$out"
  done < /etc/passwd
fi

echo
echo "${B}开机自启的其他位置${N}"
show "$($SUDO grep -rIlE "$GREP_PAT" \
  /etc/rc.local /etc/rc.d/ /etc/init.d/ /etc/profile.d/ /etc/xdg/autostart/ 2>/dev/null)"

echo
echo "${B}shell 历史（原始启动命令常常在这里）${N}"
if [ "$IS_ROOT" -eq 1 ]; then
  show "$($SUDO grep -nE "$GREP_PAT" /home/*/.bash_history /home/*/.zsh_history /root/.bash_history 2>/dev/null | tail -20)"
else
  show "$(grep -nE "$GREP_PAT" ~/.bash_history ~/.zsh_history 2>/dev/null | tail -20)"
  note "仅当前用户；用 sudo 重跑可覆盖所有用户"
fi

echo
echo "${B}进程工作目录 / 安装目录下的脚本${N}"
SEARCH_DIRS=()
if [ -n "$PID" ]; then
  d=$($SUDO readlink "/proc/$PID/cwd" 2>/dev/null)
  is_searchable "${d:-}" && SEARCH_DIRS+=("$d")
  e=$($SUDO readlink "/proc/$PID/exe" 2>/dev/null)
  if [ -n "$e" ]; then
    root=$(dirname "$(dirname "$e")")   # .../build/bin/llama-server -> .../build
    root=$(dirname "$root")             # -> 项目根，例如 /data/unsloth/llama.cpp
    is_searchable "$root" && SEARCH_DIRS+=("$root")
  fi
fi
if [ ${#SEARCH_DIRS[@]} -gt 0 ]; then
  note "目录：${SEARCH_DIRS[*]}"
  show "$($SUDO grep -rInE "$GREP_PAT" \
    --include='*.sh' --include='*.py' --include='*.yaml' --include='*.yml' \
    --include='*.service' --include='*.conf' --include='Makefile' \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=CMakeFiles \
    "${SEARCH_DIRS[@]}" 2>/dev/null | head -30)"
else
  note "进程未运行或目录不适合递归搜索，跳过"
fi

section "6. 其他守护 / 编排工具"
if have docker; then
  show "$(docker ps -a 2>/dev/null | grep -iE 'llama|qwen|coder')"
else
  note "未安装 docker"
fi
if have supervisorctl; then
  show "$($SUDO supervisorctl status 2>/dev/null | grep -iE 'llama|qwen|coder')"
else
  note "未安装 supervisor"
fi
if have pm2; then
  show "$(pm2 list 2>/dev/null | grep -iE 'llama|qwen|coder')"
else
  note "未安装 pm2"
fi

section "7. 显存归属"
if have nvidia-smi; then
  nvidia-smi --query-compute-apps=pid,used_memory,process_name --format=csv 2>/dev/null
  echo
  nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv 2>/dev/null
  note "对照上面的 PID，确认是哪个进程占着显存"
else
  note "未安装 nvidia-smi"
fi

if [ "$DO_AUDIT" -eq 1 ]; then
  section "8. 加装 exec 审计规则"
  if [ "$IS_ROOT" -ne 1 ]; then
    echo "${R}需要 root，跳过。${N}"
  elif ! have auditctl; then
    echo "${Y}未安装 auditd：apt install auditd${N}"
    note "替代方案：sudo execsnoop-bpfcc | grep -i llama   或   sudo forkstat -e exec | grep -i llama"
  else
    TARGET=""
    [ -n "$PID" ] && TARGET=$($SUDO readlink "/proc/$PID/exe" 2>/dev/null)
    if [ -z "$TARGET" ] || [ ! -e "$TARGET" ]; then
      echo "${Y}拿不到可执行文件路径，请手动指定后再执行：${N}"
      echo "   sudo auditctl -w /path/to/llama-server -p x -k llamahunt"
    else
      $SUDO auditctl -w "$TARGET" -p x -k llamahunt && echo "${G}已监控 exec：$TARGET${N}"
      echo
      note "等它下次被拉起后，用这条命令查看（重点看 ppid= 和 auid=）："
      echo "   sudo ausearch -k llamahunt -i | tail -50"
      note "查完记得移除规则："
      echo "   sudo auditctl -W \"$TARGET\" -p x -k llamahunt"
    fi
  fi
fi

if [ "$WATCH_SECS" -gt 0 ]; then
  section "9. 重启监控（${WATCH_SECS}s）"
  note "PID 发生变化即说明有东西在自动重启它；Ctrl-C 可提前结束"
  LAST="$PIDS"
  END=$(( $(date +%s) + WATCH_SECS ))
  while [ "$(date +%s)" -lt "$END" ]; do
    sleep 2
    NOW=$(find_pids)
    if [ "$NOW" != "$LAST" ]; then
      printf '%s [变化] %s -> %s\n' "$(date '+%H:%M:%S')" "$(echo "${LAST:-none}" | tr '\n' ' ')" "$(echo "${NOW:-none}" | tr '\n' ' ')"
      for p in $NOW; do
        case " $(echo "$LAST" | tr '\n' ' ') " in
          *" $p "*) ;;
          *)
            echo "   新进程："
            ps -o pid,ppid,uid,user,lstart,cmd -p "$p" --no-headers 2>/dev/null
            sed 's/^/   cgroup: /' "/proc/$p/cgroup" 2>/dev/null
            ;;
        esac
      done
      LAST="$NOW"
    fi
  done
  echo "监控结束。"
fi

section "结论与下一步"
case "$LAUNCH_KIND" in
  systemd)
    echo "由 systemd 管理。停止并禁止自启："
    echo "   sudo systemctl stop <unit> && sudo systemctl disable <unit>"
    ;;
  session)
    echo "由某人在登录会话中手工启动。先按上面的 last / tmux 线索找到人再沟通，"
    echo "确认无人使用后再 kill；若 kill 后又出现，说明另有守护，改用 --audit 追踪。"
    ;;
  *)
    echo "尚未定性。建议："
    echo "   1) 用 root 重跑本脚本，补上 environ 与他人 history 的检查"
    echo "   2) 加 --audit 装上审计规则，等它下次重启后 ausearch 查 ppid/auid"
    echo "   3) 加 -w 600 监控一段时间，确认是否真的在自动重启"
    ;;
esac
echo
echo "停掉后验证显存已释放，并让 Ollama 重新加载："
echo "   nvidia-smi && ollama stop <model> && ollama run <model> 'hi' && ollama ps"
