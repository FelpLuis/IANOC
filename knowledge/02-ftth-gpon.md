# Rede FTTH / GPON — conhecimento operacional

> Vai inteiro no contexto do assistente. Preencha as lacunas `A PREENCHER`.

## OLTs

- Duas OLTs **ZTE**: **C350** e **C300**. O coletor do NOC lê o estado das ONUs
  pela CLI a cada ~10 s e cruza com o RADIUS do IXC.
> Placas, PONs e VLANs levantados do inventário do Zabbix em 17/08/2026.

### ZTE C350 — "Vila Natal" / "Central"

- Gerência: 172.16.255.1, SSH porta 22. Uplink: LACP (smartgroup1) em
  xgei_1/1/1 e xgei_1/1/2 para o S6730 (XGE0/0/11-12) e xgei_1/0/1 (`DIR-SW`);
  no NE8000 PPPOE BASE chega por Eth-Trunk2 (fibras 01, 02 e 03, 30G).
- Placas GPON (16 PONs cada, salvo indicação), VLAN = uma por PON. Regiões com os nomes exatos das descrições de porta:

| Placa | PONs | VLANs | Regiões (descrição das portas) |
|---|---|---|---|
| 1/2 | 16 | 2351–2366 | VNATAL R1–R8, VILA NOEL, COSTA MUNIZ, CAMINHO 2, CJ PADRE MANOEL DA NOBREGA, CORTUME VIA, VALE VERDE A/B |
| 1/3 | 16 | 2371–2386 | VSJOSE, AGUA FRIA, FABRIL, VALE VERDE C, VNOVA, COSTA SILVA, PILOES, VE AV PRINCIPAL, SITIO NOVO |
| 1/4 | 16 | 2391–2406 | VALE NOVO, SITIO NOVO, ILHA BELA, PILOES, FABRIL, VESP, VNOVA |
| 1/5 | 16 | 2431–2446 | VESP, M.INDIO, COTA 200, VNOVA |
| 1/8 | 16 | 2447–2462 | 31 DE MARCO, CAMINHO 2, POSTO ALDO ZI, VSANTA ROSA, VPAULISTA, COSTA.SILVA, S.FRANCISCO, V.ELIZABETH, FERN JORGE |
| 1/9 | 16 | 2463–2478 | FERN JORGE, VPAULISTA, VSANTA ROSA, VNATAL CDHU, CAIQUE, AGUA FRIA, ANA COSTA CDHU, FABRIL, POSTO ALDO ZI, VNOVA |
| 1/10 | 11 | 2479–2489 | COTA 200, VALE VERDE, CAIQUE, M.INDIO, V.PAULISTA |

### ZTE C300 — "Casqueiro"

- Gerência: 172.16.255.3 no Zabbix; o coletor do NOC acessa por Telnet (23)
  em 172.16.21.14. Uplink: xgei_1/20/1 e 1/20/2 (ativos) para o NE8000
  (`OLT-ZTE-CUBATAO_x_CASQUEIRO`), Eth-Trunk3 no PPPOE BASE.

| Placa | PONs | VLANs | Regiões (nomes exatos das descrições de porta) |
|---|---|---|---|
| 1/12 | 8 | — | nenhuma PON ativa em 17/08 |
| 1/13 | 16 | 2601–2616 | CARAGUATA, CASQUEIRO, PONTE NOVA (1/13/8 = VLAN 2608 "ROTEADOR (SEM ENERGIA NO POP)") |
| 1/14 | 16 | 2706–2725 | BOLSAO 7, BOLSAO 8, BOLSAO 9, MARACA B9 |
| 1/15 | 16 | 2701–2716 | BOLSAO 8, CASQUEIRO, RUBENS LARA, PQ SAO LUIZ |
| 1/16 | 16 | 2717–2732 | VPESCADORES, RUBENS LARA, ALEMOA, CASQUEIRO |
| 1/17 | 16 | 2733–2736 | CASQUEIRO (só 5 PONs ativas em 17/08) |

- **Padrão de descrição da porta PON:** `<REGIÃO> VLAN <nº> F<fibra> <lat>,<lon>`
  (ex.: `CARAGUATA VLAN 2601 F12 -23.9358,-46.4332`). A coordenada é do ponto
  atendido pela PON; use com `ftth_proximos` para achar caixas.
- Padrão de nomenclatura da **ONU** (descrição na OLT): `A PREENCHER`

## Rede óptica

- Mapa de fibra importado do KMZ "BACKBONE UPDOWN 16 07 2025": cabos, CEOs,
  reservas técnicas, travessias e pontos subterrâneos.
- Padrão de divisão (splitter 1:8 / 1:16, níveis de splitagem): `A PREENCHER`
- Orçamento óptico esperado por PON (potência de saída da OLT, perda por splitter): `A PREENCHER`

## Diagnóstico de cliente sem acesso

1. Achar o cliente (NOC → Clientes ou IXC) e o login PPPoE.
2. Estado da ONU na OLT: `online`, `offline`, `los`, `dying-gasp`.
   - `los` (perda de sinal) → problema físico: drop, conector, CTO ou cabo.
   - `dying-gasp` → a ONU avisou falta de energia: cliente sem luz ou fonte.
   - Vários `los` na mesma PON ao mesmo tempo → rompimento a montante (CTO ou cabo), abrir ocorrência de rede, não chamado individual.
3. Sinal RX na ONU: -8 a -27 dBm normal; -27 a -30 atenção; abaixo de -30 fora de especificação.
4. RADIUS: login autenticando? Motivo da desconexão?
5. CPE no GenieACS: último inform, WAN PPPoE conectada, Wi-Fi.

## Comandos úteis na OLT ZTE

Usados hoje pelo coletor do NOC (funcionam nas duas OLTs):

- `terminal length 0` — desliga a paginação
- `show gpon onu state` — estado de todas as ONUs (`working` = online, `los`,
  `dyinggasp`, `offline`...), formato `1/2/1:5 enable enable working`
- `show gpon onu baseinfo gpon-olt_1/2/1` — modelo, modo de autenticação (SN,
  LOID...), serial e estado de registro das ONUs de uma PON

Da documentação do ACS (TR70), para configurar TR-069 numa ONU:

```
config
pon-onu-mng gpon-onu_1/1/1:1
 tr069-mgmt 1 state unlock
 tr069-mgmt 1 acs http://<ip-do-acs>/tr069 validate basic username <usuario> password <senha>
 tr069-mgmt 1 tag pri 5 vlan <vlan>
```

- Sinal óptico da ONU e reinício de ONU (comandos exatos da equipe para C300 e
  C350, a sintaxe muda entre firmwares): `A PREENCHER`
