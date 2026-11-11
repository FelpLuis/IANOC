import type { Dashboard } from '../types';

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

/**
 * Documento com a identidade visual (logo, cores, rodapé) e o molde padrão, gerado no
 * servidor. A janela abre no clique (para o navegador não bloquear) e recebe o HTML depois.
 */
export async function abrirDocumento(markdown: string, dashboard?: Dashboard) {
  const win = window.open('', '_blank');
  if (!win) {
    alert('O navegador bloqueou a janela do documento. Libere pop-ups para este site.');
    return;
  }
  win.document.write('<p style="font:14px system-ui;padding:24px;color:#334155">Gerando o documento com a identidade visual…</p>');
  try {
    const r = await fetch('/api/documento', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      // Com dashboard, os indicadores e o status vão para o topo do documento.
      body: JSON.stringify(dashboard ? { markdown, kpis: dashboard.kpis, status: dashboard.status, periodo: `${dashboard.periodo} · ${dashboard.intervalo}` } : { markdown }),
    });
    const html = await r.text();
    if (!r.ok) throw new Error(html.slice(0, 200));
    win.document.open();
    win.document.write(html);
    win.document.close();
    // O documento não roda script (CSP no próprio HTML): o botão de imprimir é ligado daqui.
    win.document.querySelector('[data-imprimir]')?.addEventListener('click', () => win.print());
  } catch (e) {
    win.document.body.innerHTML = `<p style="font:14px system-ui;padding:24px;color:#b91c1c">Não foi possível gerar o documento: ${String(e instanceof Error ? e.message : e).replace(/[<>&]/g, '')}</p>`;
  }
}
