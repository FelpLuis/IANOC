#!/usr/bin/env bash
# Atualiza o ambiente do IA NOC com as chaves de outro arquivo, sem perder o resto.
#
#   sudo bash merge-env.sh <arquivo-com-chaves-novas> [/etc/ianoc/ianoc.env]
#
# Cada NOME=valor do arquivo novo substitui a linha ativa do mesmo NOME ou é
# acrescentado no fim. Linhas comentadas e as demais chaves ficam como estão.
# Guarda uma cópia do arquivo anterior (.bak-data) com as mesmas permissões.
set -euo pipefail

NEW="${1:?uso: merge-env.sh <chaves-novas> [arquivo-env]}"
ENV_FILE="${2:-/etc/ianoc/ianoc.env}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cp -p "$ENV_FILE" "$ENV_FILE.bak-$STAMP"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

awk -v stamp="$STAMP" '
  { sub(/\r$/, "") }
  NR == FNR {
    if (match($0, /^[A-Z0-9_]+=/)) { k = substr($0, 1, RLENGTH - 1); val[k] = substr($0, RLENGTH + 1); keys[++n] = k }
    next
  }
  {
    if (match($0, /^[A-Z0-9_]+=/)) {
      k = substr($0, 1, RLENGTH - 1)
      if (k in val) { if (!(k in done)) print k "=" val[k]; done[k] = 1; next }
    }
    print
  }
  END {
    for (i = 1; i <= n; i++) {
      k = keys[i]
      if (k in done) continue
      if (!added) { print ""; print "# Acrescentado pelo instalador em " stamp; added = 1 }
      print k "=" val[k]; done[k] = 1
    }
  }
' "$NEW" "$ENV_FILE" > "$tmp"

# Reescreve no lugar para manter dono e permissão (root:ianoc 640).
cat "$tmp" > "$ENV_FILE"
echo "Atualizadas em $ENV_FILE: $(grep -oE '^[A-Z0-9_]+=' "$NEW" | tr -d = | tr '\n' ' ')"
echo "Cópia anterior: $ENV_FILE.bak-$STAMP"
