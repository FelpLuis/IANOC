/**
 * Pedidos de cadastro em linguagem natural → proposta com confirmação (noc/acoes.ts).
 *
 *   "cadastre no zabbix o host OLT VILA NOVA com IP 10.0.0.5 no grupo OLTs UpDown, template ICMP Ping"
 *   "cadastre o cliente código 12345, nome Maria Silva, telefone 13 99999-0000, plano 500M, login maria.silva"
 *   "cadastre o POP Guarujá, endereço Av. Puglisi 100, -23.99, -46.25"
 *   "cadastre o equipamento SW GUARUJA, modelo Huawei S5735, 24 portas de 1 Gbps, no POP Guarujá"
 *   "cadastre o enlace do 6750 porta 3 para o SW GUARUJA porta 24, 10 Gbps"
 *
 * Campo obrigatório faltando: a NIA pergunta antes de propor. Nada é gravado aqui.
 */

import type { Parsed } from './nlu.js';
import {
  PropostaInvalida, proporCliente, proporEnlace, proporEquipamento, proporHostZabbix, proporPop, type AcaoPublica,
} from '../acoes.js';

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
  noc_cliente: '"cadastre o cliente código 12345, nome Maria Silva, telefone 13 99999-0000, plano 500M, login maria.silva"',
  noc_pop: '"cadastre o POP Guarujá, endereço Av. Puglisi 100, -23.99, -46.25"',
  noc_equipamento: '"cadastre o equipamento SW GUARUJA, modelo Huawei S5735, 24 portas de 1 Gbps, no POP Guarujá"',
  noc_enlace: '"cadastre o enlace do 6750 porta 3 para o SW GUARUJA porta 24, 10 Gbps"',
};

const faltando = (tipo: string, campos: string[]) =>
  `Para cadastrar, preciso de: **${campos.join(', ')}**. Exemplo: ${EXEMPLOS[tipo]}.`;

/** Monta a proposta de cadastro; devolve o texto da resposta (e emite o cartão pelo callback). */
export async function cadastro(q: Parsed, conversa: string, emitir: (a: AcaoPublica) => void): Promise<string> {
  const t = q.original;
  const tipo = tipoCadastro(q.texto);
  if (!tipo) return `O que cadastrar, Chefe? Posso cadastrar: host no Zabbix, cliente, POP, equipamento ou enlace no sistema NOC. Exemplo: ${EXEMPLOS.zabbix_host}.`;
  const p = pares(t);
  try {
    let acao: AcaoPublica;
    if (tipo === 'zabbix_host') {
      const nome = aspas(t) ?? limpo(t.match(/\bhost\s+(?:chamado\s+|de nome\s+|com nome\s+)?(.+?)(?=\s+(?:com|no|na|ip|grupo|template|e)\b|,|$)/i)?.[1]) ?? p.nome;
      const ip = t.match(/\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})\b/)?.[1];
      const grupo = limpo(t.match(/\bgrupo\s+["“]?(.+?)["”]?(?=\s*(?:,|;|\be\b|\bcom\b|\btemplate\b|$))/i)?.[1]) ?? p.grupo;
      const template = limpo(t.match(/\btemplate\s+["“]?(.+?)["”]?(?=\s*(?:,|;|\be\b|\bcom\b|\bno\b|\bgrupo\b|$))/i)?.[1]) ?? p.template;
      const comunidade = limpo(t.match(/\bcomunidade\s+(\S+)/i)?.[1]);
      const instancia = limpo(t.match(/\bzabbix\s+(lv|updown)\b/i)?.[1] ?? t.match(/\binst[aâ]ncia\s+(\w+)/i)?.[1]);
      const falta = [!nome && 'nome do host', !ip && 'IP', !grupo && 'grupo'].filter(Boolean) as string[];
      if (falta.length) return faltando(tipo, falta);
      acao = await proporHostZabbix(conversa, {
        nome: nome!, ip: ip!, grupo: grupo!, template, comunidade, instancia,
        interface: /\bsnmp\b/i.test(t) || comunidade ? 'snmp' : /\b(icmp|ping)\b/i.test(t) && !template ? 'icmp' : 'agente',
      });
    } else if (tipo === 'noc_cliente') {
      const nome = p.nome ?? aspas(t) ?? limpo(t.match(/\bcliente\s+(?!c[oó]digo|id\b)([A-ZÀ-Ú][^,;]{2,60})/)?.[1]);
      const cpf = t.match(/\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/)?.[1];
      const login = p.login;
      const codigo = p.codigo ?? p.id ?? login ?? cpf?.replace(/\D/g, '');
      const falta = [!codigo && 'código (IXC) ou login', !nome && 'nome'].filter(Boolean) as string[];
      if (falta.length) return faltando(tipo, falta);
      acao = await proporCliente(conversa, {
        client_id: codigo!, nome: nome!, cpf_cnpj: cpf, telefone: p.telefone ?? p.celular, email: p.email ?? p['e-mail'],
        endereco: p.endereco, bairro: p.bairro, cidade: p.cidade, plano: p.plano, login_pppoe: login,
        ont_serial: p.serial, ont_modelo: p.modelo ?? p.onu, observacao: p.observacao,
      });
    } else if (tipo === 'noc_pop') {
      const nome = aspas(t) ?? limpo(t.match(/\b(?:pop|data ?center)\s+(?:chamado\s+)?([^,;]{2,60})/i)?.[1]) ?? p.nome;
      const coord = t.match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
      if (!nome) return faltando(tipo, ['nome do POP']);
      acao = await proporPop(conversa, {
        nome: /^pop\b/i.test(nome) || /data ?center/i.test(t) ? nome : `POP ${nome}`,
        tipo: /data ?center/i.test(t) ? 'Data Center' : /\bisp\b/i.test(t) ? 'ISP' : 'POP',
        endereco: p.endereco, lat: coord ? Number(coord[1]) : undefined, lon: coord ? Number(coord[2]) : undefined, observacao: p.observacao,
      });
    } else if (tipo === 'noc_equipamento') {
      const nome = aspas(t) ?? limpo(t.match(/\b(?:equipamento|aparelho|olt|switch|roteador|servidor|concentrador)\s+(?:chamado\s+)?([^,;]{2,60}?)(?=\s*(?:,|;|\bmodelo\b|\bcom\b|\bno\b|\bna\b|$))/i)?.[1]) ?? p.nome;
      const portas = Number(t.match(/(\d{1,3})\s+portas?/i)?.[1] ?? 0) || undefined;
      const capacidade = limpo(t.match(/(\d+(?:[.,]\d+)?\s?(?:G|M)bps|\d+\s?GE\b)/i)?.[1]);
      const local = limpo(t.match(/\b(?:no|na|em)\s+((?:pop|data ?center)\s+[^,;]{2,50})/i)?.[1]) ?? p.local ?? p.pop;
      const categoria = limpo(t.match(/\b(acesso|agrega[cç][aã]o|n[uú]cleo|distribui[cç][aã]o|transporte|borda)\b/i)?.[1]) ?? p.camada ?? p.categoria;
      if (!nome) return faltando(tipo, ['nome do equipamento']);
      acao = await proporEquipamento(conversa, { nome, modelo: p.modelo, categoria: categoria && categoria.charAt(0).toUpperCase() + categoria.slice(1), local, portas, capacidade, observacao: p.observacao });
    } else {
      const m = t.match(/\b(?:do|da|de|entre o?|entre a?)\s+(.+?)\s+porta\s+(\d{1,3})\s+(?:para o?|para a?|pro|pra|ao|à|a|até o?|e o?|e a?|com o?)\s+(.+?)\s+porta\s+(\d{1,3})/i);
      const capacidade = limpo(t.match(/(\d+(?:[.,]\d+)?\s?(?:G|M)bps)/i)?.[1]);
      if (!m) return faltando(tipo, ['equipamento e porta de origem', 'equipamento e porta de destino']);
      acao = await proporEnlace(conversa, { de: limpo(m[1])!, portaDe: Number(m[2]), para: limpo(m[3])!, portaPara: Number(m[4]), capacidade, tipo: p.tipo });
    }
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
