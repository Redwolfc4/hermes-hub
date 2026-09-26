#!/bin/bash
# Script untuk mendaftarkan command 'hermes' secara global di sistem Sensei
CLI_PATH="/home/salahudin/hermes-hub/src/hermes-cli/index.ts"
BIN_TARGET="/home/salahudin/.local/bin/hermes"

mkdir -p /home/salahudin/.local/bin

cat << 'EOF' > "$BIN_TARGET"
#!/bin/bash
exec /home/salahudin/.bun/bin/bun run /home/salahudin/hermes-hub/src/hermes-cli/index.ts "$@"
EOF

chmod +x "$BIN_TARGET"
echo "✅ Command 'hermes' berhasil dipasang di $BIN_TARGET"
