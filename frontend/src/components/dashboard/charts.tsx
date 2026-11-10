/**
 * Gráficos do dashboard em SVG puro (sem biblioteca): área com brilho, rosca, barras
 * horizontais e colunas. Cores da UpDown; animação só na tela (a exportação sai estática).
 */
import { useId } from 'react';
import type { DashFormato, DashGrafico, DashSerie, DashTom } from '../../types';

export const PALETA = ['#12baea', '#a40ae8', '#3d22f0', '#c874f8', '#38e8c6', '#5b8cff', '#f472b6', '#7dd3fc'];
export const TOM_COR: Record<DashTom, string> = { ok: '#38e8c6', atencao: '#ffc53d', critico: '#ff2d6f', info: '#12baea', marca: '#c874f8' };

const dur = (min: number) => (min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim() : `${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`);
export const fmt = (v: number, f: DashFormato = 'numero') => (f === 'duracao_min' ? dur(v) : f === 'horas' ? `${v.toLocaleString('pt-BR')} h` : v.toLocaleString('pt-BR'));
const cor = (s: DashSerie, i: number) => s.cor ?? PALETA[i % PALETA.length];
const idSeguro = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '');

/** Curva suave monótona (Fritsch-Carlson): não passa abaixo nem acima dos pontos reais. */
function curva(p: Array<[number, number]>): string {
  const n = p.length;
  if (n < 2) return '';
  const dx = p.slice(1).map((q, i) => q[0] - p[i][0]);
  const m = p.slice(1).map((q, i) => (q[1] - p[i][1]) / dx[i]);
  const t = p.map((_, i) => (i === 0 ? m[0] : i === n - 1 ? m[n - 2] : m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
    if (h > 9) { const s = 3 / Math.sqrt(h); t[i] = s * a * m[i]; t[i + 1] = s * b * m[i]; }
  }
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${p[i][0] + h},${p[i][1] + t[i] * h} ${p[i + 1][0] - h},${p[i + 1][1] - t[i + 1] * h} ${p[i + 1][0]},${p[i + 1][1]}`;
  }
  return d;
}

function Linha({ g, estatico }: { g: DashGrafico; estatico?: boolean }) {
  const uid = idSeguro(useId());
  const W = 640, H = 210, pl = 36, pr = 12, pt = 18, pb = 26;
  const vals = g.series.map((s) => s.valor);
  const max = Math.max(1, ...vals);
  const topo = max <= 5 ? max : Math.ceil(max / 5) * 5;
  const x = (i: number) => pl + (i * (W - pl - pr)) / Math.max(1, vals.length - 1);
  const y = (v: number) => pt + (1 - v / topo) * (H - pt - pb);
  const pts = vals.map((v, i) => [x(i), y(v)] as [number, number]);
  const linha = curva(pts);
  const area = `${linha} L${x(vals.length - 1)},${H - pb} L${x(0)},${H - pb} Z`;
  const iMax = vals.indexOf(Math.max(...vals));
  const passo = Math.max(1, Math.ceil(vals.length / 8));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full overflow-visible" role="img" aria-label={g.titulo}>
      <defs>
        <linearGradient id={`a${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#12baea" stopOpacity="0.45" />
          <stop offset="0.6" stopColor="#3d22f0" stopOpacity="0.12" />
          <stop offset="1" stopColor="#3d22f0" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`l${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#12baea" />
          <stop offset="0.55" stopColor="#5b8cff" />
          <stop offset="1" stopColor="#c874f8" />
        </linearGradient>
        <filter id={`f${uid}`} x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="4" /></filter>
      </defs>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pl} x2={W - pr} y1={y(topo * f)} y2={y(topo * f)} stroke="rgba(148,163,230,0.14)" strokeDasharray="3 5" />
          <text x={pl - 8} y={y(topo * f) + 4} textAnchor="end" className="fill-slate-400 font-mono" fontSize="10">{fmt(Math.round(topo * f), g.formato)}</text>
        </g>
      ))}
      <path d={area} fill={`url(#a${uid})`} className={estatico ? '' : 'dash-fade'} />
      <path d={linha} fill="none" stroke={`url(#l${uid})`} strokeWidth="6" opacity="0.35" filter={`url(#f${uid})`} />
      <path d={linha} fill="none" stroke={`url(#l${uid})`} strokeWidth="2.5" strokeLinecap="round" pathLength={1} className={estatico ? '' : 'dash-draw'} />
      {pts.map(([px, py], i) => (i === iMax || vals.length <= 14) && (
        <circle key={i} cx={px} cy={py} r={i === iMax ? 4.5 : 2.5} fill={i === iMax ? '#fff' : '#12baea'} stroke={i === iMax ? '#c874f8' : 'none'} strokeWidth="3" />
      ))}
      {vals.length > 0 && (
        <g>
          <rect x={Math.min(Math.max(pts[iMax][0] - 26, pl), W - pr - 52)} y={Math.max(pts[iMax][1] - 30, 0)} width="52" height="19" rx="6" fill="rgba(10,6,40,0.9)" stroke="rgba(200,116,248,0.6)" />
          <text x={Math.min(Math.max(pts[iMax][0], pl + 26), W - pr - 26)} y={Math.max(pts[iMax][1] - 30, 0) + 13} textAnchor="middle" className="fill-white font-mono" fontSize="10.5" fontWeight="600">{fmt(vals[iMax], g.formato)}</text>
        </g>
      )}
      {g.series.map((s, i) => (i % passo === 0 || i === vals.length - 1) && (
        <text key={i} x={x(i)} y={H - 6} textAnchor="middle" className="fill-slate-400 font-mono" fontSize="10">{s.rotulo}</text>
      ))}
    </svg>
  );
}

function Rosca({ g, estatico }: { g: DashGrafico; estatico?: boolean }) {
  const uid = idSeguro(useId());
  const soma = g.series.reduce((a, s) => a + s.valor, 0);
  const total = soma || 1;
  const R = 62, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <svg viewBox="0 0 160 160" className="h-36 w-36 flex-shrink-0 overflow-visible" role="img" aria-label={g.titulo}>
        <defs><filter id={`g${uid}`} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.5" /></filter></defs>
        <g transform="rotate(-90 80 80)">
        <circle cx="80" cy="80" r={R} fill="none" stroke="rgba(148,163,230,0.1)" strokeWidth="16" />
        {g.series.map((s, i) => {
          const frac = s.valor / total;
          const len = Math.max(0, frac * C - (g.series.length > 1 ? 3 : 0));
          const el = (
            <g key={s.rotulo}>
              <circle cx="80" cy="80" r={R} fill="none" stroke={cor(s, i)} strokeWidth="16" strokeDasharray={`${len} ${C}`} strokeDashoffset={-acc * C} opacity="0.45" filter={`url(#g${uid})`} />
              <circle cx="80" cy="80" r={R} fill="none" stroke={cor(s, i)} strokeWidth="14" strokeLinecap="butt" strokeDasharray={`${len} ${C}`} strokeDashoffset={-acc * C} className={estatico ? '' : 'dash-fade'} />
            </g>
          );
          acc += frac;
          return el;
        })}
        </g>
        <g>
          <text x="80" y="80" textAnchor="middle" className="fill-white font-display" fontSize="24" fontWeight="700">{fmt(soma)}</text>
          <text x="80" y="98" textAnchor="middle" className="fill-slate-400 font-mono" fontSize="9" letterSpacing="2">TOTAL</text>
        </g>
      </svg>
      <ul className="w-full min-w-0 space-y-1.5">
        {g.series.map((s, i) => (
          <li key={s.rotulo} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: cor(s, i), boxShadow: `0 0 10px ${cor(s, i)}` }} />
            <span className="min-w-0 flex-1 truncate capitalize text-slate-300" title={s.rotulo}>{s.rotulo}</span>
            <span className="font-mono text-slate-100">{fmt(s.valor, g.formato)}</span>
            <span className="w-10 text-right font-mono text-slate-500">{Math.round((s.valor / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BarrasH({ g, estatico }: { g: DashGrafico; estatico?: boolean }) {
  const max = Math.max(1, ...g.series.map((s) => s.valor));
  return (
    <ul className="space-y-2.5">
      {g.series.map((s, i) => (
        <li key={`${s.rotulo}-${i}`}>
          <div className="mb-1 flex items-baseline gap-2 text-xs">
            <span className="font-mono text-[10px] text-slate-500">{String(i + 1).padStart(2, '0')}</span>
            <span className="min-w-0 flex-1 truncate text-slate-200" title={s.rotulo}>{s.rotulo}</span>
            <span className="font-mono text-cyan-200">{fmt(s.valor, g.formato)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800/70">
            <div
              className={estatico ? 'h-full rounded-full' : 'dash-grow h-full rounded-full'}
              style={{
                width: `${Math.max(2, (s.valor / max) * 100)}%`,
                background: s.cor ?? 'linear-gradient(90deg, #12baea, #3d22f0 60%, #c874f8)',
                boxShadow: '0 0 12px rgba(18,186,234,0.55)',
                animationDelay: estatico ? undefined : `${i * 60}ms`,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Colunas({ g, estatico }: { g: DashGrafico; estatico?: boolean }) {
  const max = Math.max(1, ...g.series.map((s) => s.valor));
  return (
    <div className="flex h-44 items-end gap-2 border-b border-slate-700/60 pb-0">
      {g.series.map((s, i) => (
        <div key={`${s.rotulo}-${i}`} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${s.rotulo}: ${fmt(s.valor, g.formato)}`}>
          <span className="font-mono text-[10px] text-cyan-100">{fmt(s.valor, g.formato)}</span>
          <div
            className={estatico ? 'w-full max-w-[42px] rounded-t-md' : 'dash-rise w-full max-w-[42px] rounded-t-md'}
            style={{
              height: `${Math.max(3, (s.valor / max) * 78)}%`,
              background: s.cor ?? `linear-gradient(180deg, ${PALETA[i % 2 ? 3 : 0]}, rgba(61,34,240,0.35))`,
              boxShadow: `0 0 16px -2px ${PALETA[i % 2 ? 3 : 0]}88`,
              animationDelay: estatico ? undefined : `${i * 50}ms`,
            }}
          />
          <span className="w-full truncate text-center text-[10px] text-slate-400" title={s.rotulo}>{s.rotulo}</span>
        </div>
      ))}
    </div>
  );
}

export function Grafico({ g, estatico }: { g: DashGrafico; estatico?: boolean }) {
  if (!g.series.length) return <p className="text-xs text-slate-500">Sem dados no período.</p>;
  switch (g.tipo) {
    case 'linha': return <Linha g={g} estatico={estatico} />;
    case 'rosca': return <Rosca g={g} estatico={estatico} />;
    case 'barras': return <Colunas g={g} estatico={estatico} />;
    default: return <BarrasH g={g} estatico={estatico} />;
  }
}
