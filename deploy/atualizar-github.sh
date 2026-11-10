#!/usr/bin/env bash
# Atualiza a NIA no servidor a partir do GitHub (roda no servidor, como root).
#
#   sudo ianoc-atualizar            # instala se o main do GitHub mudou desde a última vez
#   sudo ianoc-atualizar --forcar   # recompila e reinstala mesmo sem commit novo
#
# O timer ianoc-github.timer chama este script a cada 5 minutos: basta enviar a versão
# nova para o GitHub (deploy/publicar-github.sh ou upload pelo site) e o servidor se
# atualiza sozinho. Log: journalctl -u ianoc-github -n 80
#
# Repositório e ramo ficam em /etc/ianoc/github.conf:
#   REPO=https://github.com/FelpLuis/IANOC.git
#   BRANCH=main
# Repositório privado: use a URL SSH (git@github.com:FelpLuis/IANOC.git) e uma deploy key
# somente leitura em /root/.ssh (veja o README).
#
# Segurança: a compilação (npm ci + build) roda como o usuário de sistema "ianoc", sem
# privilégio de root. Se a versão nova não subir, volta para a anterior.
set -euo pipefail

CONF=/etc/ianoc/github.conf
REPO=https://github.com/FelpLuis/IANOC.git
BRANCH=main
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
APP=/opt/ianoc
SRC=$APP/github
STATE=/var/lib/ianoc/github-commit
FORCAR=; [ "${1:-}" = "--forcar" ] && FORCAR=1

[ "$(id -u)" -eq 0 ] || { echo "Rode como root: sudo ianoc-atualizar" >&2; exit 1; }
exec 9>/run/ianoc-github.lock
flock -n 9 || { echo "Já existe uma atualização em andamento."; exit 0; }
say() { printf '==> %s\n' "$*"; }

# ------------------------------------------------------------------ busca no GitHub
if [ ! -d "$SRC/.git" ]; then
  say "Clonando $REPO ($BRANCH)"
  git clone -q --branch "$BRANCH" "$REPO" "$SRC"
fi
git -C "$SRC" remote set-url origin "$REPO"
git -C "$SRC" fetch -q --depth 1 origin "$BRANCH"
NOVO="$(git -C "$SRC" rev-parse FETCH_HEAD)"
ATUAL="$(cat "$STATE" 2>/dev/null || true)"
FALHOU="$(cat "$STATE.falhou" 2>/dev/null || true)"
if [ -z "$FORCAR" ] && { [ "$NOVO" = "$ATUAL" ] || [ "$NOVO" = "$FALHOU" ]; }; then
  exit 0   # nada novo, ou esta versão já falhou (silencioso para o timer)
fi
# Qualquer erro daqui em diante marca a versão como falha: o timer não recompila a mesma
# versão quebrada a cada 5 minutos. Corrija e envie um commit novo (ou use --forcar).
trap 'echo "$NOVO" > "$STATE.falhou"; echo "Atualização para ${NOVO:0:7} falhou; a versão no ar não mudou." >&2' ERR
git -C "$SRC" reset -q --hard "$NOVO"
git -C "$SRC" clean -qfd
say "Versão do GitHub: ${NOVO:0:7} — $(git -C "$SRC" log -1 --format='%s (%an, %ad)' --date=format:'%d/%m %H:%M')"

# O repositório pode ter o ianoc-agent na raiz ou numa subpasta.
ROOT=
for c in "$SRC" "$SRC/ianoc-agent" "$SRC/IANOC/ianoc-agent"; do
  if [ -f "$c/backend/package.json" ] && [ -f "$c/frontend/package.json" ]; then ROOT="$c"; break; fi
done
[ -n "$ROOT" ] || { echo "Não achei backend/ e frontend/ no repositório." >&2; exit 1; }

# ------------------------------------------------------------------ compilação (usuário ianoc)
BUILD="$(mktemp -d /var/tmp/ianoc-build-XXXXXX)"
trap 'rm -rf "$BUILD"' EXIT
tar -C "$ROOT" --exclude=.git --exclude=node_modules --exclude=dist -cf - . | tar -C "$BUILD" -xf -
mkdir -p "$BUILD/.npm"
chown -R ianoc:ianoc "$BUILD"
como_ianoc() { runuser -u ianoc -- env HOME="$BUILD" npm_config_cache="$BUILD/.npm" PATH="$PATH" "$@"; }

say "Compilando o frontend"
como_ianoc bash -c "cd '$BUILD/frontend' && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null"
say "Compilando o backend"
# --ignore-scripts: para compilar não precisa baixar os binários nativos (voz, imagens);
# o install.sh instala as dependências de produção completas no release.
como_ianoc bash -c "cd '$BUILD/backend' && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npx tsc -p ."

# ------------------------------------------------------------------ pacote (mesmo formato do deploy.sh)
R="$BUILD/release/ianoc"
mkdir -p "$R/backend" "$R/frontend" "$R/topologia-data"
cp -r "$BUILD/backend/dist" "$BUILD/backend/package.json" "$BUILD/backend/package-lock.json" "$R/backend/"
cp -r "$BUILD/frontend/dist" "$R/frontend/"
cp -r "$BUILD/knowledge" "$BUILD/deploy" "$R/"
if ls "$BUILD"/topologia-data/*.json >/dev/null 2>&1; then
  cp "$BUILD"/topologia-data/*.json "$R/topologia-data/"
elif ls "$APP"/current/topologia-data/*.json >/dev/null 2>&1; then
  cp "$APP"/current/topologia-data/*.json "$R/topologia-data/"   # mantém a do release atual
fi
# Upload pelo site do GitHub a partir do Windows pode trazer CRLF nos scripts.
find "$R/deploy" -type f \( -name '*.sh' -o -name '*.service' -o -name '*.timer' \) -exec sed -i 's/\r$//' {} +
chown -R root:root "$R"

# ------------------------------------------------------------------ instalação com volta automática
ANTERIOR="$(readlink -f "$APP/current" 2>/dev/null || true)"
say "Instalando"
if bash "$R/deploy/install.sh" "$R"; then
  echo "$NOVO" > "$STATE"
  rm -f "$STATE.falhou"
  say "NIA atualizada para ${NOVO:0:7}."
else
  trap - ERR
  echo "$NOVO" > "$STATE.falhou"
  echo "A versão ${NOVO:0:7} não subiu." >&2
  if [ -n "$ANTERIOR" ] && [ -d "$ANTERIOR" ]; then
    ln -sfn "$ANTERIOR" "$APP/current"
    systemctl restart ianoc
    echo "Voltei para a versão anterior ($(basename "$ANTERIOR"))." >&2
  fi
  exit 1
fi
