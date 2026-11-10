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
import { marked } from 'marked';
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

function logoDataUrl(id?: string): string | undefined {
  const d = id ? obter(id) : undefined;
  if (!d || !existsSync(caminhoArquivo(d))) {
    const padrao = LOGO_PADRAO.find((p) => existsSync(p));
    return padrao ? `data:image/png;base64,${readFileSync(padrao).toString('base64')}` : undefined;
  }
  const mime = d.ext === 'svg' ? 'image/svg+xml' : d.mime || `image/${d.ext}`;
  return `data:${mime};base64,${readFileSync(caminhoArquivo(d)).toString('base64')}`;
}

export function gerarDocumento(opts: { markdown: string; moldeId?: string; autor?: string }): string {
  const id = lerIdentidade();
  const molde = opts.moldeId ? obter(opts.moldeId) : (id.moldePadraoId ? obter(id.moldePadraoId) : undefined);
  const usarMolde = molde?.tipo === 'molde' && molde.secoes?.length;
  const base = usarMolde ? encaixarNoMolde(opts.markdown, molde!.secoes!) : (() => { const s = secoes(opts.markdown); return { titulo: s.titulo, corpo: opts.markdown.replace(/^#\s+.+\n?/, '') }; })();
  const titulo = base.titulo ?? (opts.markdown.match(/^#{1,3}\s+(.+)$/m)?.[1] ?? 'Documento NIA');
  const html = marked.parse(base.corpo.replace(/\s\[(\d{1,2})\]/g, '<sup>[$1]</sup>'), { async: false }) as string;
  const logo = logoDataUrl(id.logoId);
  const quando = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date());
  const { primaria, secundaria, destaque } = id.cores;
  const cab = molde?.cabecalho && usarMolde ? `<div class="molde-cab">${esc(molde.cabecalho)}</div>` : '';

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.55 "Segoe UI", system-ui, -apple-system, sans-serif; color: #1f2937; margin: 0; }
  .topo { display: flex; align-items: center; gap: 16px; padding-bottom: 12px; border-bottom: 3px solid ${primaria}; }
  .topo img { max-height: 56px; max-width: 200px; object-fit: contain; }
  .topo .emp { flex: 1; }
  .topo .emp strong { display: block; font-size: 15pt; color: ${secundaria}; }
  .topo .emp span { color: #64748b; font-size: 9.5pt; }
  .topo .data { text-align: right; color: #64748b; font-size: 9pt; }
  .molde-cab { color: #64748b; font-size: 9pt; margin-top: 6px; }
  h1.titulo { font-size: 19pt; color: ${secundaria}; margin: 18px 0 4px; }
  .faixa { height: 4px; width: 80px; background: ${destaque}; border-radius: 2px; margin-bottom: 14px; }
  h2 { font-size: 13.5pt; color: ${primaria}; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-top: 22px; break-after: avoid; }
  h3 { font-size: 11.5pt; color: ${secundaria}; margin-top: 14px; break-after: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 14px; font-size: 9.5pt; }
  th { background: ${primaria}; color: #fff; text-align: left; padding: 5px 8px; }
  td { border-bottom: 1px solid #e2e8f0; padding: 4px 8px; vertical-align: top; }
  tr:nth-child(even) td { background: #f8fafc; }
  tr { break-inside: avoid; }
  blockquote { border-left: 4px solid ${destaque}; margin: 10px 0; padding: 4px 12px; background: #f6f0fe; color: #3f065a; }
  a { color: ${primaria}; }
  sup { color: ${primaria}; font-size: 7.5pt; }
  code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-size: 9pt; }
  .rodape { margin-top: 28px; padding-top: 8px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 8.5pt; display: flex; justify-content: space-between; gap: 12px; }
  .acoes { position: fixed; top: 12px; right: 12px; }
  .acoes button { background: ${primaria}; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font-size: 10pt; cursor: pointer; }
  @media print { .acoes { display: none; } }
</style></head><body>
<div class="acoes"><button onclick="window.print()">Imprimir / salvar PDF</button></div>
<div class="topo">
  ${logo ? `<img src="${logo}" alt="logo">` : ''}
  <div class="emp"><strong>${esc(id.empresa)}</strong>${id.slogan ? `<span>${esc(id.slogan)}</span>` : ''}</div>
  <div class="data">${esc(quando)}${opts.autor ? `<br>${esc(opts.autor)}` : ''}${usarMolde ? `<br>Molde: ${esc(molde!.nome)}` : ''}</div>
</div>
${cab}
<h1 class="titulo">${esc(titulo.replace(/[*_`]/g, ''))}</h1>
<div class="faixa"></div>
${html}
<div class="rodape"><span>${esc(id.rodape)}</span><span>Gerado pela NIA · IA NOC</span></div>
</body></html>`;
}
