#!/bin/bash
# Installer untuk command global 'tim-hermes-saya' — Hermes Hub di ~/hermes-hub (bun run server.ts, port 3456)
# Pola mengikuti install-cli.sh yang sudah ada
BIN_TARGET="/home/salahudin/.local/bin/tim-hermes-saya"

mkdir -p /home/salahudin/.local/bin

cat << 'EOF' > "$BIN_TARGET"
#!/bin/bash
# tim-hermes-saya — CLI Hermes Hub (bun run server.ts, port 3456) dari direktori mana pun
HUB_DIR="/home/salahudin/hermes-hub"
BUN="/home/salahudin/.bun/bin/bun"
VERSION="1.1.0"
PORT="3456"
PIDFILE="$HUB_DIR/data/tim-hermes-saya.pid"
LOGFILE="$HUB_DIR/server.log"
URL="http://localhost:$PORT"

# why: PID file satu-satunya sumber kebenaran proses daemon agar stop tidak pernah kill proses lain
pid_alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
daemon_pid() { [ -f "$PIDFILE" ] && cat "$PIDFILE" 2>/dev/null | tr -d '[:space:]'; }
http_ok() { curl -s --max-time 2 -o /dev/null "$URL" 2>/dev/null; }

do_status() {
  local pid http_rc=1
  pid="$(daemon_pid)"
  http_ok && http_rc=0
  if [ -n "$pid" ] && pid_alive "$pid"; then
    if [ "$http_rc" -eq 0 ]; then echo "✅ Hermes Hub berjalan (PID $pid, HTTP $URL OK)"; else echo "⚠️ Daemon hidup (PID $pid) tapi HTTP belum siap di $URL"; fi
    return 0
  fi
  if [ "$http_rc" -eq 0 ]; then echo "✅ Hermes Hub menjawab di $URL (tanpa pidfile — mungkin jalan manual/foreground)"; return 0; fi
  echo "❌ Hermes Hub mati (tidak ada daemon, $URL tidak menjawab)"
  return 1
}

# why: setsid+nohup agar daemon tetap hidup setelah terminal ditutup
do_start_daemon() {
  local pid
  pid="$(daemon_pid)"
  if [ -n "$pid" ] && pid_alive "$pid"; then echo "✅ Sudah berjalan (PID $pid) — $URL"; return 0; fi
  [ -f "$PIDFILE" ] && rm -f "$PIDFILE" # why: bersihkan pidfile basi sebelum start baru
  [ -d "$HUB_DIR" ] || { echo "❌ ~/hermes-hub tidak ditemukan"; return 1; }
  mkdir -p "$(dirname "$PIDFILE")"
  touch "$LOGFILE"
  cd "$HUB_DIR" || { echo "❌ Gagal masuk $HUB_DIR"; return 1; }
  setsid nohup "$BUN" run server.ts >>"$LOGFILE" 2>&1 < /dev/null &
  echo "$!" > "$PIDFILE"
  sleep 1
  pid="$(daemon_pid)"
  if pid_alive "$pid"; then echo "✅ Daemon mulai (PID $pid) — log: $LOGFILE"; else echo "❌ Gagal start, cek $LOGFILE"; rm -f "$PIDFILE"; return 1; fi
}

do_stop() {
  local pid i
  [ -f "$PIDFILE" ] || { echo "ℹ️ Daemon tidak berjalan (tidak ada pidfile)"; return 0; }
  pid="$(daemon_pid)"
  if [ -z "$pid" ] || ! pid_alive "$pid"; then echo "ℹ️ Stale pidfile, dibersihkan"; rm -f "$PIDFILE"; return 0; fi
  kill "$pid" 2>/dev/null # why: SIGTERM dulu agar sqlite/bun shutdown rapi
  for i in $(seq 1 50); do pid_alive "$pid" || break; sleep 0.1; done
  pid_alive "$pid" && kill -9 "$pid" 2>/dev/null # why: paksa hanya bila PID sendiri masih bandel
  rm -f "$PIDFILE"
  echo "✅ Daemon berhenti (PID $pid)"
}

do_logs() {
  [ -f "$LOGFILE" ] || { echo "❌ Belum ada log di $LOGFILE"; return 1; }
  case "$1" in -f|--follow) tail -f -n 100 "$LOGFILE";; *) tail -n 100 "$LOGFILE";; esac
}

do_tray() {
  local pid
  pid="$(daemon_pid)"
  if ! { [ -n "$pid" ] && pid_alive "$pid"; } && ! http_ok; then do_start_daemon || return 1; fi
  if ! command -v yad >/dev/null 2>&1; then # why: fallback non-tray agar tetap berguna tanpa dependensi baru
    command -v notify-send >/dev/null 2>&1 && notify-send "🌸 Hermes Hub" "Berjalan di $URL (mode daemon, tanpa tray icon)"
    echo "ℹ️ yad belum terpasang — daemon tetap jalan di $URL"
    echo "   Install tray backend: sudo pacman -S yad   # CachyOS/Arch"
    echo "                     atau: sudo apt install yad  # Debian/Ubuntu"
    return 0
  fi
  # why: setsid agar tray icon lepas dari terminal (hide-to-tray)
  setsid nohup yad --notification --image="applications-internet" --text="🌸 Hermes Hub — $URL" \
    --command="xdg-open $URL" \
    --menu="Buka Dashboard!xdg-open $URL|Status!sh -c 'tim-hermes-saya status && notify-send \"Hermes Hub\" \"Hidup\" || notify-send \"Hermes Hub\" \"Mati\"'|Logs!sh -c 'konsole -e \"tail -f $LOGFILE\" 2>/dev/null || xterm -e \"tail -f $LOGFILE\" 2>/dev/null || xdg-open $LOGFILE'|Restart!tim-hermes-saya restart|Stop & Keluar Tray!sh -c 'tim-hermes-saya stop; pkill -f \"yad --notification.*Hermes Hub\"'" \
    >/dev/null 2>&1 < /dev/null &
  echo "✅ Tray icon tampil (daemon di $URL, terminal boleh ditutup)"
}

usage() {
  cat <<USAGE
🌸 tim-hermes-saya v$VERSION — Hermes Hub (port $PORT)
Pakai: tim-hermes-saya [start [--daemon|-d] | stop | restart | status | logs [-f] | tray | --help | --version]

Perintah:
  (tanpa argumen)  jalan foreground (kompatibel lama)
  start            jalan foreground
  start -d         jalan background detached (terminal boleh ditutup)
  status           cek daemon + HTTP $URL (exit 0 hidup, 1 mati)
  logs [-f]        tampilkan $LOGFILE (-f = follow)
  stop             hentikan daemon (via pidfile saja)
  restart          stop + start --daemon
  tray             daemon + tray icon (yad; fallback notify bila yad absen)
  --version, -V    tampilkan versi
  --help, -h       tampilkan bantuan ini

Contoh:
  tim-hermes-saya              # foreground
  tim-hermes-saya start -d     # background
  tim-hermes-saya status
  tim-hermes-saya logs -f
  tim-hermes-saya stop
  tim-hermes-saya tray
USAGE
}

case "${1:-}" in
  "") cd "$HUB_DIR" || { echo "❌ ~/hermes-hub tidak ditemukan"; exit 1; }; exec "$BUN" run server.ts "$@";; # why: teruskan argumen ke server.ts (regresi wrapper lama)
  start) case "${2:-}" in --daemon|-d) do_start_daemon;; *) cd "$HUB_DIR" || { echo "❌ ~/hermes-hub tidak ditemukan"; exit 1; }; shift; exec "$BUN" run server.ts "$@";; esac;; # why: teruskan sisa argumen setelah start
  --daemon|-d) do_start_daemon;;
  stop) do_stop;;
  restart) do_stop; sleep 1; do_start_daemon;;
  status) do_status;;
  logs) do_logs "$2";;
  tray) do_tray;;
  --version|-V) echo "tim-hermes-saya v$VERSION"; exit 0;;
  -h|--help|help) usage;;
  *) echo "❌ Subcommand tidak dikenal: $1"; usage; exit 2;;
esac
EOF

chmod +x "$BIN_TARGET"
echo "✅ Command 'tim-hermes-saya' berhasil dipasang di $BIN_TARGET"
