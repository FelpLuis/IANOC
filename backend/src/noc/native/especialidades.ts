/**
 * Especialidades técnicas da NIA: guias em knowledge/especialidades/*.md (Python para
 * monitoramento, projeto de redes de provedor, hardware/Arduino). Diferente dos documentos
 * da equipe (knowledge/*.md, que vão inteiros no contexto), os guias são divididos em seções
 * e só as seções relevantes para a pergunta acompanham a resposta.
 *
 * Também decide quando uma pergunta é técnica (área + pedido de código) para o motor nativo
 * mandá-la ao especialista em vez das consultas operacionais do NOC.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { nocConfig } from '../config.js';
import { norm } from './nlu.js';

export type Dominio = 'python' | 'redes' | 'hardware';
export const DOMINIO_NOME: Record<Dominio, string> = {
  python: 'desenvolvimento de software e scripts Python',
  redes: 'projeto de redes para provedores de internet',
  hardware: 'hardware, eletrônica e Arduino/ESP32',
};

export interface Secao { dominio: Dominio; guia: string; arquivo: string; titulo: string; texto: string; termos: string[] }

// ------------------------------------------------------------------ detecção

const AREA: Record<Dominio, RegExp> = {
  python: /\b(python|py|scripts?|codigos?|programa(r|cao|s)?|programando|funca?o(es)?|bibliotecas?|pip|venv|virtualenv|api ?rest|json|yaml|regex|automatiz\w*|netmiko|paramiko|pysnmp|easysnmp|icmplib|zabbix_utils|pyzabbix|requests|asyncio|pandas|crontab|cron|systemd|bash|shell|javascript|typescript|node\.?js|sql|sqlite|postgres|mysql|banco de dados|git|github|docker|desenvolv\w*|depurar|debug|refator\w*|algoritmo|webhook|bot do telegram)\b/,
  redes: /\b(bgp|ebgp|ibgp|ospf|is-?is|mpls|ldp|segment routing|vpls|vpws|l2vpn|l3vpn|vrf|cgnat|nat ?444|ipv6|ipv4|dhcpv6|slaac|prefixo|rpki|roa|ix\.?br|ptt|peering|transito|upstream|operadora de transito|asn?|sistema autonomo|route reflector|bng|bras|pppoe|ipoe|radius|qinq|lacp|vrrp|bfd|ecmp|ddos|flowspec|rtbh|bcp ?38|urpf|orcamento optico|power budget|atenuac\w*|perda optica|splitters?|gpon|xgs-?pon|epon|ftth|otdr|power ?meter|dimension\w*|oversubscription|percentil 95|capacidade|projeto de rede|arquitetura de rede|planejamento de rede|anel de fibra|redundancia|enderecamento|sub-?redes?|mascara|cidr|roteamento|anatel|scm|marco civil|guarda de logs?|netflow|sflow|ipfix|netbox|ipam)\b/,
  hardware: /\b(arduino|esp ?32|esp ?8266|nodemcu|wemos|raspberry|microcontrolador\w*|atmega\w*|sensor(es)?|dht ?(11|22)|ds18b20|bme280|sht31|ina2(19|26)|sct-?013|reed switch|reles?|relay|gpio|pwm|adc|i2c|spi|uart|serial|protoboard|resistor(es)?|transistor(es)?|mosfet|optoacoplador|multimetro|solda\w*|firmware|sketch|eletronica|circuitos?|divisor de tensao|tensao|corrente|platformio|mqtt|ota)\b/,
};

// Pedido de código/projeto: vai para o especialista mesmo que cite alarme, host ou cadastro
// ("crie um script que lista os alarmes" é programação, não consulta).
const PEDIDO_CODIGO = /\b(crie|cria|criar|gere|gera|gerar|escreva|escreve|escrever|faca|faz|fazer|monte|montar|desenvolva|desenvolver|programe|programar|implemente|implementar|preciso de|me (de|da|mande|passa))\b.{0,50}\b(script|codigo|programa|funcao|firmware|sketch|automacao|bot|api|classe|rotina|coletor|exporter|integracao|circuito|projeto)\b|\b(corrija|corrigir|revise|revisar|otimize|otimizar|refatore|refatorar|explique|explicar|comente|documente) (este|esse|o|meu|seu|o seguinte) (codigo|script|programa|sketch|firmware)\b/;
// Pergunta de entendimento/projeto (sem pedido de consulta aos sistemas).
const PERGUNTA_TECNICA = /^(como (funciona|fazer|faco|faço|calcular|calculo|dimensionar|projetar|planejar|montar|ligar|conectar|medir|configurar|implementar|programar|automatizar|integrar)|o que (e|sao|significa)|qual (a )?diferenca|quais (as )?(vantagens|diferencas|boas praticas)|explique|me explica|por que|porque|quando (usar|devo)|qual (o )?melhor|vale a pena|calcule|calcular)\b/;

export function dominioTecnico(textoNorm: string): Dominio | null {
  const hits = (Object.keys(AREA) as Dominio[]).map((d) => ({ d, n: (textoNorm.match(new RegExp(AREA[d].source, 'g')) ?? []).length }));
  const melhor = hits.sort((a, b) => b.n - a.n)[0];
  return melhor && melhor.n > 0 ? melhor.d : null;
}

export const pedidoDeCodigo = (textoNorm: string, original: string) => PEDIDO_CODIGO.test(textoNorm) || /```/.test(original);
export const perguntaTecnica = (textoNorm: string) => PERGUNTA_TECNICA.test(textoNorm);

// ------------------------------------------------------------------ guias

const STOP = new Set('a o os as um uma uns umas de do da dos das no na nos nas em para por com sem que como e ou se ao aos e ser mais muito sobre qual quais quando onde me meu minha isso esse essa este esta pra pro faz fazer crie gere escreva script codigo nia'.split(' '));
const termos = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));

let cache: { em: number; secoes: Secao[] } | null = null;

function pasta() { return path.join(nocConfig.knowledge.docsDir, 'especialidades'); }

/** Lê e divide os guias em seções (por "## "), com cache de 5 minutos. */
export function secoes(): Secao[] {
  if (cache && Date.now() - cache.em < 5 * 60_000) return cache.secoes;
  const out: Secao[] = [];
  let arquivos: string[] = [];
  try { arquivos = readdirSync(pasta()).filter((f) => f.endsWith('.md')).sort(); } catch { arquivos = []; }
  for (const arquivo of arquivos) {
    let bruto = '';
    try { if (!statSync(path.join(pasta(), arquivo)).isFile()) continue; bruto = readFileSync(path.join(pasta(), arquivo), 'utf8'); } catch { continue; }
    const fm = bruto.match(/^---\n([\s\S]*?)\n---\n/);
    const meta = Object.fromEntries((fm?.[1] ?? '').split('\n').map((l) => l.split(/:\s*/, 2)).filter((p) => p.length === 2)) as Record<string, string>;
    const dominio = (['python', 'redes', 'hardware'].includes(meta.dominio) ? meta.dominio : 'python') as Dominio;
    const corpo = fm ? bruto.slice(fm[0].length) : bruto;
    const guia = meta.titulo || corpo.match(/^#\s+(.+)$/m)?.[1] || arquivo;
    for (const bloco of corpo.split(/\n(?=## )/)) {
      const titulo = bloco.match(/^##\s+(.+)$/m)?.[1]?.trim() ?? 'Introdução';
      const texto = bloco.replace(/^#\s+.+$/m, '').trim();
      if (texto.length < 40 || /^exemplos de pedidos/i.test(titulo)) continue; // lista de exemplos não é conteúdo
      out.push({ dominio, guia, arquivo, titulo, texto, termos: termos(`${titulo} ${titulo} ${texto}`) });
    }
  }
  cache = { em: Date.now(), secoes: out };
  return out;
}

/** Seções mais relevantes para a pergunta (BM25 simples), preferindo a área detectada. */
export function buscarEspecialidades(pergunta: string, dominio: Dominio | null, limite = 3): Secao[] {
  const todas = secoes();
  const q = [...new Set(termos(pergunta))];
  if (!todas.length || !q.length) return [];
  const N = todas.length;
  const media = todas.reduce((n, s) => n + s.termos.length, 0) / N;
  const df = new Map<string, number>();
  for (const s of todas) for (const w of new Set(s.termos)) df.set(w, (df.get(w) ?? 0) + 1);
  const pontos = todas.filter((s) => s.titulo !== 'Introdução').map((s) => {
    const tf = new Map<string, number>();
    for (const w of s.termos) tf.set(w, (tf.get(w) ?? 0) + 1);
    const noTitulo = new Set(termos(s.titulo));
    let score = 0, cobertos = 0;
    for (const w of q) {
      const f = tf.get(w) ?? [...tf.keys()].filter((x) => w.length >= 4 && x.startsWith(w)).reduce((n, x) => n + (tf.get(x) ?? 0), 0);
      if (!f) continue;
      cobertos++;
      const idf = Math.log(1 + (N - (df.get(w) ?? 1) + 0.5) / ((df.get(w) ?? 1) + 0.5));
      // Seções longas não são punidas demais (b = 0,4): o assunto delas costuma ser o da pergunta.
      score += idf * ((f * 2.4) / (f + 1.4 * (0.6 + 0.4 * (s.termos.length / media)))) * (noTitulo.has(w) ? 1.8 : 1);
    }
    score *= (cobertos / q.length) ** 1.5; // cobre mais termos da pergunta → mais relevante
    if (dominio && s.dominio === dominio) score *= 1.6;
    return { s, score };
  }).filter((p) => p.score > 0).sort((a, b) => b.score - a.score);
  return pontos.slice(0, limite).map((p) => p.s);
}
