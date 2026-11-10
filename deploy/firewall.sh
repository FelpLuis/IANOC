#!/usr/bin/env bash
# Restringe a porta do IA NOC aos IPs de IANOC_ALLOWED_IPS (em /etc/ianoc/ianoc.env).
#
# Só mexe na porta do assistente, numa cadeia própria (IANOC): SSH e demais
# serviços não são tocados. Idempotente; o serviço ianoc-firewall reaplica no boot.
set -euo pipefail

ENV_FILE=/etc/ianoc/ianoc.env
val() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '[:space:]'; }
PORT="$(val PORT)"; PORT="${PORT:-8090}"
IFS=',' read -r -a IPS <<< "$(val IANOC_ALLOWED_IPS)"

apply() {
  local ipt="$1" family="$2"
  command -v "$ipt" >/dev/null || return 0
  "$ipt" -N IANOC 2>/dev/null || true
  "$ipt" -F IANOC
  # Remove saltos antigos para a cadeia (a porta pode ter mudado).
  { "$ipt" -S INPUT | grep -- '-j IANOC' || true; } | sed 's/^-A /-D /' | while read -r rule; do
    # shellcheck disable=SC2086
    "$ipt" $rule
  done
  if [ ${#IPS[@]} -eq 0 ] || [ -z "${IPS[0]}" ]; then
    echo "$ipt: IANOC_ALLOWED_IPS vazio — porta $PORT sem filtro de origem"
    return 0
  fi
  for ip in "${IPS[@]}"; do
    # IPv4 vai para o iptables, IPv6 para o ip6tables; sem IPv6 liberado, a porta fica fechada em v6.
    if { [ "$family" = 4 ] && [[ "$ip" != *:* ]]; } || { [ "$family" = 6 ] && [[ "$ip" == *:* ]]; }; then
      "$ipt" -A IANOC -s "$ip" -j ACCEPT
    fi
  done
  "$ipt" -A IANOC -j DROP
  "$ipt" -I INPUT 1 ! -i lo -p tcp --dport "$PORT" -j IANOC
  echo "$ipt: porta $PORT liberada só para ${IPS[*]}"
}

apply iptables 4
apply ip6tables 6
