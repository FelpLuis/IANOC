/**
 * Dashboard na conversa: prévia compacta (status, indicadores e o gráfico principal) e a
 * tela cheia com o painel completo. Pedido explícito de dashboard abre direto em tela cheia.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, LayoutDashboard, Maximize2, Printer, X } from 'lucide-react';
import type { Dashboard } from '../../types';
import { DashboardBoard, KpiTile, StatusPill } from './DashboardBoard';
import { Grafico } from './charts';
import { abrirDashboardExportado, baixarDashboard } from '../../utils/dashboardExport';

// Mensagens cujo dashboard já abriu sozinho (não reabre ao rolar ou recarregar o componente).
const jaAbertos = new Set<string>();

function Acoes({ d, compacto }: { d: Dashboard; compacto?: boolean }) {
  const btn = 'flex items-center gap-1.5 rounded-lg border border-slate-600/60 bg-slate-900/60 px-2.5 py-1.5 text-xs text-slate-200 transition-all hover:border-cyan-400/50 hover:text-white';
  return (
    <>
      <button type="button" className={btn} onClick={() => baixarDashboard(d)} title="Baixar o dashboard em HTML (abre em qualquer navegador)">
        <Download className="h-3.5 w-3.5" /> {compacto ? 'HTML' : 'Exportar HTML'}
      </button>
      <button type="button" className={btn} onClick={() => abrirDashboardExportado(d, true)} title="Imprimir ou salvar em PDF (A4 paisagem)">
        <Printer className="h-3.5 w-3.5" /> PDF
      </button>
    </>
  );
}

export function DashboardModal({ d, onClose }: { d: Dashboard; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#05021a]/85 backdrop-blur-md animate-fade-in" role="dialog" aria-modal="true" aria-label={d.titulo}>
      <div className="flex items-center gap-2 border-b border-cyan-400/15 bg-slate-950/70 px-3 py-2 sm:px-5">
        <LayoutDashboard className="h-4 w-4 text-cyan-300" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.2em] text-slate-300">Dashboard · {d.periodo}</span>
        <Acoes d={d} />
        <button type="button" onClick={onClose} className="icon-btn ml-1 p-2" title="Fechar (Esc)"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1480px]"><DashboardBoard d={d} /></div>
      </div>
    </div>,
    document.body,
  );
}

export function DashboardCard({ d, messageId, novo }: { d: Dashboard; messageId: string; novo?: boolean }) {
  const [aberto, setAberto] = useState(false);
  useEffect(() => {
    if (d.abrir && novo && !jaAbertos.has(messageId)) { jaAbertos.add(messageId); setAberto(true); }
  }, [d.abrir, novo, messageId]);
  const principal = d.graficos.find((g) => g.tipo === 'linha') ?? d.graficos[0];

  return (
    <div className="dash-card dash-preview mt-3 overflow-hidden p-3 sm:p-4 animate-reveal">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg border border-cyan-400/40 bg-cyan-400/10 text-cyan-200"><LayoutDashboard className="h-3.5 w-3.5" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">Dashboard operacional</p>
          <p className="truncate font-mono text-[10px] uppercase tracking-widest text-slate-500">{d.periodo} · {d.fontes.join(' · ')}</p>
        </div>
        <StatusPill tom={d.status.tom} texto={d.status.texto} />
      </div>
      {d.kpis.length > 0 && (
        <div className="grid grid-cols-2 gap-2 2xl:grid-cols-4">
          {d.kpis.slice(0, 4).map((k) => <KpiTile key={k.id} k={k} compacto />)}
        </div>
      )}
      {principal && (
        <div className="mt-3 rounded-xl border border-slate-700/40 bg-slate-950/40 p-3">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-slate-400">{principal.titulo}</p>
          <Grafico g={principal} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setAberto(true)} className="btn-primary flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold">
          <Maximize2 className="h-3.5 w-3.5" /> Abrir dashboard
        </button>
        <Acoes d={d} compacto />
        <span className="ml-auto font-mono text-[10px] text-slate-500">{d.graficos.length} gráficos · {d.tabelas.length} tabelas</span>
      </div>
      {aberto && <DashboardModal d={d} onClose={() => setAberto(false)} />}
    </div>
  );
}
