#!/usr/bin/env bash
# Instala/atualiza o IA NOC num servidor Debian/Ubuntu. Idempotente.
#
#   sudo bash install.sh <diretório-do-release>
#
# O deploy.sh (da máquina do desenvolvedor) envia o release e chama este script.
set -euo pipefail

RELEASE_SRC="${1:?uso: install.sh <diretório-do-release>}"
APP=/opt/ianoc
DATA=/var/lib/ianoc
ETC=/etc/ianoc
ENV_FILE=$ETC/ianoc.env
NAME="$(date +%Y%m%d-%H%M%S)"

[ "$(id -u)" -eq 0 ] || { echo "Rode como root (sudo)." >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

# ------------------------------------------------------------------ Node.js 22
node_major() { local v; v="$(node -v 2>/dev/null || true)"; v="${v#v}"; echo "${v%%.*}" | grep -E "^[0-9]+$" || echo 0; }
if [ "$(node_major)" -lt 20 ]; then
  command -v apt-get >/dev/null || { echo "Instale Node.js 22 manualmente (sistema sem apt)." >&2; exit 1; }
  say "Instalando Node.js 22 (NodeSource)"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
say "Node $(node -v)"

# ------------------------------------------------------------------ usuário e diretórios
id ianoc >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin ianoc
install -d -o root -g root -m 755 "$APP" "$APP/releases"
install -d -o ianoc -g ianoc -m 750 "$DATA" "$DATA/models"
install -d -o root -g ianoc -m 750 "$ETC"

# ------------------------------------------------------------------ configuração
if [ ! -f "$ENV_FILE" ]; then
  say "Criando $ENV_FILE a partir do modelo — PREENCHA as credenciais"
  install -o root -g ianoc -m 640 "$RELEASE_SRC/deploy/ianoc.env.example" "$ENV_FILE"
fi
# Pacote offline (deploy.sh --offline) traz as chaves novas; entram no ambiente e
# o arquivo é apagado antes de copiar o release, para não ficar em /opt.
if [ -f "$RELEASE_SRC/ianoc.env.novas" ]; then
  say "Atualizando credenciais em $ENV_FILE"
  bash "$RELEASE_SRC/deploy/merge-env.sh" "$RELEASE_SRC/ianoc.env.novas" "$ENV_FILE"
  rm -f "$RELEASE_SRC/ianoc.env.novas"
fi

# ------------------------------------------------------------------ release
say "Instalando release $NAME"
DEST="$APP/releases/$NAME"
cp -a "$RELEASE_SRC" "$DEST"
if [ -d "$DEST/backend/node_modules" ]; then
  echo "Dependências já vêm no pacote."
else
  # Sem GPU no servidor: não baixa os binários CUDA do ONNX Runtime (voz local Kokoro).
  ( cd "$DEST/backend" && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --omit=dev --no-audit --no-fund --loglevel=error )
fi
chown -R root:ianoc "$DEST"
chmod -R g+rX,o-rwx "$DEST"
ln -sfn "$DEST" "$APP/current"

# Mantém os 3 releases mais recentes para rollback.
ls -1dt "$APP"/releases/* | tail -n +4 | xargs -r rm -rf

# ------------------------------------------------------------------ serviço
PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"; PORT="${PORT:-8090}"

install -m 644 "$DEST/deploy/ianoc.service" /etc/systemd/system/ianoc.service
sed -i "s#/usr/bin/node#$(command -v node)#" /etc/systemd/system/ianoc.service
systemctl daemon-reload
systemctl enable ianoc >/dev/null 2>&1

# Firewall: a porta do assistente só aceita os IPs de IANOC_ALLOWED_IPS.
# Com ufw ativo, libera esses IPs lá também (senão o ufw derrubaria antes da nossa regra).
say "Firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  IFS=',' read -r -a ALLOWED <<< "$(grep -E '^IANOC_ALLOWED_IPS=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
  for ip in "${ALLOWED[@]}"; do
    [ -n "$ip" ] && ufw allow from "$ip" to any port "$PORT" proto tcp >/dev/null && echo "ufw: $ip → $PORT"
  done
fi
install -m 644 "$DEST/deploy/ianoc-firewall.service" /etc/systemd/system/ianoc-firewall.service
systemctl daemon-reload
systemctl enable ianoc-firewall >/dev/null 2>&1
systemctl restart ianoc-firewall
journalctl -u ianoc-firewall -n 5 --no-pager -o cat | tail -3

# ------------------------------------------------------------------ subir
missing=()
PROVIDER="$(grep -E '^LLM_PROVIDER=' "$ENV_FILE" | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
case "${PROVIDER:-nativo}" in
  anthropic) grep -qE '^ANTHROPIC_API_KEY=.+' "$ENV_FILE" || missing+=(ANTHROPIC_API_KEY) ;;
  nativo|ollama) ;;
  *) grep -qE '^LLM_API_KEY=.+' "$ENV_FILE" || missing+=(LLM_API_KEY) ;;
esac
grep -qE '^NOC_API_URL=.+' "$ENV_FILE" || missing+=(NOC_API_URL)

systemctl restart ianoc
sleep 3
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  say "IA NOC no ar: http://$(hostname -I | awk '{print $1}'):$PORT"
else
  echo "O serviço não respondeu. Veja: journalctl -u ianoc -n 50" >&2
  exit 1
fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "ATENÇÃO: faltam em $ENV_FILE: ${missing[*]}"
  echo "Edite com: sudo nano $ENV_FILE  e depois: sudo systemctl restart ianoc"
fi
