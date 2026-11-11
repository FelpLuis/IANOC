#!/usr/bin/env bash
# Gera o build e publica o IA NOC num servidor. Rode no Git Bash, na raiz do ianoc-agent:
#
#   bash deploy/deploy.sh usuario@190.111.110.13 [porta-ssh]
#
# Usa a chave ~/.ssh/ianoc_deploy. As credenciais ficam só em /etc/ianoc/ianoc.env
# no servidor — nada de .env local vai no pacote.
#
# Servidor sem SSH:
#
#   bash deploy/deploy.sh --offline
#
# gera release/ianoc-instalar-<data>.sh: um arquivo único com o pacote e as chaves
# de backend/.env listadas em ENV_KEYS. As dependências são instaladas no servidor
# (npm ci), que precisa de acesso à internet.
# Copie para o servidor e rode como root:  bash ianoc-instalar-<data>.sh
# O arquivo tem credenciais — apague-o depois de instalar.
set -euo pipefail

TARGET="${1:?uso: deploy.sh usuario@host [porta-ssh]  |  deploy.sh --offline}"
OFFLINE=; [ "$TARGET" = "--offline" ] && OFFLINE=1
# Chaves levadas do backend/.env local no modo offline (só as preenchidas).
ENV_KEYS='LLM_PROVIDER|LLM_MODEL|LLM_API_KEY|LLM_BASE_URL|LLM_REASONING_EFFORT|ZABBIX[23]?_(NAME|URL|TOKEN|USER|PASSWORD)|IXC_BASE_URL|IXC_API_TOKEN|OPA_URL|OPA_TOKEN|STT_BASE_URL|STT_API_KEY|STT_MODEL|TTS_PROVIDER|TTS_VOICE|FISH_API_KEY|FISH_VOICE_ID|FISH_MODEL|KOKORO_VOICE|KOKORO_DTYPE|KOKORO_SPEED|IANOC_ADMIN_USER|IANOC_ADMIN_NAME|IANOC_ADMIN_PASSWORD|IANOC_ADMIN_TROCA_SENHA|IANOC_AUTH|BRAVE_API_KEY|SEARXNG_URL|TAVILY_API_KEY|NOC_API_URL|NOC_API_USER|NOC_API_PASSWORD|GENIEACS_NBI_URL|IANOC_GERAL_LLM|IANOC_GERAL_MODEL|IANOC_GERAL_API_KEY|IANOC_GERAL_BASE_URL|IANOC_GERAL_REASONING|IANOC_ACESSO_PUBLICO|IANOC_DEV_LLM|IANOC_DEV_MODEL|IANOC_DEV_TIMEOUT_MS|IANOC_TV_HISTORICO|LLM_MODELOS_RESERVA|IANOC_VISAO_MODEL'
SSH_PORT="${2:-22}"
KEY="${IANOC_SSH_KEY:-$HOME/.ssh/ianoc_deploy}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOPO="${TOPOLOGIA_DIR:-$ROOT/../../Topologia-NOC.github.io/public/data}"
SSH=(ssh -i "$KEY" -p "$SSH_PORT" -o BatchMode=yes)
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "==> Build do frontend"
( cd "$ROOT/frontend" && npm run build >/dev/null )
echo "==> Build do backend"
( cd "$ROOT/backend" && rm -rf dist && npx tsc -p . )

echo "==> Montando pacote"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
R="$STAGE/ianoc"
mkdir -p "$R/backend" "$R/frontend" "$R/topologia-data"
cp -r "$ROOT/backend/dist" "$ROOT/backend/package.json" "$ROOT/backend/package-lock.json" "$R/backend/"
cp -r "$ROOT/frontend/dist" "$R/frontend/"
cp -r "$ROOT/knowledge" "$ROOT/deploy" "$R/"
cp "$TOPO"/*.json "$R/topologia-data/"
if [ -n "$OFFLINE" ]; then
  # Dependências NÃO vão no pacote: a voz local (Kokoro/ONNX, sharp) tem binários nativos por
  # sistema; o install.sh roda npm ci no servidor e baixa os de Linux.
  echo "==> Chaves de backend/.env"
  tr -d '\r' < "$ROOT/backend/.env" | grep -E "^($ENV_KEYS)=.+" > "$R/ianoc.env.novas" || true
  echo "    $(cut -d= -f1 "$R/ianoc.env.novas" | tr '\n' ' ')"
fi
tar --owner=0 --group=0 -czf "$STAGE/ianoc.tgz" -C "$STAGE" ianoc
if [ -n "${IANOC_DRY_RUN:-}" ]; then tar -tzf "$STAGE/ianoc.tgz" | grep -vE "/assets/|node_modules/" ; du -h "$STAGE/ianoc.tgz"; exit 0; fi

if [ -n "$OFFLINE" ]; then
  mkdir -p "$ROOT/release"
  OUT="$ROOT/release/ianoc-instalar-$STAMP.sh"
  {
    cat <<'HEADER'
#!/usr/bin/env bash
# Instalador do IA NOC para servidor sem SSH. No servidor, como root:
#   bash ianoc-instalar-<data>.sh
# ATENÇÃO: contém credenciais (chaves de API). Apague depois de instalar.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Rode como root: sudo bash $0" >&2; exit 1; }
DIR="$(mktemp -d /tmp/ianoc-XXXXXX)"
trap 'rm -rf "$DIR"' EXIT
sed '1,/^__PACOTE__$/d' "$0" | base64 -d | tar --no-same-owner -xzf - -C "$DIR"
bash "$DIR/ianoc/deploy/install.sh" "$DIR/ianoc"
echo
echo "Instalado. Apague este instalador (tem credenciais):  rm -f $0"
exit 0
__PACOTE__
HEADER
    base64 "$STAGE/ianoc.tgz"
  } > "$OUT"
  echo "==> Instalador: $OUT ($(du -h "$OUT" | cut -f1))"
  echo "    Copie para o servidor e rode como root:  bash $(basename "$OUT")"
  exit 0
fi

echo "==> Enviando para $TARGET"
scp -i "$KEY" -P "$SSH_PORT" -o BatchMode=yes "$STAGE/ianoc.tgz" "$TARGET:/tmp/ianoc-$STAMP.tgz"

echo "==> Instalando"
REMOTE="set -e; rm -rf /tmp/ianoc-$STAMP; mkdir /tmp/ianoc-$STAMP; tar --no-same-owner -xzf /tmp/ianoc-$STAMP.tgz -C /tmp/ianoc-$STAMP; rm /tmp/ianoc-$STAMP.tgz"
"${SSH[@]}" "$TARGET" "$REMOTE"
INSTALL="bash /tmp/ianoc-$STAMP/ianoc/deploy/install.sh /tmp/ianoc-$STAMP/ianoc && rm -rf /tmp/ianoc-$STAMP"
if "${SSH[@]}" "$TARGET" '[ "$(id -u)" -eq 0 ]'; then
  "${SSH[@]}" "$TARGET" "$INSTALL"
elif "${SSH[@]}" "$TARGET" 'sudo -n true' 2>/dev/null; then
  "${SSH[@]}" "$TARGET" "sudo -n $INSTALL"
else
  echo
  echo "O usuário não tem sudo sem senha. Termine a instalação no servidor com:"
  echo "  ssh -p $SSH_PORT $TARGET"
  echo "  sudo $INSTALL"
fi
