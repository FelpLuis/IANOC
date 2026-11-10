/**
 * Autoteste do assistente NOC sem gastar LLM: conectores, conhecimento e ferramentas.
 *   npm run noc:selftest
 */
import 'dotenv/config';
import { availableTools, connectorStatus, runTool } from '../noc/tools.js';
import { getKnowledge, knowledgeSummary } from '../noc/knowledge.js';

const k = await getKnowledge();
console.log('Conectores:', connectorStatus());
console.log('Ferramentas:', availableTools().map((t) => t.name).join(', '));
console.log(`Conhecimento: ${k.fonte} — ${k.equipamentos.length} equipamentos, ${k.conexoes.length} enlaces, ${k.caixas.length} caixas, ${k.fibras.length} cabos, ${k.documentos.length} documentos`);
console.log(`Resumo no prompt: ${knowledgeSummary(k).length} caracteres\n`);

const checks: Array<[string, unknown]> = [
  ['backbone_equipamento', { termo: 'm8' }],
  ['backbone_caminho', { de: 'f1a', para: 'm8' }],
  ['ftth_buscar', { termo: 'seaborn' }],
  ['ftth_proximos', { lat: -24.034339, lon: -46.49292, raio_m: 800, limite: 3 }],
];
if (connectorStatus().noc) checks.push(['noc_visao_geral', {}]);
const ontem = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
if (connectorStatus().zabbix) {
  checks.push(['zabbix_problemas', { severidade_minima: 4, limite: 5 }]);
  checks.push(['zabbix_relatorio_eventos', { desde: ontem, severidade_minima: 3, top: 3 }]);
}
if (connectorStatus().genieacs) checks.push(['acs_falhas', { limite: 3 }]);
if (connectorStatus().ixc) {
  checks.push(['ixc_consultar', { recurso: 'radpop', campo: 'id', valor: '0', operador: '>', limite: 3 }]);
  checks.push(['ixc_relatorio_os', { desde: ontem, top: 3 }]);
}
if (connectorStatus().opa) checks.push(['opa_relatorio_atendimentos', { desde: ontem.slice(0, 10), top: 3 }]);

let failed = 0;
for (const [name, input] of checks) {
  const { text, isError } = await runTool(name, input);
  if (isError) failed++;
  console.log(`${isError ? '✗' : '✓'} ${name} ${JSON.stringify(input)}\n  ${text.slice(0, 400).replace(/\n/g, ' ')}\n`);
}
process.exit(failed ? 1 : 0);
