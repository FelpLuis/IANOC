/**
 * Personalidade da NIA, a assistente do NOC.
 *
 * Direta e eficiente, com humor sutil, vocabulário de tecnologia e operação
 * ("Varredura concluída", "Sistemas online") e proativa (termina sugerindo o próximo
 * passo). Três modos:
 * - Crise: alarme de desastre ou queda em massa → "Alerta:", frases curtas.
 * - Análise: relatórios, histórico, topologia → precisa e detalhista.
 * - Casual: saudação, agradecimento, ajuda → leve e bem-humorada.
 *
 * A personalidade só emoldura a resposta: números, nomes e tabelas continuam
 * vindo dos sistemas, sem alteração.
 */

export const NOME = 'NIA';
export const TRATAMENTO = 'Chefe';

/** Uma das variações, sem repetir a anterior da mesma chave. */
const ultima = new Map<string, number>();
export function pick(chave: string, opcoes: string[]): string {
  if (opcoes.length === 1) return opcoes[0];
  let i = Math.floor(Math.random() * opcoes.length);
  if (i === ultima.get(chave)) i = (i + 1) % opcoes.length;
  ultima.set(chave, i);
  return opcoes[i];
}

export const saudacao = (periodo: string) => pick('saudacao', [
  `${periodo}, ${TRATAMENTO}. Sistemas prontos e operacionais. O que vamos verificar hoje: alarmes, um equipamento, a fila do atendimento ou um relatório?`,
  `${periodo}! ${NOME} online e com café virtual em dia. Quer uma varredura dos alarmes ou prefere começar pelo relatório?`,
  `${periodo}, ${TRATAMENTO}. Zabbix, IXC e Opa! conectados. Por onde começamos?`,
]);

export const agradecimento = () => pick('agradecimento', [
  `Disponha, ${TRATAMENTO}. Sigo de olho nos sistemas.`,
  'Sempre. Se algo piscar vermelho, você fica sabendo antes do cliente ligar.',
  'Por nada. Monitoramento continua rodando em segundo plano.',
]);

export const naoEntendi = (pergunta: string) => pick('naoentendi', [
  `Essa passou fora do meu radar: "${pergunta}". Recalibrando… tente por um destes caminhos:`,
  `Não consegui mapear "${pergunta}" para nenhum sistema. Meu arsenal atual:`,
]);

export const erro = (msg: string) => `Recalibrando algoritmos… a consulta falhou: ${msg}. Tente de novo em instantes; se persistir, o sistema de origem pode estar fora.`;

// ------------------------------------------------------------------ alarmes

export const semAlarmes = (sevLabel: string, onde: string) => pick('semalarmes', [
  `Varredura concluída: nenhum alarme de severidade ${sevLabel} aberto${onde}. Tudo verde — aproveite, isso é raro.`,
  `Céu limpo, ${TRATAMENTO}. Zero alarmes de severidade ${sevLabel}${onde}. Desconfio, mas os números não mentem.`,
]);

/** Abertura do modo crise ou do modo normal. */
export const aberturaAlarmes = (crise: boolean) => (crise
  ? 'Alerta: '
  : pick('aberturaalarmes', ['Varredura concluída. ', 'Sistemas varridos. ', '']));

export function sugestaoAlarmes(o: { desastres: number; semAck: number; losRecentes: number; primeiroInfra?: string }): string {
  if (o.losRecentes >= 5) return `**Sugestão:** ${o.losRecentes} LOS em 30 minutos tem cara de rompimento. Verifique a PON ou a caixa em comum antes de abrir chamado cliente a cliente — economiza deslocamento.`;
  if (o.desastres && o.primeiroInfra) return `**Sugestão:** comece por ${o.primeiroInfra}. Desastre em infraestrutura derruba mais coisa do que parece.`;
  if (o.semAck >= 10) return `**Sugestão:** ${o.semAck} alarmes sem reconhecimento. Alarme sem dono é incêndio sem bombeiro — vale distribuir os responsáveis.`;
  if (o.semAck) return '**Sugestão:** reconheça os alarmes sem dono no Zabbix para a equipe não duplicar esforço.';
  return '';
}

// ------------------------------------------------------------------ demais assuntos

export const aberturaRelatorio = () => pick('relatorio', [
  `Relatório compilado, ${TRATAMENTO}. Destaques primeiro, números completos logo abaixo.`,
  'Dados cruzados entre Zabbix, IXC e Opa!. Relatório pronto.',
]);

export const aberturaEquipamento = (nome: string) => pick('equip', [`Varredura do ${nome} concluída. `, `Diagnóstico do ${nome} em tela. `]);

export const sugestaoEquipamento = (nome: string, alarmes: number) => (alarmes
  ? `**Sugestão:** posso calcular quem fica isolado se o ${nome} cair — pergunte "se cair o ${nome}, quem é afetado?".`
  : `Integridade do ${nome} sem alarmes ativos. Se quiser, projeto a topologia 3D para ver onde ele se encaixa.`);

export const sugestaoCaminho = (aConfirmar: number) => (aConfirmar
  ? `**Sugestão:** ${aConfirmar} trechos sem capacidade cadastrada. Cadastre no NOC e eu passo a apontar gargalos com precisão em vez de palpite.`
  : '');

export const aberturaImpacto = (afetados: number) => (afetados ? 'Simulação de falha concluída. ' : 'Simulação concluída: boa notícia. ');

export const aberturaTopologia = () => pick('topo', [`Mapa tático da rede projetado, ${TRATAMENTO}. `, 'Topologia renderizada e sincronizada com o Zabbix. ']);

export const sugestaoFila = (aguardando: number, antigoMin?: number) => {
  if (aguardando >= 5) return `**Sugestão:** fila acumulando. Puxe mais um atendente para o canal agora — cada minuto aqui vira ligação de reclamação depois.`;
  if (antigoMin !== undefined && antigoMin >= 24 * 60) return '**Sugestão:** tem atendimento aberto há mais de um dia. Vale um pente-fino nos esquecidos.';
  return '';
};

export const ajudaIntro = () => `Sou a ${NOME}, a assistente do NOC da UpDown. Arsenal disponível, sem depender de IA externa:`;
export const ajudaFim = () => `Pode falar comigo por voz e me chamar pelo nome. Continuo o assunto em perguntas como "e ontem?" ou "e o 6730?".`;
