---
dominio: redes
titulo: Projeto de redes para provedores de internet (ISP)
---

# Projeto de redes para provedores de internet (ISP)

Referência da NIA para planejar, dimensionar e revisar a rede de um provedor regional (FTTH/GPON,
backbone IP/MPLS, BGP com operadoras e IX). Valores são referências de mercado: confirme sempre no
datasheet do equipamento e na norma vigente.

## Arquitetura em camadas

- **Borda (edge/BGP):** roteadores que falam eBGP com as operadoras de trânsito e com o IX.br
  (PTT). Ficam em data center com energia e refrigeração redundantes. Dois roteadores de borda,
  cada um com pelo menos uma operadora, evitam ponto único de falha.
- **Núcleo (core):** roteamento interno (IGP) e MPLS entre os POPs. Enlaces de alta capacidade
  (10/100 Gbps) em **anel** ou malha parcial: uma fibra rompida não isola nenhum POP.
- **Agregação/distribuição:** switches ou roteadores nos POPs que concentram OLTs, rádios e
  clientes corporativos. Uplinks em LACP (dois ou mais links) para capacidade e redundância.
- **BNG/BRAS (concentrador):** termina PPPoE ou IPoE dos assinantes, aplica planos (QoS), CGNAT e
  conversa com o RADIUS (no Brasil, normalmente o do ERP — IXC, SGP, MK etc.).
- **Acesso:** OLTs GPON/XGS-PON e as redes ópticas passivas até as ONUs dos clientes.
- **Serviços:** DNS recursivo, RADIUS, servidores de log (CGNAT), monitoramento (Zabbix, Grafana),
  NTP, TFTP/ACS (TR-069) para provisionar ONUs.

## Roteamento interno (IGP) e MPLS

- **OSPF** ou **IS-IS** no núcleo, só com loopbacks e enlaces de infraestrutura — nunca as rotas
  dos clientes (essas vão no BGP interno ou ficam no BNG).
- IS-IS escala melhor e é independente de IP (bom para dual-stack); OSPF é mais conhecido pela
  maioria das equipes. Os dois funcionam bem em provedor regional.
- Use autenticação no IGP, `passive-interface` em tudo que não for enlace de backbone e ajuste
  BFD nos enlaces para convergência em menos de 1 segundo.
- **MPLS (LDP ou Segment Routing)** permite L2VPN (VPWS/VPLS) para clientes corporativos e
  transporte de VLANs de OLT entre POPs sem esticar L2 pela rede inteira.
- **iBGP:** em vez de malha completa entre todos os roteadores, use **route reflectors** (dois,
  para redundância).

## BGP com operadoras e IX.br

- **ASN e IPs:** o provedor obtém ASN, bloco IPv4 e bloco IPv6 com o **NIC.br/Registro.br**
  (que atua como NIR da LACNIC no Brasil). Normalmente um /32 de IPv6 e um bloco IPv4 limitado.
- **Trânsito:** pelo menos duas operadoras, de preferência em POPs ou rotas físicas diferentes.
- **IX.br (PTT):** troca de tráfego direto com conteúdo (CDNs, nuvens, streaming) e outros provedores,
  reduzindo custo de trânsito e latência. Muitos provedores passam boa parte do tráfego pelo IX.
- **CDNs/caches locais** (programas de cache de grandes plataformas de vídeo e conteúdo) tiram muito
  tráfego do trânsito; exigem espaço, energia e uma VLAN/peering BGP dedicados.
- **Boas práticas (MANRS):**
  - filtros de entrada e saída por prefixo: anuncie só os seus blocos (e dos clientes com AS próprio);
  - **RPKI**: crie ROAs dos seus prefixos no Registro.br e valide as rotas recebidas (descarte as inválidas);
  - `maximum-prefix` em cada sessão, para não derrubar o roteador se a operadora vazar a tabela;
  - **BCP 38/84 (anti-spoofing)**: uRPF ou ACL na borda dos clientes, para ninguém sair com IP falso;
  - mantenha o objeto do AS e os contatos atualizados (IRR/Registro.br, PeeringDB).
- **Engenharia de tráfego:** `local-preference` para escolher por onde sai; AS-path prepend,
  communities da operadora ou anúncios mais específicos para influenciar por onde entra.
- **Tabela completa vs. rota padrão:** tabela completa (mais de 1 milhão de rotas IPv4, mais de 200 mil
  IPv6) exige roteador com FIB suficiente; com pouca memória, receba só rota padrão + rotas do IX.
- **DDoS:** RTBH (blackhole por community da operadora) para o IP atacado, FlowSpec quando a
  operadora suporta, e serviço de mitigação contratado para ataques grandes.

## Endereçamento: IPv4, CGNAT e IPv6

- **CGNAT** é obrigatório na prática pela falta de IPv4:
  - faixa entre o cliente e o CGNAT: **100.64.0.0/10** (RFC 6598), não use IP privado de cliente;
  - **alocação por bloco de portas** (ex.: 1.000 a 4.000 portas por assinante, de 16 a 64 clientes
    por IPv4 público), o que simplifica o log;
  - **guarda de logs:** o Marco Civil da Internet exige que o provedor de conexão guarde os registros de
    conexão por **1 ano**. Com CGNAT isso inclui o IP público, a faixa de portas, data e hora com fuso
    (sincronize por NTP) — sem isso não dá para identificar o assinante numa ordem judicial;
  - deixe IPv4 público dedicado como opcional (clientes corporativos, câmeras, servidores).
- **IPv6 em todos os clientes** reduz a carga do CGNAT (o tráfego das grandes plataformas já vai em IPv6):
  - prefixo delegado por assinante via **DHCPv6-PD**: **/56** é o mais comum (256 redes /64), /48 para corporativo;
  - um /64 por rede local, nunca menor (SLAAC depende disso);
  - planeje o /32 em blocos por região/POP e por tipo de serviço, para agregar rotas no núcleo;
  - firewall de borda IPv6 no roteador do cliente (bloqueia conexões de entrada por padrão).

## Acesso FTTH/GPON: padrões e capacidade

- **GPON (ITU-T G.984):** 2,488 Gbps de descida e 1,244 Gbps de subida por PON, compartilhados.
- **XGS-PON (G.9807.1):** 10 Gbps simétricos; coexiste na mesma fibra com GPON (comprimentos de onda
  diferentes), útil para migrar sem trocar a rede óptica.
- Divisão típica: até 1:64 (às vezes 1:128) clientes por PON. Na prática, considere a capacidade:
  com planos de 500 Mbps a 1 Gbps, uma PON GPON lotada vira gargalo no horário de pico.
- **Uma VLAN por PON** (ou por OLT) e, se possível, QinQ (S-VLAN por OLT, C-VLAN por PON/serviço)
  facilita a operação e o diagnóstico.
- **Provisionamento:** perfis de serviço padronizados (internet, IPTV, voz) e autorização por serial
  ou por senha; ONU gerenciada por TR-069 (ACS, como o GenieACS) permite trocar Wi-Fi e firmware remotamente.

## Orçamento óptico (power budget)

Perda total do enlace = fibra + splitters + conectores + emendas + margem. Ela precisa ser **menor
que o orçamento da classe do transceptor** da OLT/ONU.

- **Classes GPON:** B+ ≈ 28 dB, C+ ≈ 32 dB (as mais usadas hoje).
- **Perdas de referência:**
  - fibra monomodo: ~0,35 dB/km em 1310 nm (subida) e ~0,25 dB/km em 1490/1550 nm (descida);
  - splitter balanceado (perda típica, já com excesso): 1:2 ≈ 3,7 dB · 1:4 ≈ 7,3 dB · 1:8 ≈ 10,5 dB ·
    1:16 ≈ 13,7 dB · 1:32 ≈ 17,1 dB · 1:64 ≈ 20,5 dB;
  - conector: ~0,3 a 0,5 dB cada (APC/UPC limpo); emenda por fusão: ~0,05 a 0,1 dB cada;
  - margem para envelhecimento, manutenção e novas emendas: 3 dB.
- **Exemplo:** 12 km de fibra (12 × 0,35 = 4,2 dB) + splitter 1:8 (10,5) + 1:8 em cascata (10,5) +
  6 conectores (6 × 0,5 = 3,0) + 8 emendas (8 × 0,1 = 0,8) + margem (3,0) = **32,0 dB** → no limite da
  classe C+; com B+ não fecha. Saídas: encurtar a rota, trocar por 1:4 + 1:16, ou usar módulo C++.
- **Potência na ONU (RX):** a faixa operacional costuma ir de cerca de −8 a −27 dBm (confira o
  datasheet). Acima de −8 pode saturar; abaixo de −27 a −28 dBm começam erros e quedas.
  Na operação, trate abaixo de −25 dBm como alerta preventivo.
- Meça com **power meter** (comprimento de onda certo) e **OTDR** para localizar emendas ruins e rompimentos.
  Sempre limpe e inspecione conectores antes de medir: sujeira é a causa mais comum de perda alta.

## Dimensionamento de capacidade

- **Pico por assinante** (horário nobre, ~20h–23h): use a média medida da sua base. Em provedores
  com muito streaming, algo entre 2 e 5 Mbps por assinante ativo é comum — meça a sua.
- Capacidade de um uplink = assinantes × pico por assinante × fator de crescimento. Ex.: 3.000
  clientes × 3 Mbps = 9 Gbps → um 10G já está no limite; planeje 2×10G em LACP ou 100G.
- **Regra de upgrade:** quando o percentil 95 do mês passa de ~70% da capacidade do enlace, planeje
  o aumento (o pico real de 1 minuto é bem maior que a média de 5 minutos).
- Separe a capacidade de trânsito, IX e CDN: o gráfico de cada um mostra onde investir.
- Monitore por SNMP (contadores de 64 bits) e, para saber **quem** e **o quê**, NetFlow/IPFIX ou sFlow.

## Redundância e disponibilidade

- Anéis de fibra no backbone com rotas físicas diferentes (cabos que não dividem o mesmo poste/duto).
- Dois uplinks por POP (LACP ou ECMP), duas fontes nos equipamentos, nobreak + banco de baterias e
  gerador nos POPs grandes.
- Gateway redundante para servidores/serviços: VRRP.
- Equipamentos de reserva (OLT, placa GPON, módulos ópticos) no estoque dos POPs críticos.
- Monitore energia, temperatura e porta do POP (veja o guia de hardware/Arduino para sensores).

## Segurança e boas práticas operacionais

- Rede de gerência separada (VRF ou VLAN própria) e acesso aos equipamentos só por ela, com SSH,
  TACACS+/RADIUS e contas nominais (nada de usuário genérico compartilhado).
- Desligue Telnet, HTTP sem TLS e SNMP v1/v2c com community padrão; prefira SNMPv3.
- Backup automático das configurações (Oxidized/RANCID) e versionamento.
- Controle de mudanças: janela de manutenção, plano de volta (rollback) e aviso ao NOC/atendimento.
- Documente: topologia, endereçamento (IPAM, como o NetBox), rotas de fibra, caixas (CTO/CEO) e contatos.
- **Regulatório (Brasil):** serviço de internet é SCM (Serviço de Comunicação Multimídia) regulado
  pela Anatel; confirme as regras atuais de outorga/dispensa e obrigações para prestadoras de pequeno
  porte. Além da guarda de logs do Marco Civil, há a LGPD para os dados dos assinantes.

## Exemplos de pedidos que a NIA pode atender

- "Calcule o orçamento óptico de 15 km com splitter 1:8 e 1:16 em cascata."
- "Como planejar o IPv6 do provedor com um /32? Quanto entregar por cliente?"
- "Quantos clientes cabem numa PON GPON com planos de 600 Mega?"
- "Explique como configurar RPKI e filtros BGP com as operadoras."
- "Desenhe a arquitetura de rede para um provedor com 3 POPs e 8 mil assinantes."
