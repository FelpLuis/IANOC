/**
 * Gerador de manuais e pesquisas a partir da web, sem modelo de linguagem.
 *
 * Extrativo: seleciona, ordena e organiza trechos das fontes lidas — não escreve texto
 * novo nem inventa passos. Cada item leva o número da fonte; no fim, a lista de fontes.
 *
 * Estrutura do manual: resumo · o que você precisa · passo a passo · dicas e cuidados · fontes.
 * Passo a passo vem, nesta ordem, de: listas numeradas relevantes > listas com título de
 * "passo/etapa/como" > frases no imperativo ("Acesse…", "Clique…").
 */

import { readPage, searchWeb, type PageContent } from './research.js';

const STOP = new Set('a o os as um uma uns umas de do da dos das no na nos nas em para por com sem que como e ou se ao aos à às é ser sua seu suas seus meu minha manual passo tutorial guia gere gerar faça fazer crie criar pesquise pesquisa sobre web internet me pra pro'.split(' '));
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const palavras = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));

const IMPERATIVO = /^(acesse|abra|clique|digite|selecione|configure|conecte|desconecte|verifique|insira|salve|reinicie|desligue|ligue|aguarde|entre|v[aá] (at[eé]|em|para)|escolha|marque|desmarque|preencha|confirme|copie|cole|instale|baixe|execute|rode|defina|altere|habilite|desabilite|ative|desative|localize|retire|remova|encaixe|aperte|pressione|segure|mantenha|teste|anote|cadastre|crie|adicione|exclua|apague|limpe|atualize|fa[cç]a|use|utilize|posicione|fixe|passe|identifique|confira)\b/i;
const PREREQ = /(voc[eê] (vai )?precisar|[eé] necess[aá]ri|requisit|antes de come[cç]ar|tenha em m[aã]os|certifique-se|ter acesso|materiais|ferramentas necess)/i;
const DICA = /(importante|aten[cç][aã]o|cuidado|dica|recomend|evite|nunca|n[aã]o (desligue|retire|remova|toque|dobre)|aviso|observa[cç][aã]o|lembre-se)/i;
const TITULO_PASSOS = /(passo|etapa|como (configurar|fazer|instalar|resetar)|procedimento|instru[cç]|configura[cç][aã]o)/i;

interface Trecho { texto: string; fonte: number; score: number }

const frases = (p: string) => p.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ú0-9])/).map((s) => s.trim()).filter((s) => s.length >= 40 && s.length <= 320);

function similar(a: string, b: string) {
  const A = new Set(palavras(a)); const B = new Set(palavras(b));
  if (!A.size || !B.size) return false;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / Math.min(A.size, B.size) > 0.7;
}

function unicos(lista: Trecho[], max: number): Trecho[] {
  const out: Trecho[] = [];
  for (const t of lista) {
    if (out.some((o) => similar(o.texto, t.texto))) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const cortar = (s: string, n = 260) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
const maiuscula = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const cite = (t: Trecho) => `${maiuscula(cortar(t.texto))} [${t.fonte}]`;

export interface Manual { markdown: string; fala: string; fontes: Array<{ n: number; title: string; url: string; site: string }>; lidas: number; buscadas: number }

/** Lê as melhores fontes do tema e monta o manual (modo "manual") ou a pesquisa (modo "pesquisa"). */
export async function buildManual(tema: string, modo: 'manual' | 'pesquisa', onPasso: (fase: string) => void = () => {}, links: string[] = []): Promise<Manual> {
  const consulta = modo === 'manual' && !/passo a passo|tutorial|como /i.test(tema) ? `${tema} passo a passo` : tema;
  onPasso('busca');
  let resultados: Array<{ url: string; title: string }>;
  if (links.length) {
    // Links informados pelo operador: lê exatamente esses, sem buscar.
    resultados = links.slice(0, 8).map((url) => ({ url, title: url }));
  } else {
    // Duas buscas (com "passo a passo" e com "tutorial") rendem mais fontes em português.
    const variacoes = modo === 'manual' ? [consulta, `${tema} tutorial`] : [tema, `${tema} o que é`];
    const listas = await Promise.all(variacoes.map((q) => searchWeb(q, 8).catch(() => [])));
    const vistos = new Set<string>();
    resultados = listas.flat().filter((r) => {
      let host = '';
      try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { return false; }
      if (vistos.has(host)) return false;
      vistos.add(host);
      return true;
    }).slice(0, 10);
  }
  onPasso('leitura');
  const lidas = (await Promise.allSettled(resultados.slice(0, 8).map((r) => readPage(r.url))))
    .map((p, i) => (p.status === 'fulfilled' && p.value ? { page: p.value, r: resultados[i] } : null))
    .filter((x): x is { page: PageContent; r: (typeof resultados)[number] } => Boolean(x))
    ;

  // Só fica a página que fala do assunto: título/abertura com as palavras "fortes" do tema
  // (sem verbos genéricos como "fazer", "configurar"). Descarta dicionário, página genérica etc.
  const GENERICOS = new Set('como fazer configurar instalar criar usar utilizar trocar resetar ligar conectar ajustar montar atualizar liberar habilitar acessar ver saber'.split(' '));
  const termos = palavras(tema);
  const fortes = termos.filter((t) => !GENERICOS.has(t));
  const cobertura = (p: PageContent) => {
    if (!fortes.length) return 1;
    const texto = palavras(`${p.title} ${p.headings.slice(0, 6).join(' ')} ${p.paragraphs.slice(0, 4).join(' ')}`);
    return fortes.filter((f) => texto.some((w) => w.startsWith(f) || f.startsWith(w))).length / fortes.length;
  };
  lidas.sort((a, b) => cobertura(b.page) - cobertura(a.page));
  // Link informado pelo operador vale mesmo sem as palavras do tema (foi escolha dele).
  if (!links.length) for (let i = lidas.length - 1; i >= 0; i--) if (cobertura(lidas[i].page) < 0.5) lidas.splice(i, 1);
  lidas.splice(5);

  const fontes = lidas.map(({ page }, i) => ({ n: i + 1, title: page.title, url: page.url, site: page.site }));
  const relevancia = (s: string) => {
    const ws = palavras(s);
    if (!ws.length) return 0;
    let hits = 0; for (const t of termos) if (ws.some((w) => w.startsWith(t) || t.startsWith(w))) hits++;
    return hits / Math.max(1, termos.length);
  };

  // Frases de todos os parágrafos, com relevância para o tema.
  const todas: Trecho[] = lidas.flatMap(({ page }, i) => page.paragraphs.flatMap((p, pi) => frases(p).map((f) => ({
    texto: f, fonte: i + 1, score: relevancia(f) + (pi < 3 ? 0.15 : 0) + (i === 0 ? 0.1 : 0),
  }))));

  const PASSO_N = /^(passo|etapa)\s*(\d{1,2})\s*[:.–—-]?\s*/i;
  const resumo = unicos([...todas].filter((t) => !IMPERATIVO.test(t.texto) && !PASSO_N.test(t.texto)).sort((a, b) => b.score - a.score), 3);
  const usados = (t: Trecho) => resumo.some((r) => similar(r.texto, t.texto));
  const noAssunto = (t: Trecho) => relevancia(t.texto) >= (fortes.length ? 0.25 : 0);
  const prereq = unicos(todas.filter((t) => PREREQ.test(t.texto) && noAssunto(t) && !PASSO_N.test(t.texto) && !usados(t)).sort((a, b) => b.score - a.score), 4);
  const dicas = unicos(todas.filter((t) => DICA.test(t.texto) && noAssunto(t) && !PREREQ.test(t.texto) && !PASSO_N.test(t.texto) && !usados(t) && !prereq.some((p) => similar(p.texto, t.texto))).sort((a, b) => b.score - a.score), 5);

  // Passo a passo.
  let passos: Trecho[] = [];
  if (modo === 'manual') {
    // 1º) "Passo 1…", "Etapa 2…" explícitos (título ou parágrafo), na ordem dos números.
    const explicitos = lidas.map(({ page }, i) => {
      const achados = new Map<number, string>();
      page.blocks.forEach((b, bi) => {
        const m = b.texto.match(PASSO_N);
        if (!m) return;
        const n = Number(m[2]);
        let texto = b.texto.replace(PASSO_N, '').trim();
        // Título curto ("Passo 2: Acesse o painel") ganha a primeira frase do parágrafo seguinte.
        const prox = page.blocks[bi + 1];
        if (b.tipo === 'h' && prox?.tipo === 'p' && texto.length < 80) texto = `${texto.replace(/[.:]$/, '')}: ${frases(prox.texto)[0] ?? prox.texto}`;
        if (texto.length >= 8 && !achados.has(n)) achados.set(n, texto);
      });
      return { fonte: i + 1, passos: [...achados.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t) };
    }).filter((x) => x.passos.length >= 3).sort((a, b) => b.passos.length - a.passos.length)[0];
    if (explicitos) passos = explicitos.passos.slice(0, 15).map((texto) => ({ texto, fonte: explicitos.fonte, score: 1 }));
  }
  if (modo === 'manual' && passos.length < 3) {
    const listas = lidas.flatMap(({ page }, i) => page.lists.map((l) => ({
      l, fonte: i + 1,
      score: (l.ordered ? 1 : 0) + (l.heading && TITULO_PASSOS.test(l.heading) ? 1 : 0)
        + l.items.filter((it) => IMPERATIVO.test(it)).length / l.items.length
        + l.items.reduce((acc, it) => acc + relevancia(it), 0) / l.items.length + relevancia(l.heading ?? ''),
    }))).filter((x) => x.l.items.length >= 3 && x.score >= 1.2).sort((a, b) => b.score - a.score);
    if (listas.length) passos = listas[0].l.items.slice(0, 15).map((texto) => ({ texto, fonte: listas[0].fonte, score: 1 }));
    if (passos.length < 3) {
      // Sem lista boa: frases no imperativo, na ordem em que aparecem na melhor fonte que as tem.
      const porFonte = new Map<number, Trecho[]>();
      for (const t of todas) if (IMPERATIVO.test(t.texto)) porFonte.set(t.fonte, [...(porFonte.get(t.fonte) ?? []), t]);
      const melhor = [...porFonte.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      if (melhor) passos = unicos(melhor[1], 12);
    }
  }
  // Pesquisa: pontos principais de listas relevantes.
  const pontos = modo === 'pesquisa'
    ? unicos(lidas.flatMap(({ page }, i) => page.lists.flatMap((l) => l.items.map((texto) => ({ texto, fonte: i + 1, score: relevancia(texto) + relevancia(l.heading ?? '') })))).filter((t) => t.score > 0).sort((a, b) => b.score - a.score), 8)
    : [];

  // Pedido só com link ("gere um manual a partir deste link"): o assunto é o título da página.
  const base = tema.trim().split(/\s+/).filter(Boolean).length >= 2 || !lidas[0] ? tema.trim() : lidas[0].page.title;
  const tituloTema = base.charAt(0).toUpperCase() + base.slice(1);
  tema = base;
  const md: string[] = [`# ${modo === 'manual' ? 'Manual' : 'Pesquisa'}: ${tituloTema}`];
  if (!lidas.length) {
    md.push('Não consegui ler nenhuma fonte em português sobre esse tema agora. Tente com outras palavras (modelo do equipamento, fabricante, sistema).');
    return { markdown: md.join('\n\n'), fala: 'Recalibrando… não encontrei fontes em português sobre esse tema. Tente com outras palavras.', fontes, lidas: 0, buscadas: resultados.length };
  }
  if (resumo.length) md.push(resumo.map(cite).join(' '));
  if (prereq.length) md.push('### O que você precisa', prereq.map((t) => `- ${cite(t)}`).join('\n'));
  if (modo === 'manual') {
    md.push('### Passo a passo', passos.length
      ? passos.map((t, i) => `${i + 1}. ${cite(t)}`).join('\n')
      : '_As fontes lidas não trazem um passo a passo claro. Veja os trechos acima e as fontes abaixo, ou refine o pedido com o modelo do equipamento._');
  }
  if (pontos.length) md.push('### Pontos principais', pontos.map((t) => `- ${cite(t)}`).join('\n'));
  if (dicas.length) md.push('### Dicas e cuidados', dicas.map((t) => `- ${cite(t)}`).join('\n'));
  md.push('### Fontes', fontes.map((f) => `${f.n}. [${f.title}](${f.url}) — ${f.site}`).join('\n'));
  md.push(`> Montado pela NIA a partir de ${fontes.length} ${fontes.length === 1 ? 'fonte' : 'fontes'} da web, com trechos curtos e citados. Confira o procedimento no manual do fabricante antes de aplicar em produção.`);

  const fala = `Pesquisa concluída, Chefe: li ${fontes.length} ${fontes.length === 1 ? 'fonte' : 'fontes'} sobre ${tema}.`
    + (modo === 'manual' ? (passos.length ? ` Montei um passo a passo com ${passos.length} etapas, ${prereq.length ? 'pré-requisitos, ' : ''}dicas e as fontes citadas.` : ' As fontes não trazem um passo a passo claro; deixei os trechos principais e as fontes.') : ' Resumo, pontos principais e fontes logo abaixo.');
  return { markdown: md.join('\n\n'), fala, fontes, lidas: lidas.length, buscadas: resultados.length };
}
