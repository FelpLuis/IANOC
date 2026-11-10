/**
 * Base de conhecimento e identidade visual da NIA.
 * Arquivos: envia PDF/TXT/MD (documentos), PDF de relatório modelo (molde), logo e imagens.
 * Identidade: empresa, rodapé, cores (vindas do logo), logo e molde padrão dos documentos.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, Image as ImageIcon, LayoutTemplate, Loader2, Palette, Trash2, Upload, X } from 'lucide-react';
import { cn } from '../utils/helpers';

type Tipo = 'documento' | 'molde' | 'logo' | 'imagem';
interface Arquivo {
  id: string; nome: string; tipo: Tipo; tamanho: number; criadoEm: string; paginas?: number; trechos: number;
  secoes?: Array<{ titulo: string }>; tituloMolde?: string; cores?: string[]; aviso?: string;
}
interface Identidade {
  empresa: string; slogan?: string; rodape: string;
  cores: { primaria: string; secundaria: string; destaque: string };
  logoId?: string; moldePadraoId?: string;
}

const TIPOS: Array<{ v: Tipo; label: string; dica: string; aceita: string; icon: typeof FileText }> = [
  { v: 'documento', label: 'Documento', dica: 'Manuais, procedimentos, POPs (PDF, TXT, MD): a NIA usa nas respostas.', aceita: '.pdf,.txt,.md,.csv', icon: BookOpen },
  { v: 'molde', label: 'Molde de relatório', dica: 'PDF de um relatório modelo: os documentos gerados seguem as seções dele.', aceita: '.pdf', icon: LayoutTemplate },
  { v: 'logo', label: 'Logo', dica: 'PNG/JPG/SVG: vai no cabeçalho dos documentos; as cores da marca saem dele.', aceita: '.png,.jpg,.jpeg,.webp,.svg', icon: Palette },
  { v: 'imagem', label: 'Imagem', dica: 'Outras imagens da identidade visual.', aceita: '.png,.jpg,.jpeg,.webp,.svg', icon: ImageIcon },
];

const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function KnowledgePanel({ onClose }: { onClose: () => void }) {
  const [aba, setAba] = useState<'arquivos' | 'identidade'>('arquivos');
  const [arquivos, setArquivos] = useState<Arquivo[]>([]);
  const [ident, setIdent] = useState<Identidade | null>(null);
  const [tipo, setTipo] = useState<Tipo>('documento');
  const [enviando, setEnviando] = useState(false);
  const [msg, setMsg] = useState<{ tom: 'ok' | 'erro'; texto: string } | null>(null);
  const [arrastando, setArrastando] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const carregar = useCallback(async () => {
    const r = await fetch('/api/kb', { credentials: 'same-origin' });
    if (!r.ok) return;
    const j = await r.json();
    setArquivos(j.arquivos);
    setIdent(j.identidade);
  }, []);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const enviar = async (files: FileList | File[]) => {
    setEnviando(true);
    setMsg(null);
    let ok = 0;
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.append('tipo', tipo);
      fd.append('arquivo', f);
      const r = await fetch('/api/kb', { method: 'POST', body: fd, credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ tom: 'erro', texto: `${f.name}: ${j.error || `HTTP ${r.status}`}` }); continue; }
      ok++;
      const a = j.arquivo as Arquivo;
      setMsg({ tom: a.aviso ? 'erro' : 'ok', texto: a.aviso ? `${a.nome}: ${a.aviso}` : `${a.nome}: aprendido${a.secoes?.length ? ` (${a.secoes.length} seções do molde)` : a.trechos ? ` (${a.trechos} trechos)` : a.cores?.length ? ' (cores aplicadas)' : ''}.` });
    }
    if (ok) await carregar();
    setEnviando(false);
  };

  const remover = async (a: Arquivo) => {
    if (!confirm(`Remover "${a.nome}" da base? A NIA deixa de usar este arquivo.`)) return;
    await fetch(`/api/kb/${a.id}`, { method: 'DELETE', credentials: 'same-origin' });
    carregar();
  };

  const salvar = async () => {
    if (!ident) return;
    const r = await fetch('/api/identidade', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ident) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return setMsg({ tom: 'erro', texto: j.error || 'Não foi possível salvar.' });
    setIdent(j);
    setMsg({ tom: 'ok', texto: 'Identidade visual salva. Os próximos documentos já saem com ela.' });
  };

  const logos = arquivos.filter((a) => a.tipo === 'logo');
  const moldes = arquivos.filter((a) => a.tipo === 'molde');
  const tipoAtual = TIPOS.find((t) => t.v === tipo)!;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 backdrop-blur-sm sm:items-center animate-fade-in" onClick={onClose}>
      <div className="glass hud-corners flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl sm:w-[760px] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-sky-400/10 px-5 py-3">
          <BookOpen className="h-5 w-5 text-cyan-300" />
          <div className="flex-1">
            <div className="font-semibold text-slate-50">Base e identidade</div>
            <div className="hud-label">o que a NIA aprende com os seus arquivos</div>
          </div>
          <button type="button" onClick={onClose} className="icon-btn"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex gap-1 border-b border-sky-400/10 px-4 pt-2">
          {(['arquivos', 'identidade'] as const).map((a) => (
            <button key={a} type="button" onClick={() => setAba(a)} className={cn('rounded-t-lg px-3 py-1.5 text-sm transition-colors', aba === a ? 'bg-cyan-400/15 text-cyan-100' : 'text-slate-400 hover:text-slate-200')}>
              {a === 'arquivos' ? `Arquivos (${arquivos.length})` : 'Identidade visual'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5 scrollbar-thin">
          {msg && <div className={cn('mb-3 rounded-lg border px-3 py-2 text-sm', msg.tom === 'ok' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100' : 'border-amber-400/30 bg-amber-400/10 text-amber-100')}>{msg.texto}</div>}

          {aba === 'arquivos' && (
            <>
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {TIPOS.map((t) => (
                  <button key={t.v} type="button" onClick={() => setTipo(t.v)} className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-all', tipo === t.v ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-100' : 'border-slate-700/60 text-slate-400 hover:text-slate-200')}>
                    <t.icon className="h-4 w-4 flex-shrink-0" /> {t.label}
                  </button>
                ))}
              </div>
              <div
                onClick={() => input.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
                onDragLeave={() => setArrastando(false)}
                onDrop={(e) => { e.preventDefault(); setArrastando(false); if (e.dataTransfer.files.length) enviar(e.dataTransfer.files); }}
                className={cn('flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-all', arrastando ? 'border-cyan-300 bg-cyan-400/10' : 'border-slate-700 hover:border-cyan-400/50')}
              >
                {enviando ? <Loader2 className="h-6 w-6 animate-spin text-cyan-300" /> : <Upload className="h-6 w-6 text-cyan-300" />}
                <div className="text-sm text-slate-200">{enviando ? 'Lendo e aprendendo…' : `Arraste ou clique para enviar: ${tipoAtual.label.toLowerCase()}`}</div>
                <div className="text-xs text-slate-500">{tipoAtual.dica} Até 25 MB por arquivo.</div>
                <input ref={input} type="file" multiple accept={tipoAtual.aceita} className="hidden" onChange={(e) => { if (e.target.files?.length) enviar(e.target.files); e.target.value = ''; }} />
              </div>

              <ul className="mt-4 space-y-2">
                {arquivos.length === 0 && <li className="text-sm text-slate-500">Nenhum arquivo ainda.</li>}
                {[...arquivos].reverse().map((a) => {
                  const T = TIPOS.find((t) => t.v === a.tipo)!;
                  return (
                    <li key={a.id} className="flex items-start gap-3 rounded-lg border border-slate-700/60 bg-slate-900/50 px-3 py-2">
                      {(a.tipo === 'logo' || a.tipo === 'imagem')
                        ? <img src={`/api/kb/${a.id}/arquivo`} alt="" className="h-9 w-9 flex-shrink-0 rounded bg-white object-contain p-0.5" />
                        : <T.icon className="mt-1 h-5 w-5 flex-shrink-0 text-cyan-300" />}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-slate-100" title={a.nome}>{a.nome}</div>
                        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400">
                          <span>{T.label}</span><span>· {kb(a.tamanho)}</span>
                          {a.paginas ? <span>· {a.paginas} pág.</span> : null}
                          {a.trechos ? <span>· {a.trechos} trechos</span> : null}
                          {a.secoes?.length ? <span>· {a.secoes.length} seções</span> : null}
                          {a.cores?.map((c) => <span key={c} className="inline-block h-3 w-3 rounded-sm border border-white/20" style={{ background: c }} title={c} />)}
                        </div>
                        {a.secoes?.length ? <div className="mt-0.5 truncate text-[11px] text-slate-500">{a.secoes.map((s) => s.titulo).join(' · ')}</div> : null}
                        {a.aviso && <div className="mt-0.5 text-[11px] text-amber-300">{a.aviso}</div>}
                      </div>
                      <button type="button" onClick={() => remover(a)} className="icon-btn p-1.5" title="Remover"><Trash2 className="h-4 w-4" /></button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {aba === 'identidade' && ident && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block"><span className="hud-label">Empresa</span><input className="input mt-1" value={ident.empresa} onChange={(e) => setIdent({ ...ident, empresa: e.target.value })} /></label>
                <label className="block"><span className="hud-label">Subtítulo</span><input className="input mt-1" value={ident.slogan ?? ''} onChange={(e) => setIdent({ ...ident, slogan: e.target.value })} /></label>
              </div>
              <label className="block"><span className="hud-label">Rodapé dos documentos</span><input className="input mt-1" value={ident.rodape} onChange={(e) => setIdent({ ...ident, rodape: e.target.value })} /></label>
              <div>
                <span className="hud-label">Cores (vêm do logo; dá para ajustar)</span>
                <div className="mt-1 flex flex-wrap gap-4">
                  {(['primaria', 'secundaria', 'destaque'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-2 text-sm text-slate-300">
                      <input type="color" value={ident.cores[k]} onChange={(e) => setIdent({ ...ident, cores: { ...ident.cores, [k]: e.target.value } })} className="h-8 w-10 cursor-pointer rounded border border-slate-600 bg-transparent" />
                      {k === 'primaria' ? 'Primária' : k === 'secundaria' ? 'Secundária' : 'Destaque'}
                    </label>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block"><span className="hud-label">Logo</span>
                  <select className="input mt-1" value={ident.logoId ?? ''} onChange={(e) => setIdent({ ...ident, logoId: e.target.value })}>
                    <option value="">Sem logo</option>
                    {logos.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
                  </select>
                </label>
                <label className="block"><span className="hud-label">Molde padrão dos documentos</span>
                  <select className="input mt-1" value={ident.moldePadraoId ?? ''} onChange={(e) => setIdent({ ...ident, moldePadraoId: e.target.value })}>
                    <option value="">Sem molde (estrutura da própria resposta)</option>
                    {moldes.map((m) => <option key={m.id} value={m.id}>{m.tituloMolde || m.nome}</option>)}
                  </select>
                </label>
              </div>
              {/* prévia */}
              <div className="rounded-xl bg-white p-4 text-slate-800">
                <div className="flex items-center gap-3 border-b-[3px] pb-2" style={{ borderColor: ident.cores.primaria }}>
                  {ident.logoId && <img src={`/api/kb/${ident.logoId}/arquivo`} alt="" className="h-10 max-w-[140px] object-contain" />}
                  <div><div className="font-bold" style={{ color: ident.cores.secundaria }}>{ident.empresa}</div><div className="text-xs text-slate-500">{ident.slogan}</div></div>
                </div>
                <div className="mt-2 text-lg font-bold" style={{ color: ident.cores.secundaria }}>Título do documento</div>
                <div className="mb-2 h-1 w-16 rounded" style={{ background: ident.cores.destaque }} />
                <div className="text-sm font-semibold" style={{ color: ident.cores.primaria }}>Seção do relatório</div>
                <div className="mt-2 border-t pt-1 text-[11px] text-slate-500">{ident.rodape}</div>
              </div>
              <button type="button" onClick={salvar} className="btn-primary">Salvar identidade</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
