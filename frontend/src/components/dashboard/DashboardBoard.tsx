/**
 * Dashboard completo na identidade visual da UpDown: cabeçalho com logo e status, resumo,
 * indicadores (KPIs), gráficos, pontos de atenção, recomendações e tabelas.
 * O mesmo componente desenha a tela cheia e a exportação (estatico = sem animação).
 */
import { Activity, AlertTriangle, Clock, Headset, Lightbulb, Radar, Siren, Sparkles, Timer, Wrench, type LucideIcon } from 'lucide-react';
import type { Dashboard, DashKpi, DashTom } from '../../types';
import { Grafico, TOM_COR } from './charts';

const ICONES: Record<string, LucideIcon> = { siren: Siren, activity: Activity, timer: Timer, wrench: Wrench, headset: Headset, clock: Clock };

export const TOM_ROTULO: Record<DashTom, string> = { ok: 'normal', atencao: 'atenção', critico: 'crítico', info: 'informativo', marca: '' };

export function StatusPill({ tom, texto }: { tom: DashTom; texto: string }) {
  const c = TOM_COR[tom];
  return (
    <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em]" style={{ borderColor: `${c}66`, background: `${c}14`, color: c }}>
      <span className="dash-pulse h-2 w-2 rounded-full" style={{ background: c, boxShadow: `0 0 10px ${c}` }} />
      {texto}
    </span>
  );
}

export function KpiTile({ k, compacto }: { k: DashKpi; compacto?: boolean }) {
  const c = TOM_COR[k.tom];
  const I = ICONES[k.icone] ?? Activity;
  return (
    <div className="dash-card group relative overflow-hidden p-4" style={{ ['--dash-acc' as string]: c }}>
      <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full opacity-25 blur-2xl" style={{ background: c }} />
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg border" style={{ borderColor: `${c}55`, background: `${c}14`, color: c, boxShadow: `0 0 18px -6px ${c}` }}>
          <I className="h-4 w-4" />
        </span>
        <span className={`min-w-0 flex-1 font-mono text-[10px] uppercase leading-tight text-slate-400 ${compacto ? "tracking-[0.1em]" : "tracking-[0.12em] sm:tracking-[0.16em]"}`} title={k.rotulo}>{k.rotulo}</span>
      </div>
      <div className={`dash-valor mt-3 truncate font-display font-bold leading-none ${compacto ? 'text-2xl' : 'text-[1.9rem]'}`} title={k.valor}>{k.valor}</div>
      {k.detalhe && <div className="mt-2 truncate text-[11px] text-slate-400" title={k.detalhe}>{k.detalhe}</div>}
      <div className="absolute inset-x-0 bottom-0 h-[2px]" style={{ background: `linear-gradient(90deg, transparent, ${c}, transparent)` }} />
    </div>
  );
}

function Cartao({ titulo, grupo, subtitulo, children, className = '' }: { titulo: string; grupo?: string; subtitulo?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`dash-card p-4 sm:p-5 ${className}`}>
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-white">{titulo}</h3>
          {subtitulo && <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">{subtitulo}</p>}
        </div>
        {grupo && <span className="flex-shrink-0 rounded-md border border-cyan-400/25 bg-cyan-400/5 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-cyan-200/80">{grupo}</span>}
      </header>
      {children}
    </section>
  );
}

export function DashboardBoard({ d, estatico, logoSrc = '/brand/updown-internet-branco.png' }: { d: Dashboard; estatico?: boolean; logoSrc?: string }) {
  return (
    <div className="dash-root relative space-y-4 p-4 sm:space-y-5 sm:p-6">
      {/* Cabeçalho */}
      <header className="dash-card dash-header relative flex flex-col gap-4 overflow-hidden p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <img src={logoSrc} alt="UpDown Internet" className="h-9 w-auto flex-shrink-0 sm:h-11" />
          <span className="hidden h-10 w-px bg-gradient-to-b from-transparent via-cyan-300/50 to-transparent sm:block" />
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-300/80">NIA · Centro de Operações de Rede</p>
            <h1 className="mt-1 font-display text-base font-bold uppercase leading-tight tracking-wider text-white sm:text-xl">{d.titulo}</h1>
            <p className="mt-0.5 text-xs text-slate-400">{d.periodo} <span className="font-mono text-slate-500">· {d.intervalo}</span></p>
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <StatusPill tom={d.status.tom} texto={d.status.texto} />
          <p className="font-mono text-[10px] text-slate-500">Gerado em {d.geradoEm} · {d.fontes.join(' · ')}</p>
        </div>
        {!estatico && <div className="dash-scan pointer-events-none absolute inset-0" />}
      </header>

      {/* Resumo */}
      {d.resumo && (
        <div className="dash-card flex items-start gap-3 p-4">
          <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full border border-violet-400/40 bg-violet-500/15 text-violet-200 shadow-[0_0_18px_-4px_rgba(164,10,232,0.8)]">
            <Sparkles className="h-4 w-4" />
          </span>
          <p className="text-sm leading-relaxed text-slate-200">{d.resumo}</p>
        </div>
      )}

      {/* Indicadores */}
      {d.kpis.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {d.kpis.map((k) => <KpiTile key={k.id} k={k} />)}
        </div>
      )}

      {/* Gráficos */}
      {d.graficos.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {d.graficos.map((g) => (
            <Cartao key={g.id} titulo={g.titulo} grupo={g.grupo} subtitulo={g.subtitulo} className={g.largura === 2 ? 'md:col-span-2' : ''}>
              <Grafico g={g} estatico={estatico} />
            </Cartao>
          ))}
        </div>
      )}

      {/* Análise */}
      {(d.destaques.length > 0 || d.recomendacoes.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {d.destaques.length > 0 && (
            <Cartao titulo="Pontos de atenção" grupo="Análise">
              <ul className="space-y-2">
                {d.destaques.map((t, i) => (
                  <li key={i} className="flex gap-2.5 text-[13px] leading-snug text-slate-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-300" />{t}
                  </li>
                ))}
              </ul>
            </Cartao>
          )}
          {d.recomendacoes.length > 0 && (
            <Cartao titulo="Recomendações" grupo="Próximos passos">
              <ul className="space-y-2">
                {d.recomendacoes.map((t, i) => (
                  <li key={i} className="flex gap-2.5 text-[13px] leading-snug text-slate-200">
                    <Lightbulb className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-cyan-300" />{t}
                  </li>
                ))}
              </ul>
            </Cartao>
          )}
        </div>
      )}

      {/* Tabelas */}
      {d.tabelas.map((t) => (
        <Cartao key={t.titulo} titulo={t.titulo} grupo={t.grupo}>
          <div className="-mx-1 overflow-x-auto">
            <table className="dash-table w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr>{t.colunas.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {t.linhas.map((l, i) => {
                  const tom = t.tons?.[i];
                  return (
                    <tr key={i} style={tom ? { boxShadow: `inset 3px 0 0 ${TOM_COR[tom]}` } : undefined}>
                      {l.map((c, j) => <td key={j} className={j === 0 && tom ? 'font-medium capitalize' : ''} style={j === 0 && tom ? { color: TOM_COR[tom] } : undefined}>{c}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Cartao>
      ))}

      {d.indisponiveis.length > 0 && (
        <p className="rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-2 text-xs text-amber-200/90">Fontes indisponíveis: {d.indisponiveis.join(' · ')}</p>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 px-1 pt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
        <span className="flex items-center gap-1.5"><Radar className="h-3 w-3 text-cyan-400/70" /> UpDown Internet · NOC</span>
        <span>Números lidos direto dos sistemas · gerado pela NIA</span>
      </footer>
    </div>
  );
}
