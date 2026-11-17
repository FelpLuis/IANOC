/**
 * Pedidos de cadastro em linguagem natural → proposta com confirmação (noc/acoes.ts).
 *
 *   "cadastre no zabbix o host OLT VILA NOVA com IP 10.0.0.5 no grupo OLTs UpDown, template ICMP Ping"
 *
 * Cliente, POP, equipamento e enlace eram gravados no sistema NOC (sistema.updown.com.br),
 * que saiu do ar: a NIA explica onde cadastrar agora (IXC / documentação do NOC).
 *
 * Campo obrigatório faltando: a NIA pergunta antes de propor. Nada é gravado aqui.
 */

import type { Parsed } from './nlu.js';
import { nocConfig } from '../config.js';
import { PropostaInvalida, proporHostZabbix, type AcaoPublica } from '../acoes.js';

const limpo = (s?: string) => s?.replace(/^["“'”]+|["“'”.]+$/g, '').replace(/\s+/g, ' ').trim() || undefined;
const aspas = (t: string) => limpo(t.match(/["“]([^"”]{2,80})["”]/)?.[1]);

/** "campo: valor" ou "campo valor", separados por vírgula/ponto e vírgula. */
function pares(t: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\b(nome|c[oó]digo|id|cpf|cnpj|documento|telefone|celular|e-?mail|endere[cç]o|bairro|cidade|plano|login(?: pppoe)?|serial|modelo|onu|camada|categoria|local|pop|tipo|capacidade|observa[cç][aã]o|grupo|template|comunidade|ip)\b\s*[:=]?\s*([^,;\n]+)/gi;
  for (const m of t.matchAll(re)) {
    const k = m[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s.*$/, '');
    if (!out[k]) out[k] = limpo(m[2]) ?? '';
  }
  return out;
}

export function tipoCadastro(texto: string): 'zabbix_host' | 'noc_cliente' | 'noc_pop' | 'noc_equipamento' | 'noc_enlace' | null {
  if (/\bzabbix\b|\bhost\b/.test(texto)) return 'zabbix_host';
  if (/\b(enlace|link|ligacao|conexao|ligue|ligar|conecte|conectar)\b/.test(texto)) return 'noc_enlace';
  if (/\b(cliente|assinante)\b/.test(texto)) return 'noc_cliente';
  if (/\b(pop|data ?center|ponto de presenca)\b/.test(texto) && !/\b(equipamento|switch|olt|roteador)\b/.test(texto)) return 'noc_pop';
  if (/\b(equipamento|aparelho|olt|switch|roteador|servidor|dwdm|transporte|concentrador)\b/.test(texto)) return 'noc_equipamento';
  return null;
}

const EXEMPLOS: Record<string, string> = {
  zabbix_host: '"cadastre no zabbix o host OLT VILA NOVA com IP 10.0.0.5 no grupo OLTs UpDown, template ICMP Ping"',
};

const doc = () => nocConfig.doc.baseUrl || 'https://documentacao.noc.updown.com.br';

const faltando = (tipo: string, campos: string[]) =>
  `Para cadastrar, preciso de: **${campos.join(', ')}**. Exemplo: ${EXEMPLOS[tipo]}.`;

/** Monta a proposta de cadastro; devolve o texto da resposta (e emite o cartão pelo callback). */
export async function cadastro(q: Parsed, conversa: string, emitir: (a: AcaoPublica) => void): Promise<string> {
  const t = q.original;
  const tipo = tipoCadastro(q.texto);
  if (!tipo) return `O que cadastrar, Chefe? Posso cadastrar host no Zabbix. Exemplo: ${EXEMPLOS.zabbix_host}.`;
  if (tipo === 'noc_cliente') return 'O cadastro de cliente era no sistema NOC, que saiu do ar, Chefe. Cliente agora se cadastra direto no **IXC**.';
  if (tipo !== 'zabbix_host') {
    const oque = tipo === 'noc_pop' ? 'POP/site' : tipo === 'noc_equipamento' ? 'equipamento' : 'enlace';
    return `O cadastro de ${oque} era no sistema NOC, que saiu do ar, Chefe. Agora isso se documenta na **[Documentação do NOC](${doc()})** — ${tipo === 'noc_enlace' ? 'escreva o destino na descrição da porta dos dois lados e eu passo a enxergar o enlace' : 'cadastre lá e eu passo a enxergar'} na próxima atualização.`;
  }
  const p = pares(t);
  try {
    const nome = aspas(t) ?? limpo(t.match(/\bhost\s+(?:chamado\s+|de nome\s+|com nome\s+)?(.+?)(?=\s+(?:com|no|na|ip|grupo|template|e)\b|,|$)/i)?.[1]) ?? p.nome;
    const ip = t.match(/\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})\b/)?.[1];
    const grupo = limpo(t.match(/\bgrupo\s+["“]?(.+?)["”]?(?=\s*(?:,|;|\be\b|\bcom\b|\btemplate\b|$))/i)?.[1]) ?? p.grupo;
    const template = limpo(t.match(/\btemplate\s+["“]?(.+?)["”]?(?=\s*(?:,|;|\be\b|\bcom\b|\bno\b|\bgrupo\b|$))/i)?.[1]) ?? p.template;
    const comunidade = limpo(t.match(/\bcomunidade\s+(\S+)/i)?.[1]);
    const instancia = limpo(t.match(/\bzabbix\s+(lv|updown)\b/i)?.[1] ?? t.match(/\binst[aâ]ncia\s+(\w+)/i)?.[1]);
    const falta = [!nome && 'nome do host', !ip && 'IP', !grupo && 'grupo'].filter(Boolean) as string[];
    if (falta.length) return faltando(tipo, falta);
    const acao = await proporHostZabbix(conversa, {
      nome: nome!, ip: ip!, grupo: grupo!, template, comunidade, instancia,
      interface: /\bsnmp\b/i.test(t) || comunidade ? 'snmp' : /\b(icmp|ping)\b/i.test(t) && !template ? 'icmp' : 'agente',
    });
    emitir(acao);
    return [
      `Preparei o cadastro, Chefe: **${acao.titulo}**. Confira os dados no cartão abaixo e clique em **Confirmar** para gravar.`,
      acao.avisos.length ? acao.avisos.map((a) => `> ${a}`).join('\n') : '',
      '_Só administradores podem confirmar. A proposta vale por 15 minutos e fica registrada na auditoria._',
    ].filter(Boolean).join('\n\n');
  } catch (e) {
    if (e instanceof PropostaInvalida) return `Não preparei o cadastro: ${e.message}`;
    return `Recalibrando… não consegui preparar o cadastro: ${e instanceof Error ? e.message : String(e)}`;
  }
}
