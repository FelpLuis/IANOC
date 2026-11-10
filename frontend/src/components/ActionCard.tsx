/**
 * Cartão de cadastro proposto pela NIA: mostra todos os campos e só grava quando o
 * operador (administrador) clica em Confirmar. Cancelar descarta a proposta.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, DatabaseZap, Loader2, XCircle } from 'lucide-react';
import type { AcaoPendente } from '../types';
import { cn } from '../utils/helpers';

type Estado = 'pendente' | 'enviando' | 'ok' | 'erro' | 'cancelado' | 'expirado';

export function ActionCard({ acao }: { acao: AcaoPendente }) {
  const [estado, setEstado] = useState<Estado>(Date.now() > acao.expiraEm ? 'expirado' : 'pendente');
  const [mensagem, setMensagem] = useState('');

  useEffect(() => {
    if (estado !== 'pendente') return;
    const t = window.setTimeout(() => setEstado('expirado'), Math.max(0, acao.expiraEm - Date.now()));
    return () => window.clearTimeout(t);
  }, [estado, acao.expiraEm]);

  const confirmar = async () => {
    setEstado('enviando');
    try {
      const r = await fetch(`/api/acoes/${acao.id}/confirmar`, { method: 'POST', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      setMensagem(j.mensagem || (r.ok ? 'Cadastrado.' : `Falhou (HTTP ${r.status}).`));
      setEstado(r.ok && j.ok ? 'ok' : 'erro');
    } catch (e) {
      setMensagem(e instanceof Error ? e.message : 'Falha de rede.');
      setEstado('erro');
    }
  };
  const cancelar = async () => {
    await fetch(`/api/acoes/${acao.id}/cancelar`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    setEstado('cancelado');
  };

  return (
    <div className={cn('mt-3 overflow-hidden rounded-xl border', estado === 'ok' ? 'border-emerald-400/40' : estado === 'erro' ? 'border-red-400/40' : 'border-amber-400/40')}>
      <div className={cn('flex items-center gap-2 px-3 py-2 text-sm font-medium', estado === 'ok' ? 'bg-emerald-400/10 text-emerald-100' : estado === 'erro' ? 'bg-red-500/10 text-red-100' : 'bg-amber-400/10 text-amber-100')}>
        <DatabaseZap className="h-4 w-4" />
        <span className="flex-1">{acao.titulo}</span>
        <span className="hud-label">{estado === 'pendente' ? 'aguardando confirmação' : estado === 'enviando' ? 'gravando…' : estado === 'ok' ? 'gravado' : estado === 'erro' ? 'falhou' : estado === 'cancelado' ? 'cancelado' : 'expirado'}</span>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 px-3 py-2.5 text-sm sm:grid-cols-2">
        {acao.campos.map((c) => (
          <div key={c.rotulo} className="min-w-0">
            <dt className="hud-label">{c.rotulo}</dt>
            <dd className="break-words text-slate-100">{c.valor}</dd>
          </div>
        ))}
      </dl>
      {acao.avisos.length > 0 && (
        <ul className="space-y-1 border-t border-slate-700/50 px-3 py-2 text-xs text-amber-200">
          {acao.avisos.map((a) => <li key={a} className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />{a}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-700/50 px-3 py-2">
        {estado === 'pendente' && (
          <>
            <button type="button" onClick={confirmar} className="btn-primary px-3 py-1.5 text-sm">Confirmar e gravar</button>
            <button type="button" onClick={cancelar} className="btn-secondary px-3 py-1.5 text-sm">Cancelar</button>
            <span className="text-[11px] text-slate-500">Só administradores confirmam · vale 15 min</span>
          </>
        )}
        {estado === 'enviando' && <span className="flex items-center gap-2 text-sm text-slate-300"><Loader2 className="h-4 w-4 animate-spin" /> Gravando no sistema…</span>}
        {estado === 'ok' && <span className="flex items-center gap-2 text-sm text-emerald-200"><CheckCircle2 className="h-4 w-4" /> {mensagem}</span>}
        {estado === 'erro' && <span className="flex items-center gap-2 text-sm text-red-200"><XCircle className="h-4 w-4" /> {mensagem}</span>}
        {estado === 'cancelado' && <span className="text-sm text-slate-400">Cadastro cancelado. Nada foi gravado.</span>}
        {estado === 'expirado' && <span className="text-sm text-slate-400">A proposta expirou sem confirmação. Nada foi gravado.</span>}
      </div>
    </div>
  );
}
