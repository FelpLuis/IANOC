/**
 * Exportação do dashboard: o mesmo componente da tela (DashboardBoard, sem animação) vira
 * um HTML independente, com o CSS do app embutido e o logo em data URL. Abre numa janela
 * pronta para imprimir/salvar em PDF (A4 paisagem, cores preservadas) ou baixa o .html.
 */
import { createElement } from 'react';
import type { Dashboard } from '../types';
import { DashboardBoard } from '../components/dashboard/DashboardBoard';

const FONTES = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Orbitron:wght@500;700&display=swap';
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function dataUrl(src: string): Promise<string> {
  try {
    const blob = await (await fetch(src)).blob();
    return await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(blob); });
  } catch { return src; }
}

/** CSS já carregado pelo app (Tailwind + tema), lido das folhas de estilo da própria origem. */
function cssDoApp(): string {
  return [...document.styleSheets].map((ss) => {
    try { return [...ss.cssRules].map((r) => r.cssText).join('\n'); } catch { return ''; }
  }).join('\n');
}

export async function htmlDoDashboard(d: Dashboard): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const logo = await dataUrl('/brand/updown-internet-branco.png');
  const corpo = renderToStaticMarkup(createElement(DashboardBoard, { d, estatico: true, logoSrc: logo }));
  const titulo = `${d.titulo} — ${d.periodo}`;
  return `<!doctype html><html lang="pt-BR" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="${FONTES}" rel="stylesheet">
<style>${cssDoApp()}</style>
<style>
  html, body { height: auto; min-height: 100%; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; background: #05021a; color: #f1f5f9; }
  .dash-export { max-width: 1480px; margin: 0 auto; }
  .dash-acoes { position: fixed; bottom: 16px; right: 16px; z-index: 10; display: flex; gap: 8px; }
  .dash-acoes button { font: 600 12px Inter, system-ui, sans-serif; color: #fff; border: 1px solid rgba(18,186,234,.5); border-radius: 10px; padding: 9px 14px; cursor: pointer;
    background: linear-gradient(90deg, #12baea, #2a12f0 55%, #a40ae8); box-shadow: 0 0 22px -6px rgba(18,186,234,.8); }
  @page { size: A4 landscape; margin: 7mm; }
  @media print {
    .dash-acoes { display: none; }
    body { background: #05021a !important; }
    .dash-card { break-inside: avoid; backdrop-filter: none !important; }
    .dash-root { padding: 0 !important; }
  }
</style></head><body>
<div class="dash-acoes"><button onclick="window.print()">Imprimir / salvar PDF</button></div>
<main class="dash-export">${corpo}</main>
</body></html>`;
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1_');

/** Abre o dashboard exportado numa nova janela (e, se pedido, já chama a impressão). */
export async function abrirDashboardExportado(d: Dashboard, imprimir = false) {
  const win = window.open('', '_blank');
  if (!win) { alert('O navegador bloqueou a janela. Libere os pop-ups deste site.'); return; }
  win.document.write('<body style="background:#05021a;color:#9ba3c0;font:14px system-ui;padding:32px">Renderizando o dashboard…</body>');
  const html = await htmlDoDashboard(d);
  win.document.open();
  win.document.write(imprimir ? html.replace('</body>', '<script>window.onload=()=>setTimeout(()=>window.print(),600)</script></body>') : html);
  win.document.close();
}

export async function baixarDashboard(d: Dashboard) {
  const html = await htmlDoDashboard(d);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `dashboard-noc_${stamp()}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
