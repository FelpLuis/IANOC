#!/usr/bin/env bash
# Envia a versão atual da NIA (esta pasta ianoc-agent) para o GitHub. Rode no Git Bash:
#
#   bash deploy/publicar-github.sh "o que mudou"
#   IANOC_SIMULAR=1 bash deploy/publicar-github.sh   # mostra o que iria, sem enviar
#
# O repositório do GitHub tem o conteúdo do ianoc-agent na raiz. O script mantém uma cópia
# dele em .publicar-github/, troca o conteúdo pelos arquivos daqui (os mesmos que o git
# enxerga: versionados + novos não ignorados), faz o commit e o push para o main.
# O servidor confere o GitHub a cada 5 minutos e se atualiza sozinho (atualizar-github.sh).
#
# Nunca vão: .env, dados (data/), instaladores (release/), node_modules, dist — e o script
# recusa o envio se algum desses aparecer na lista.
set -euo pipefail

MSG="${1:-NIA: atualização}"
REPO="${IANOC_GITHUB_REPO:-https://github.com/FelpLuis/IANOC.git}"
BRANCH="${IANOC_GITHUB_BRANCH:-main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLONE="$ROOT/.publicar-github"

cd "$ROOT"
LISTA="$(mktemp)"; trap 'rm -f "$LISTA"' EXIT
git ls-files -co --exclude-standard -z . | tr '\0' '\n' | grep -v '^\.publicar-github/' > "$LISTA"
PROIBIDOS="$(grep -E '(^|/)\.env$|(^|/)\.env\.local$|(^|/)data/|(^|/)release/|node_modules/|(^|/)dist/|usuarios\.json$|auditoria\.log$|\.pem$' "$LISTA" | grep -vE '\.example$' || true)"
if [ -n "$PROIBIDOS" ]; then
  echo "Estes arquivos não podem ir para o GitHub (credenciais ou dados):" >&2
  echo "$PROIBIDOS" >&2
  exit 1
fi
echo "==> $(wc -l < "$LISTA" | tr -d ' ') arquivos de $ROOT"

if [ ! -d "$CLONE/.git" ]; then
  echo "==> Clonando $REPO"
  git clone -q --branch "$BRANCH" "$REPO" "$CLONE"
fi
git -C "$CLONE" remote set-url origin "$REPO"
git -C "$CLONE" fetch -q origin "$BRANCH"
git -C "$CLONE" checkout -q -B "$BRANCH" "origin/$BRANCH"

# Troca o conteúdo do clone pelos arquivos daqui (o que sumiu aqui some lá também).
find "$CLONE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
tr '\n' '\0' < "$LISTA" | tar --null -T - -cf - | tar -C "$CLONE" -xf -

cd "$CLONE"
git -c core.safecrlf=false add -A
if git diff --cached --quiet; then
  echo "Nada mudou desde o último envio."
  exit 0
fi
git diff --cached --stat | tail -1
if [ -n "${IANOC_SIMULAR:-}" ]; then
  echo "Simulação (IANOC_SIMULAR): nada foi enviado. Mudanças em relação ao GitHub:"
  git diff --cached --name-status | head -80
  git reset -q --hard "origin/$BRANCH"
  exit 0
fi
git -c user.name="$(git -C "$ROOT" config user.name)" -c user.email="$(git -C "$ROOT" config user.email)" commit -q -m "$MSG"
echo "==> Enviando para $REPO ($BRANCH)"
git push -q origin "HEAD:$BRANCH"
echo "==> Enviado: $(git log -1 --format='%h %s')"
echo "    O servidor instala sozinho em até 5 minutos (log: journalctl -u ianoc-github -n 80)."
