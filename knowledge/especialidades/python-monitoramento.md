---
dominio: python
titulo: Python para scripts de monitoramento e automação do NOC
---

# Python para scripts de monitoramento e automação do NOC

Guia de referência da NIA para escrever scripts Python que coletam dados da rede, conversam com
Zabbix, IXC e equipamentos, e rodam sozinhos no servidor. Foco: código seguro, previsível e fácil
de manter pela equipe do NOC.

## Princípios para scripts de NOC

- **Somente leitura por padrão.** Script que altera equipamento (reboot, config, desativar porta)
  só com flag explícita (`--aplicar`) e confirmação; o padrão é simular e mostrar o que faria.
- **Credenciais fora do código.** Use variáveis de ambiente (`os.environ`) ou um arquivo `.env`
  com permissão 600 (`python-dotenv`). Nunca faça commit de senha, token ou community SNMP.
- **Sempre com timeout.** Toda chamada de rede (HTTP, SSH, SNMP, socket) precisa de timeout; um
  equipamento travado não pode travar o script inteiro.
- **Falha de um host não derruba a coleta.** Trate a exceção por host, registre e siga para o próximo.
- **Log em vez de print.** Módulo `logging` com nível configurável; em serviço systemd o log vai
  para o journal (`journalctl -u nome`).
- **Idempotente.** Rodar duas vezes não pode duplicar alerta nem cadastro.
- **Limite a carga.** Paralelismo com teto (ex.: 20 conexões simultâneas) para não sobrecarregar
  OLT, switch ou a API do Zabbix.

## Ambiente: Python, venv e dependências

- Use Python 3.10 ou mais novo. Em Debian/Ubuntu: `sudo apt install python3 python3-venv python3-pip`.
- Um ambiente virtual por projeto:
  ```bash
  python3 -m venv /opt/noc-scripts/venv
  /opt/noc-scripts/venv/bin/pip install requests python-dotenv
  ```
- Fixe as versões em `requirements.txt` (`pip freeze > requirements.txt`) e instale com
  `pip install -r requirements.txt` no servidor.
- Bibliotecas úteis no NOC:
  - `requests` / `httpx`: APIs HTTP (Zabbix, IXC, Telegram, webhooks).
  - `zabbix_utils`: biblioteca oficial da Zabbix (API, sender e get).
  - `pysnmp` (ou `easysnmp`, que depende da net-snmp em C): consultas SNMP.
  - `netmiko`: SSH/Telnet em equipamentos de rede (Huawei, ZTE, Cisco, Mikrotik etc.).
  - `paramiko`: SSH de baixo nível.
  - `icmplib`: ping em Python (com `privileged=False` não precisa de root, se o kernel permitir ping sem privilégio).
  - `pandas` / `openpyxl`: relatórios e planilhas.
  - `schedule` ou, melhor, timers do systemd para agendamento.

## Estrutura recomendada de um script

```python
#!/usr/bin/env python3
"""Descrição curta: o que coleta, de onde, para onde manda."""
import argparse
import logging
import os
import sys

log = logging.getLogger("noc.coletor")


def configurar_log(verboso: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verboso else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def principal() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--verboso", action="store_true")
    p.add_argument("--aplicar", action="store_true", help="executa de verdade (padrão: só simula)")
    args = p.parse_args()
    configurar_log(args.verboso)

    token = os.environ.get("ZABBIX_TOKEN")
    if not token:
        log.error("defina ZABBIX_TOKEN no ambiente")
        return 2
    # ... trabalho ...
    return 0


if __name__ == "__main__":
    sys.exit(principal())
```

- Código de saída 0 = ok, diferente de 0 = falha (o systemd e o Zabbix enxergam isso).
- `argparse` documenta o uso sozinho (`script.py --help`).

## Zabbix pela API (JSON-RPC)

- Endpoint: `https://zabbix.exemplo/api_jsonrpc.php`. A partir do Zabbix 6.4 o token vai no cabeçalho
  `Authorization: Bearer <token>`; em versões anteriores, no campo `"auth"` do corpo.
- Crie um **token de API** para um usuário só de leitura (Usuários → Tokens de API) para scripts de consulta.
- Métodos mais usados: `problem.get` (problemas abertos), `event.get` (histórico), `host.get`,
  `item.get`, `history.get`, `trend.get`, `trigger.get`.

```python
import os
import requests

URL = os.environ["ZABBIX_URL"].rstrip("/") + "/api_jsonrpc.php"
TOKEN = os.environ["ZABBIX_TOKEN"]


def zabbix(metodo: str, params: dict):
    r = requests.post(
        URL,
        json={"jsonrpc": "2.0", "method": metodo, "params": params, "id": 1},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=15,
    )
    r.raise_for_status()
    corpo = r.json()
    if "error" in corpo:
        raise RuntimeError(f"Zabbix: {corpo['error'].get('data') or corpo['error']}")
    return corpo["result"]


# Problemas de severidade alta (4) ou desastre (5), com o nome do host.
problemas = zabbix("problem.get", {
    "output": ["eventid", "name", "severity", "clock", "acknowledged"],
    "severities": [4, 5],
    "recent": False,
    "sortfield": ["eventid"],
    "sortorder": "DESC",
})
# problem.get não traz o host: busque pelo event.get com selectHosts.
ids = [p["eventid"] for p in problemas]
eventos = zabbix("event.get", {"eventids": ids, "selectHosts": ["name"], "output": ["eventid"]}) if ids else []
hosts = {e["eventid"]: ", ".join(h["name"] for h in e["hosts"]) for e in eventos}
for p in problemas:
    print(p["severity"], hosts.get(p["eventid"], "?"), p["name"])
```

- Severidades do Zabbix: 0 não classificada, 1 informação, 2 atenção, 3 média, 4 alta, 5 desastre.
- `clock` é Unix timestamp em UTC; converta com `datetime.fromtimestamp(int(clock), tz=ZoneInfo("America/Sao_Paulo"))`.

### Enviar valores ao Zabbix (item trapper)

- Crie no host um item do tipo **Zabbix trapper** com a chave desejada (ex.: `pop.temperatura`).
- Envie com o `zabbix_sender` (pacote `zabbix-sender`) ou com a biblioteca `zabbix_utils`:

```python
from zabbix_utils import Sender

sender = Sender(server="zabbix.exemplo", port=10051)
resposta = sender.send_value("POP-SANTOS", "pop.temperatura", 27.5)
print(resposta)  # processed / failed
```

- Para muitos valores de uma vez, monte uma lista de `ItemValue` e use `sender.send(lista)`.
- O trapper aceita só dos IPs listados em "Allowed hosts" do item; confira isso quando o envio falhar.

## SNMP: contadores, uptime e interfaces

- OIDs essenciais (IF-MIB / SNMPv2-MIB):
  - `1.3.6.1.2.1.1.3.0` sysUpTime (centésimos de segundo)
  - `1.3.6.1.2.1.1.5.0` sysName
  - `1.3.6.1.2.1.2.2.1.8` ifOperStatus (1 up, 2 down)
  - `1.3.6.1.2.1.31.1.1.1.1` ifName
  - `1.3.6.1.2.1.31.1.1.1.6` ifHCInOctets (64 bits)
  - `1.3.6.1.2.1.31.1.1.1.10` ifHCOutOctets (64 bits)
  - `1.3.6.1.2.1.31.1.1.1.15` ifHighSpeed (Mbps)
- **Sempre use os contadores de 64 bits (HC)** em links de 1 Gbps ou mais: o de 32 bits
  (`ifInOctets`) dá a volta em cerca de 34 segundos a 1 Gbps cheio.
- Taxa em bits/s = `(octetos_agora - octetos_antes) * 8 / segundos_entre_as_leituras`. Se a diferença
  der negativa, o contador zerou (reboot) ou deu a volta: descarte essa amostra.
- Prefira **SNMPv3** (authPriv, SHA + AES) em equipamento exposto; v2c manda a community em texto puro.
- Teste antes pela linha de comando: `snmpwalk -v2c -c COMMUNITY 10.0.0.1 1.3.6.1.2.1.31.1.1.1.1`.

```python
# pysnmp 6.x/7.x (API asyncio). Em versões antigas os nomes mudam: confira a documentação da versão instalada.
import asyncio
from pysnmp.hlapi.v3arch.asyncio import (
    CommunityData, ContextData, ObjectIdentity, ObjectType, SnmpEngine, UdpTransportTarget, get_cmd,
)


async def uptime(ip: str, community: str) -> float | None:
    erro, status, _, binds = await get_cmd(
        SnmpEngine(),
        CommunityData(community, mpModel=1),  # mpModel=1 → SNMP v2c
        await UdpTransportTarget.create((ip, 161), timeout=2, retries=1),
        ContextData(),
        ObjectType(ObjectIdentity("1.3.6.1.2.1.1.3.0")),
    )
    if erro or status:
        return None
    return int(binds[0][1]) / 100 / 3600  # horas


print(asyncio.run(uptime("10.0.0.1", "public")))
```

## Ping e disponibilidade em massa

```python
import asyncio
from icmplib import async_multiping

hosts = ["10.0.0.1", "10.0.0.2", "8.8.8.8"]


async def main():
    resultados = await async_multiping(hosts, count=3, interval=0.2, timeout=1, concurrent_tasks=50, privileged=False)
    for h in resultados:
        estado = "UP" if h.is_alive else "DOWN"
        print(f"{h.address:15} {estado:4} perda={h.packet_loss:.0%} rtt={h.avg_rtt:.1f} ms")


asyncio.run(main())
```

- Sem root, o Linux precisa permitir ping de usuário: `sysctl net.ipv4.ping_group_range="0 2147483647"`.
- Para alarmar, considere "fora" só depois de N falhas seguidas (evita alarme por um pacote perdido).

## SSH em equipamentos com Netmiko

```python
import os
from netmiko import ConnectHandler

equip = {
    "device_type": "huawei",  # zte_zxros, cisco_ios, mikrotik_routeros, juniper_junos...
    "host": "10.0.0.1",
    "username": os.environ["EQUIP_USER"],
    "password": os.environ["EQUIP_PASS"],
    "timeout": 20,
    "fast_cli": False,
}
with ConnectHandler(**equip) as conn:
    saida = conn.send_command("display interface brief", read_timeout=30)
print(saida)
```

- Comece só com comandos `display`/`show`. Para configurar, use `send_config_set` com uma lista
  revisada, e só com `--aplicar`.
- Muitos equipamentos: `concurrent.futures.ThreadPoolExecutor(max_workers=10)` com uma conexão por thread.
- Se a saída vier truncada, desligue a paginação (`screen-length 0 temporary` no Huawei,
  `terminal length 0` no Cisco) — o Netmiko já faz isso para os tipos que conhece.
- Para transformar a saída em dados: `TextFSM`/`ntc-templates` (`use_textfsm=True`) ou regex.

## Alertas: Telegram, e-mail e webhook

```python
import os
import requests


def telegram(texto: str) -> None:
    token = os.environ["TELEGRAM_TOKEN"]      # do @BotFather
    chat = os.environ["TELEGRAM_CHAT_ID"]     # grupo do NOC
    r = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat, "text": texto, "parse_mode": "HTML", "disable_web_page_preview": True},
        timeout=10,
    )
    r.raise_for_status()
```

- Evite enxurrada: agrupe alertas iguais e respeite um intervalo mínimo entre mensagens do mesmo assunto.
- Guarde o estado anterior (arquivo JSON ou SQLite) para alertar só na **mudança** (caiu / voltou).

## Agendamento com systemd (melhor que cron)

`/etc/systemd/system/noc-coletor.service`:

```ini
[Unit]
Description=Coletor do NOC
After=network-online.target

[Service]
Type=oneshot
User=noc
EnvironmentFile=/etc/noc-scripts/coletor.env
ExecStart=/opt/noc-scripts/venv/bin/python /opt/noc-scripts/coletor.py
TimeoutStartSec=5min
```

`/etc/systemd/system/noc-coletor.timer`:

```ini
[Unit]
Description=Roda o coletor do NOC a cada 5 minutos

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
```

- Ative com `sudo systemctl daemon-reload && sudo systemctl enable --now noc-coletor.timer`.
- Veja execuções com `systemctl list-timers` e logs com `journalctl -u noc-coletor -n 50`.
- O arquivo `.env` com credenciais: `chmod 600`, dono `noc`.

## Dados e relatórios

- Para séries pequenas, **SQLite** (`sqlite3`, já vem no Python) resolve: uma tabela
  `(host, metrica, ts, valor)` com índice em `(host, metrica, ts)`.
- Planilha para gestão: `pandas.DataFrame(...).to_excel("relatorio.xlsx", index=False)` (precisa de `openpyxl`).
- Percentil 95 de tráfego (cobrança/capacidade): ordene as amostras de 5 minutos do mês, descarte os 5%
  maiores e pegue o maior restante — `numpy.percentile(amostras, 95)` faz isso com interpolação.
- Datas sempre com fuso: `datetime.now(ZoneInfo("America/Sao_Paulo"))`; guarde em UTC e converta só na exibição.

## Boas práticas de qualidade

- Tipagem (`def f(ip: str) -> bool`) e `ruff` (lint + formatação) deixam o código legível para a equipe.
- Testes simples com `pytest` para as funções de cálculo (taxa, orçamento óptico, parsing de saída).
- Separe coleta, regra de negócio e envio de alerta em funções diferentes: dá para testar sem rede.
- Versione os scripts num repositório git (sem `.env`), com um `README.md` explicando como rodar.

## Exemplos de pedidos que a NIA pode atender

- "Crie um script Python que lista os alarmes de desastre do Zabbix e manda no Telegram."
- "Escreva um coletor SNMP que calcula o tráfego das interfaces de uplink a cada 5 minutos."
- "Como agendar meu script para rodar a cada 10 minutos no servidor?"
- "Faça um script que faz ping em uma lista de OLTs e alerta se duas falharem seguidas."
