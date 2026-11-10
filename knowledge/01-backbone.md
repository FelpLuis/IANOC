# Backbone UpDown — conhecimento operacional

> Este arquivo vai inteiro no contexto do assistente. Escreva o que **não** está
> cadastrado em sistema nenhum: por que as coisas são como são, o que fazer
> quando quebram, com quem falar. O inventário (equipamentos, portas, enlaces,
> caixas, cabos) já vem da topologia do NOC — não copie aqui.
> Trechos marcados com `A PREENCHER` são lacunas: o assistente dirá que não sabe.

## Núcleo e agregação (Ascenty SP4)

- **NE F1A** (Huawei NetEngine 8000 F1A) é o roteador de núcleo na Ascenty.
- Agregação/distribuição em Huawei CloudEngine **S6730-H24X6C** e **S6750-H36C**.
- O transporte entre os dois lados da agregação passa por dois caminhos paralelos,
  **Nokia** e **Datacom**. No Zabbix o Datacom aparece como **DWDM4920** (um na
  Ascenty, 172.16.21.150; outro em Praia Grande, 172.16.21.146). O Nokia é
  gerenciado pelas portas `GERENCIA-NOKIA-DCI` e `GERENCIA-NOKIA-MUX` do
  S6730 Praia Grande 2 (modelo exato não cadastrado).
- **NE8000-M8** é o concentrador BGP/MPLS, alcançado pelos POPs Santos e São Vicente.
- No Zabbix o F1A aparece em três hosts (visões/instâncias do mesmo núcleo):
  `NE8000 F1A BGP ASCENTY` (190.111.108.2), `NE8000 F1A VS BGP BASE`
  (190.111.108.0) e `NE8000 F1A PPPOE BASE` (190.111.108.1, onde terminam o
  PPPoE das OLTs, o CGNAT e as rotas MPLS para os POPs).
- MPLS/LDP do núcleo para os POPs: S6730 Rio Branco SV (Eth-Trunk30), S6730
  Santos (Eth-Trunk40), S6750 Praia Grande (100GE0/1/50) e rotas Cubatão x Rio
  Branco (100GE0/1/48) e Cubatão x Santos (100GE0/1/49).
- CGNAT: **A10 Thunder TH1040** (172.16.21.106, LACP Eth-Trunk10, VLANs 4021
  inbound / 4022 outbound) e **MikroTik CCR1072** (Eth-Trunk9, VLAN 2221
  inside / 2222 outside).
- Anti-DDoS: servidor **Wanguard** (VLAN 1516).

## Trânsito IP e peering

> Levantado das descrições de interface (`ifAlias`) no Zabbix em 17/08/2026.
> O que está como "down" estava inativo nessa data; confirme no Zabbix.

- **ASN próprio e prefixos anunciados:** `A PREENCHER` (não consta em nenhum sistema local)
- **Trânsito IP contratado (upstream):**
  - **Cirion**: rota Praia Grande (Eth-Trunk30.2600, F1A BGP Ascenty) e rota Rio
    Branco/SV (VLAN 2700, inativa em 17/08)
  - **Seaborn**: rota Ascenty (VLAN 2055) e rota 02 (VLAN 2054, via MPLS)
  - **Mega**: 100G (Eth-Trunk30.177)
  - **Cogent**: VLAN 620 (`PRN|COGENT` / `TRANSITO-CONGENT`, inativa na visão VS BGP em 17/08)
  - **Telium**: 10G em GigabitEthernet0/1/0 (inativo em 17/08)
- **IX.br São Paulo** (switch IX.br 100G na Ascenty, Eth-Trunk30):
  `IXBR-ASCENTY-SP2` VLAN 2894 (v4) / 2895 (v6); `IXBR-SPO-ASCENTY` VLAN 3397 /
  3398; também `MPLS-IX.BR-ITF-SPO` VLAN 3856 / 3857 no S6730 Rio Branco.
- **PNIs (conexão direta):** **Google** (VLAN 888) e **Globo** (VLAN 999).
- **Clientes de trânsito/dedicado com BGP (downstream):** Manalink (AS271694),
  Netfree (AS269286), Nex Telecom (AS268051), Microchipnet (AS265354 / AS270798),
  Conexão Net (AS270976), WSNet (AS263608), Unnifibra (AS269444 / AS272193),
  Kobertura (AS268818), IFacilities, Ghost Telecom, Silvanet, Turbonet, Celerix
  (transporte), além de dedicados sem BGP (Ceslog, EGTC, Sisnergy, Unimetal,
  Vibra, Unipar, Via Trucks, Oziris).
- **Contatos de NOC das operadoras** (telefone/e-mail/portal de chamado) e
  designadores de circuito: `A PREENCHER`

## POPs

- POPs: Ascenty, Praia Grande, Santos, São Vicente, Cubatão (rotas aéreas e
  subterrâneas entre eles estão no cadastro de POPs).
- Monitoramento de energia: há VLAN de monitoramento de energia em Praia Grande
  (VLAN 90), monitoramento dos POPs na VLAN 3000, POP Santos (VLAN 3001) e POP
  Cubatão (VLAN 3333). O POP da PON 1/13/8 da C300 (VLAN 2608) está marcado
  "SEM ENERGIA NO POP" na descrição da porta.
- Energia/nobreak/gerador de cada POP e autonomia: `A PREENCHER`
- Acesso físico (quem tem chave, horário, contato do condomínio/datacenter): `A PREENCHER`

## Plano de endereçamento e VLANs

- VLAN de gerência TR-069 das ONTs: vem do template de CPE do IXC, na linha
  `tr069-mgmt 1 tag pri 5 vlan #vlan#` (variável do IXC). O número fixo, se
  houver, `A PREENCHER`.
- **VLANs de serviço PPPoE: uma VLAN por PON**, escrita na descrição da porta
  GPON da OLT (ex.: `CARAGUATA VLAN 2601 F12 <lat>,<lon>`). Faixas por OLT em
  `02-ftth-gpon.md`. O PPPoE termina no NE8000 F1A PPPOE BASE:
  C350 Central → Eth-Trunk2 (LACP, 30G), C300 Casqueiro → Eth-Trunk3 (LACP) e
  via MPLS (VLAN 4040).
- **Gerência dos equipamentos:**
  - 172.16.21.0/24: switches Huawei (S6730 Ascenty .71, S6750 Ascenty .64,
    S6730 Rio Branco SV .66, S6730 Santos .65, S6750 Praia Grande .67, S6730
    Praia Grande 2 .70), DWDM Datacom (.146 / .150), A10 CGNAT (.106)
  - 172.16.255.0/24: OLTs ZTE (C350 .1; C300 .3 no Zabbix), atrás da
    `VLAN2-GERENCIA_OLTS-ZTE` do CCR1072 de gerência
  - 190.111.108.0-3: NE8000 F1A e CCR1072 de gerência; 190.111.111.25: CRS125 CPD
  - A C300 também responde em 172.16.21.14 (Telnet 23), que é o endereço usado
    pelo coletor do NOC; a C350 é acessada por SSH (22) em 172.16.255.1.

## Monitoramento

- Zabbix monitora os equipamentos do backbone; as portas da topologia estão
  vinculadas às interfaces reais (ifIndex/ifAlias) e o `ifAlias` é o que define
  os enlaces. Descrição de porta errada no equipamento = enlace errado no NOC.
