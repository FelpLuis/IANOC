/**
 * NIA TV: tela de parede do NOC que mostra só as perguntas feitas por voz e as respostas.
 *
 * Cada navegador aberto em /tv se inscreve pelo WebSocket (tv_subscribe). Quando alguém
 * pergunta por voz em qualquer sessão da NIA, as TVs recebem: a pergunta (tv_pensando),
 * as etapas de consulta (tv_etapa) e o resultado com o painel visual, se houver
 * (tv_resultado). As últimas respostas ficam em memória para a TV que acabou de ligar.
 */

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

export interface TvResultado {
  id: string;
  pergunta: string;
  resposta: string;
  usuario: string;
  quando: number;
  ms: number;
  modelo?: string;
  sistemas: string[];
  dashboard?: unknown;
  /** Topologia 3D (backbone_topologia) e equipamentos consultados (cartões 3D). */
  topologia?: unknown;
  aparelhos?: unknown[];
  erro?: boolean;
}

const MAX_HISTORICO = Number(process.env.IANOC_TV_HISTORICO || 30);
const telas = new Set<WebSocket>();
const historico: TvResultado[] = [];

function enviar(ws: WebSocket, type: string, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}

function transmitir(type: string, payload: unknown) {
  for (const ws of telas) enviar(ws, type, payload);
}

/** Registra uma TV e manda o histórico recente (mais novo primeiro). */
export function inscreverTv(ws: WebSocket) {
  telas.add(ws);
  const sair = () => telas.delete(ws);
  ws.once('close', sair);
  ws.once('error', sair);
  enviar(ws, 'tv_historico', { resultados: historico, telas: telas.size });
}

export const telasConectadas = () => telas.size;

/** Acompanha uma pergunta por voz do começo ao fim e repassa às TVs. */
export function rodadaDeVoz(pergunta: string, usuario: string) {
  const id = randomUUID().slice(0, 8);
  const inicio = Date.now();
  let dashboard: unknown;
  let topologia: unknown;
  const aparelhos = new Map<string, unknown>();
  const sistemas: string[] = [];
  transmitir('tv_pensando', { id, pergunta, usuario, quando: inicio });
  return {
    /** Eventos da resposta (ferramentas, dashboard) enquanto a NIA trabalha. */
    evento(e: { type: string; name?: string; dashboard?: unknown; topology?: unknown; devices?: Array<{ id: string }> }) {
      if (e.type === 'tool_start' && e.name) { sistemas.push(e.name); transmitir('tv_etapa', { id, nome: e.name }); }
      if (e.type === 'dashboard') dashboard = e.dashboard;
      if (e.type === 'tool_end' && e.topology) topologia = e.topology;
      if (e.type === 'tool_end') for (const d of e.devices ?? []) aparelhos.set(d.id, d);
    },
    fim(resposta: string, opts: { modelo?: string; erro?: boolean } = {}) {
      const r: TvResultado = { id, pergunta, resposta, usuario, quando: inicio, ms: Date.now() - inicio, sistemas: [...new Set(sistemas)], ...(dashboard ? { dashboard } : {}), ...(topologia ? { topologia } : {}), ...(aparelhos.size ? { aparelhos: [...aparelhos.values()].slice(0, 12) } : {}), ...opts };
      historico.unshift(r);
      historico.splice(MAX_HISTORICO);
      transmitir('tv_resultado', r);
    },
  };
}
