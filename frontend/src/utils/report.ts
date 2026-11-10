/**
 * Exportar uma resposta do assistente como relatório: Markdown (.md) para arquivar
 * ou editar, e impressão/PDF a partir do HTML já renderizado na tela.
 */

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

/** Título do relatório: o primeiro cabeçalho da resposta, ou um nome padrão. */
export function reportTitle(markdown: string): string {
  const h = markdown.match(/^#{1,3}\s+(.+)$/m)?.[1];
  return (h ?? 'Relatório IA NOC').replace(/[*_`]/g, '').trim();
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60);

export function downloadMarkdown(markdown: string) {
  const title = reportTitle(markdown);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(title) || 'relatorio'}_${stamp()}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Abre o relatório numa janela limpa e chama a impressão (o navegador oferece "Salvar como PDF"). */
export function printReport(renderedHtml: string, markdown: string) {
  const title = reportTitle(markdown).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const win = window.open('', '_blank', 'width=900,height=1000');
  if (!win) {
    alert('O navegador bloqueou a janela de impressão. Libere pop-ups para este site.');
    return;
  }
  const when = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date());
  win.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; margin: 32px; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #1d4ed8; padding-bottom: 8px; margin-bottom: 16px; }
  header strong { color: #1d4ed8; font-size: 15px; }
  header span { color: #555; font-size: 12px; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 20px; border-bottom: 1px solid #ddd; padding-bottom: 4px; } h3 { font-size: 14px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 14px; font-size: 12px; }
  th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: #eef2ff; }
  tr:nth-child(even) td { background: #fafafa; }
  pre, code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; background: #f4f4f5; }
  pre { padding: 8px; white-space: pre-wrap; }
  button { display: none; }
  footer { margin-top: 24px; color: #777; font-size: 11px; border-top: 1px solid #ddd; padding-top: 6px; }
  @media print { body { margin: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style></head><body>
<header><strong>UpDown Internet · NOC</strong><span>Gerado pelo IA NOC em ${when}</span></header>
${renderedHtml}
<footer>Dados consultados em tempo real nos sistemas do NOC (Zabbix, IXC, Opa! Suite e demais conectores). Somente leitura.</footer>
<script>window.onload = () => { window.focus(); window.print(); };</script>
</body></html>`);
  win.document.close();
}
