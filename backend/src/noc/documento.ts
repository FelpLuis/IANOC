/**
 * Identidade visual e geração de documentos da NIA.
 *
 * Identidade: nome da empresa, rodapé, cores (automáticas a partir do logo enviado ou
 * escolhidas), logo e molde padrão. Fica em <dados>/kb/identidade.json.
 *
 * Documento: qualquer resposta (relatório, manual, pesquisa, alarmes) vira um documento
 * HTML pronto para imprimir/salvar em PDF, com logo no cabeçalho, cores da marca e rodapé.
 * Com um molde (PDF de relatório enviado), as seções saem na ordem e com os títulos do
 * molde: cada seção do molde recebe a parte da resposta de mesmo assunto; o que não casar
 * vai para "Outras informações".
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

/**
 * Markdown → HTML sem brecha para script: HTML cru é escapado (vira texto) e link/imagem só
 * aceitam http(s), mailto, âncora ou imagem data: — nada de "javascript:".
 */
const escHtml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const urlSegura = (u: string, imagem = false) => {
  const v = u.trim();
  if (/^(https?:|mailto:)/i.test(v) || v.startsWith('#')) return v;
  if (imagem && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v)) return v;
  return '';
};
const mdSeguro = new Marked({
  renderer: {
    html({ text }) { return escHtml(text); },
    link({ href, title, tokens }) {
      const url = urlSegura(href);
      const texto = this.parser.parseInline(tokens);
      return url ? `<a href="${escHtml(url)}"${title ? ` title="${escHtml(title)}"` : ''} rel="noopener noreferrer">${texto}</a>` : texto;
    },
    image({ href, title, text }) {
      const url = urlSegura(href, true);
      return url ? `<img src="${escHtml(url)}" alt="${escHtml(text)}"${title ? ` title="${escHtml(title)}"` : ''}>` : escHtml(text);
    },
  },
});
import { caminhoArquivo, obter } from './kb.js';

export interface Identidade {
  empresa: string;
  slogan?: string;
  rodape: string;
  cores: { primaria: string; secundaria: string; destaque: string };
  logoId?: string;
  moldePadraoId?: string;
}

const ARQ = path.join(path.dirname(process.env.DB_PATH || './data/agent.json'), 'kb', 'identidade.json');
const PADRAO: Identidade = {
  empresa: 'UpDown Internet',
  slogan: 'Centro de Operações de Rede',
  rodape: 'UpDown Internet · NOC · documento gerado pela NIA',
  // Identidade visual da UpDown: azul da marca, azul-noite para títulos e o roxo da logo.
  cores: { primaria: '#1a00a8', secundaria: '#0d0457', destaque: '#a40ae8' },
};

// Logo oficial (versão para fundo claro) usada quando nenhum logo foi enviado na base.
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PADRAO = [
  process.env.FRONTEND_DIST && path.join(process.env.FRONTEND_DIST, 'brand/updown-internet-escuro.png'),
  path.resolve(AQUI, '../../../frontend/dist/brand/updown-internet-escuro.png'),
  path.resolve(AQUI, '../../../frontend/public/brand/updown-internet-escuro.png'),
].filter(Boolean) as string[];

export function lerIdentidade(): Identidade {
  try { return existsSync(ARQ) ? { ...PADRAO, ...(JSON.parse(readFileSync(ARQ, 'utf8')) as Partial<Identidade>) } : PADRAO; } catch { return PADRAO; }
}

const HEX = /^#[0-9a-f]{6}$/i;
export function salvarIdentidade(p: Partial<Identidade>): Identidade {
  const atual = lerIdentidade();
  const cores = { ...atual.cores, ...(p.cores ?? {}) };
  for (const k of Object.keys(cores) as Array<keyof Identidade['cores']>) if (!HEX.test(cores[k])) cores[k] = atual.cores[k];
  const nova: Identidade = {
    empresa: String(p.empresa ?? atual.empresa).slice(0, 120),
    slogan: p.slogan !== undefined ? String(p.slogan).slice(0, 160) : atual.slogan,
    rodape: String(p.rodape ?? atual.rodape).slice(0, 300),
    cores,
    logoId: p.logoId !== undefined ? (p.logoId || undefined) : atual.logoId,
    moldePadraoId: p.moldePadraoId !== undefined ? (p.moldePadraoId || undefined) : atual.moldePadraoId,
  };
  mkdirSync(path.dirname(ARQ), { recursive: true });
  writeFileSync(`${ARQ}.tmp`, JSON.stringify(nova, null, 2));
  renameSync(`${ARQ}.tmp`, ARQ);
  return nova;
}

// ------------------------------------------------------------------ montagem do documento

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const palavras = (s: string) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));

interface Secao { titulo: string; corpo: string }

/**
 * Quebra o Markdown em blocos: cada "## " é um bloco inteiro (com seus "### " dentro). Antes
 * do primeiro "## ", os "### " (ex.: "Pontos de atenção" da análise) também viram blocos.
 * O título "# " vira o título do documento.
 */
function secoes(md: string): { titulo?: string; intro: string; secoes: Secao[] } {
  const linhas = md.split('\n');
  const temH2 = linhas.some((l) => /^##\s+/.test(l));
  let titulo: string | undefined;
  const intro: string[] = [];
  const out: Secao[] = [];
  let atual: Secao | null = null;
  let viuH2 = false;
  for (const l of linhas) {
    const h1 = l.match(/^#\s+(.+)/);
    const h2 = l.match(/^##\s+(.+)/);
    const h3 = l.match(/^###\s+(.+)/);
    if (h1 && !titulo && !atual) { titulo = h1[1].trim(); continue; }
    if (h2) { viuH2 = true; atual = { titulo: h2[1].trim(), corpo: '' }; out.push(atual); continue; }
    if (h3 && (!temH2 || !viuH2)) { atual = { titulo: h3[1].trim(), corpo: '' }; out.push(atual); continue; }
    if (atual) atual.corpo += `${l}\n`; else intro.push(l);
  }
  return { titulo, intro: intro.join('\n').trim(), secoes: out };
}

/** Encaixa as seções da resposta nas seções do molde, por semelhança de assunto. */
function encaixarNoMolde(md: string, molde: { titulo: string }[]): { titulo?: string; corpo: string } {
  const s = secoes(md);
  const usadas = new Set<number>();
  const partes: string[] = [];
  molde.forEach((m, mi) => {
    const pm = palavras(m.titulo);
    let melhor = -1, melhorScore = 0;
    s.secoes.forEach((sec, i) => {
      if (usadas.has(i)) return;
      // O título decide; o começo do texto só desempata (peso baixo).
      const pt = palavras(sec.titulo);
      const pc = palavras(sec.corpo.slice(0, 200));
      const casa = (set: Set<string>, w: string) => [...set].some((x) => x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)));
      let noTitulo = 0, noCorpo = 0;
      for (const w of pm) { if (casa(pt, w)) noTitulo++; else if (casa(pc, w)) noCorpo++; }
      const score = pm.size ? (noTitulo + noCorpo * 0.25) / pm.size : 0;
      if (score > melhorScore) { melhorScore = score; melhor = i; }
    });
    let corpo = '';
    if (melhor >= 0 && melhorScore >= 0.34) { usadas.add(melhor); corpo = s.secoes[melhor].corpo.trim(); }
    // A primeira seção do molde (normalmente "Resumo/Introdução") recebe a abertura da resposta.
    if (mi === 0 && s.intro) corpo = `${s.intro}\n\n${corpo}`.trim();
    partes.push(`## ${m.titulo}\n\n${corpo || '_Sem dados para esta seção neste documento._'}`);
  });
  const resto = s.secoes.filter((_, i) => !usadas.has(i));
  if (resto.length) partes.push(`## Outras informações\n\n${resto.map((r) => `### ${r.titulo}\n\n${r.corpo.trim()}`).join('\n\n')}`);
  return { titulo: s.titulo, corpo: partes.join('\n\n') };
}

const dataUrl = (arquivo: string, mime = 'image/png') => `data:${mime};base64,${readFileSync(arquivo).toString('base64')}`;
// Versão branca do logo oficial, para a faixa escura do topo.
const LOGO_BRANCO = LOGO_PADRAO.map((p) => p.replace('updown-internet-escuro.png', 'updown-internet-branco.png'));

/** Logo da faixa do topo: o enviado na base (num selo claro) ou o oficial branco. */
function logoDoTopo(id?: string): { src?: string; selo: boolean } {
  const d = id ? obter(id) : undefined;
  if (d && existsSync(caminhoArquivo(d))) return { src: dataUrl(caminhoArquivo(d), d.ext === 'svg' ? 'image/svg+xml' : d.mime || `image/${d.ext}`), selo: true };
  const branco = LOGO_BRANCO.find((p) => existsSync(p));
  if (branco) return { src: dataUrl(branco), selo: false };
  const escuro = LOGO_PADRAO.find((p) => existsSync(p));
  return { src: escuro ? dataUrl(escuro) : undefined, selo: true };
}

/** Indicadores do dashboard (quando a resposta tem um), mostrados no topo do documento. */
export interface KpiDoc { rotulo: string; valor: string; detalhe?: string; tom?: string }
const TOM_DOC: Record<string, string> = { ok: '#0fb39a', atencao: '#d99a00', critico: '#e5135c', info: '#0b8fc4', marca: '#8a08c4' };

export function gerarDocumento(opts: {
  markdown: string; moldeId?: string; autor?: string;
  kpis?: KpiDoc[]; status?: { texto: string; tom?: string }; periodo?: string;
}): string {
  const id = lerIdentidade();
  const molde = opts.moldeId ? obter(opts.moldeId) : (id.moldePadraoId ? obter(id.moldePadraoId) : undefined);
  const usarMolde = molde?.tipo === 'molde' && molde.secoes?.length;
  const base = usarMolde ? encaixarNoMolde(opts.markdown, molde!.secoes!) : (() => { const s = secoes(opts.markdown); return { titulo: s.titulo, corpo: opts.markdown.replace(/^#\s+.+\n?/, '') }; })();
  const titulo = base.titulo ?? (opts.markdown.match(/^#{1,3}\s+(.+)$/m)?.[1] ?? 'Documento NIA');
  // HTML cru no Markdown vira texto (o conteúdo pode vir da web, do modelo ou de um atendimento);
  // só depois de renderizado as citações " [n]" viram <sup>.
  const html = (mdSeguro.parse(base.corpo, { async: false }) as string).replace(/(\s)\[(\d{1,2})\]/g, '$1<sup>[$2]</sup>');
  const logo = logoDoTopo(id.logoId);
  const quando = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date());
  const { primaria, secundaria, destaque } = id.cores;
  const cab = molde?.cabecalho && usarMolde ? `<div class="molde-cab">${esc(molde.cabecalho)}</div>` : '';
  const kpis = (opts.kpis ?? []).slice(0, 6);
  const corStatus = TOM_DOC[opts.status?.tom ?? ''] ?? primaria;
  const kpisHtml = kpis.length
    ? `<div class="kpis">${kpis.map((k) => `<div class="kpi" style="--c:${TOM_DOC[k.tom ?? ''] ?? primaria}"><span>${esc(k.rotulo)}</span><b>${esc(k.valor)}</b>${k.detalhe ? `<em>${esc(k.detalhe)}</em>` : ''}</div>`).join('')}</div>`
    : '';
  const logoHtml = !logo.src ? '' : logo.selo ? `<span class="selo"><img src="${logo.src}" alt="logo"></span>` : `<img src="${logo.src}" alt="logo">`;

  // A CSP vai também no próprio HTML: o navegador escreve o documento numa janela da NIA
  // (document.write), onde o cabeçalho da resposta não vale. Nenhum script roda aqui.
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${esc(titulo)}</title>
<style>
  @page { size: A4; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 10.5pt/1.6 "Segoe UI", Inter, system-ui, -apple-system, sans-serif; color: #1e1b4b; margin: 0; background: #fff; }
  .pagina { max-width: 900px; margin: 0 auto; padding: 18px 16px 28px; }
  /* Faixa do topo: degradê da marca com a grade da NIA */
  .topo { position: relative; overflow: hidden; display: flex; align-items: center; gap: 18px; padding: 20px 24px; border-radius: 16px; color: #fff;
    background: linear-gradient(115deg, ${secundaria} 0%, ${primaria} 50%, ${destaque} 100%); }
  .topo::before { content: ""; position: absolute; inset: 0; opacity: .16;
    background-image: linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px);
    background-size: 26px 26px; -webkit-mask-image: linear-gradient(90deg, transparent 20%, #000); mask-image: linear-gradient(90deg, transparent 20%, #000); }
  .topo::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: linear-gradient(90deg, #12baea, rgba(255,255,255,.6), #c874f8); }
  .topo > * { position: relative; }
  .topo img { max-height: 46px; max-width: 190px; object-fit: contain; display: block; }
  .topo .selo { background: #fff; border-radius: 10px; padding: 6px 10px; }
  .topo .emp { flex: 1; min-width: 0; padding-left: 16px; border-left: 1px solid rgba(255,255,255,.35); }
  .topo .emp small { display: block; font: 600 7.5pt/1.2 Consolas, "JetBrains Mono", monospace; letter-spacing: .26em; text-transform: uppercase; opacity: .85; }
  .topo .emp strong { display: block; font-size: 14pt; margin-top: 3px; }
  .topo .data { text-align: right; font-size: 8.5pt; opacity: .92; }
  .molde-cab { color: #64748b; font-size: 9pt; margin-top: 8px; }
  .cabeca { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin: 22px 0 0; }
  h1.titulo { font-size: 20pt; line-height: 1.15; color: ${secundaria}; margin: 0; letter-spacing: -.01em; }
  .periodo { color: #6a7096; font-size: 9.5pt; margin-top: 4px; }
  .status { flex-shrink: 0; display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px; border-radius: 999px; font: 700 7.5pt/1 Consolas, monospace; letter-spacing: .16em; text-transform: uppercase;
    color: ${corStatus}; border: 1px solid ${corStatus}66; background: ${corStatus}12; }
  .status i { width: 7px; height: 7px; border-radius: 50%; background: ${corStatus}; }
  .faixa { height: 4px; border-radius: 2px; margin: 12px 0 18px; background: linear-gradient(90deg, #12baea, ${primaria} 40%, ${destaque} 70%, transparent); }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 0 0 18px; }
  .kpi { position: relative; padding: 11px 14px 11px 17px; border-radius: 12px; background: linear-gradient(180deg, #f7f5ff, #fff); border: 1px solid #e6e2fb; break-inside: avoid; overflow: hidden; }
  .kpi::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--c); }
  .kpi span { display: block; font: 600 7pt/1.3 Consolas, monospace; letter-spacing: .14em; text-transform: uppercase; color: #6a7096; }
  .kpi b { display: block; font-size: 17pt; line-height: 1.2; margin-top: 4px; color: ${secundaria}; }
  .kpi em { display: block; font-style: normal; font-size: 8pt; color: #6a7096; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  h2 { display: flex; align-items: center; gap: 9px; font-size: 13pt; color: ${secundaria}; margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e6e2fb; break-after: avoid; }
  h2::before { content: ""; width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; background: linear-gradient(135deg, #12baea, ${destaque}); }
  h3 { font-size: 10pt; color: ${primaria}; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .06em; break-after: avoid; }
  p { margin: 6px 0 10px; }
  ul { padding-left: 18px; } li { margin: 3px 0; } li::marker { color: ${destaque}; }
  table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 8px 0 16px; font-size: 8.8pt; border: 1px solid #e6e2fb; border-radius: 10px; overflow: hidden; }
  th { background: linear-gradient(90deg, ${secundaria}, ${primaria}); color: #fff; text-align: left; padding: 7px 10px; font: 600 7.5pt/1.2 Consolas, monospace; letter-spacing: .1em; text-transform: uppercase; }
  td { border-top: 1px solid #efedfb; padding: 6px 10px; vertical-align: top; }
  tr:nth-child(even) td { background: #faf9ff; }
  tr { break-inside: avoid; }
  blockquote { border-left: 4px solid ${destaque}; margin: 12px 0; padding: 8px 14px; border-radius: 0 10px 10px 0; background: linear-gradient(90deg, #f6f0fe, #fbf9ff); color: #3f065a; }
  blockquote p { margin: 0; }
  hr { border: 0; height: 1px; background: #e6e2fb; margin: 20px 0; }
  a { color: ${primaria}; }
  sup { color: ${primaria}; font-size: 7pt; }
  code { background: #f1effc; padding: 1px 5px; border-radius: 4px; font-size: 8.5pt; }
  .rodape { margin-top: 30px; padding-top: 10px; border-top: 1px solid #e6e2fb; color: #6a7096; font-size: 8pt; display: flex; justify-content: space-between; gap: 12px; }
  .rodape b { font: 600 7pt Consolas, monospace; letter-spacing: .18em; text-transform: uppercase; color: ${primaria}; }
  .acoes { position: fixed; bottom: 16px; right: 16px; }
  .acoes button { background: linear-gradient(90deg, #12baea, ${primaria} 55%, ${destaque}); color: #fff; border: 0; border-radius: 10px; padding: 10px 16px; font: 600 10pt "Segoe UI", sans-serif; cursor: pointer; box-shadow: 0 8px 24px -8px ${primaria}; }
  @media print { .acoes { display: none; } .pagina { padding: 0; } }
</style></head><body>
<div class="acoes"><button type="button" data-imprimir>Imprimir / salvar PDF</button></div>
<div class="pagina">
<div class="topo">
  ${logoHtml}
  <div class="emp"><small>NIA · ${esc(id.slogan || 'Centro de Operações de Rede')}</small><strong>${esc(id.empresa)}</strong></div>
  <div class="data">${esc(quando)}${opts.autor ? `<br>${esc(opts.autor)}` : ''}${usarMolde ? `<br>Molde: ${esc(molde!.nome)}` : ''}</div>
</div>
${cab}
<div class="cabeca">
  <div><h1 class="titulo">${esc(titulo.replace(/[*_`]/g, ''))}</h1>${opts.periodo ? `<div class="periodo">${esc(opts.periodo)}</div>` : ''}</div>
  ${opts.status ? `<span class="status"><i></i>${esc(opts.status.texto)}</span>` : ''}
</div>
<div class="faixa"></div>
${kpisHtml}
${html}
<div class="rodape"><span>${esc(id.rodape)}</span><b>Gerado pela NIA · IA NOC</b></div>
</div>
</body></html>`;
}
