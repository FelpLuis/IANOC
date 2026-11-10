---
dominio: hardware
titulo: Hardware, eletrônica e Arduino/ESP32 para o NOC
---

# Hardware, eletrônica e Arduino/ESP32 para o NOC

Guia da NIA para projetos de hardware embarcado: sensores de POP (temperatura, energia, porta,
bateria), automações simples e integração com o Zabbix. Foco em montagem segura e confiável.

## Segurança elétrica primeiro

- **Rede elétrica (127/220 V) mata.** Nunca ligue a rede direto num Arduino/ESP. Para medir ou
  detectar tensão AC use módulos isolados (optoacoplador, transformador, sensor de corrente com
  núcleo aberto) e montagem em caixa fechada, com fusível. Se não houver eletricista, use detecção
  indireta (ex.: fonte 5 V ligada na tomada monitorada).
- Desligue a energia antes de mexer; meça com multímetro antes de tocar.
- **Baterias de chumbo e lítio** fornecem corrente muito alta: fusível perto do borne, fios na bitola
  certa, nada de curto. Lítio exige carregador/BMS próprio.
- **Relé que reinicia equipamento** do POP: só com intertravamento (não reinicia em loop), registro no
  Zabbix e acionamento manual confirmado. Um reboot automático errado derruba clientes.

## Escolha da placa

| Placa | Lógica | Wi-Fi/Rede | ADC | Uso típico |
|---|---|---|---|---|
| Arduino Uno/Nano (ATmega328P) | 5 V | não (precisa de shield Ethernet W5500) | 10 bits, 0–5 V | protótipos, sensores simples |
| Arduino Mega 2560 | 5 V | não | 10 bits, 16 canais | muitos pinos de I/O |
| ESP8266 (NodeMCU, Wemos D1) | 3,3 V | Wi-Fi 2,4 GHz | 1 canal (~0–1 V no chip; placas trazem divisor) | sensor Wi-Fi barato |
| ESP32 (DevKit) | 3,3 V | Wi-Fi + Bluetooth (há versões com Ethernet, ex.: WT32-ETH01, Olimex) | 12 bits, não linear nas pontas | o padrão para sensor de POP |

- Em POP, **Ethernet com fio** é mais confiável que Wi-Fi: ESP32 com PHY LAN8720 ou W5500.
- **ESP32 não tolera 5 V nos pinos** (lógica 3,3 V): use divisor resistivo ou conversor de nível.
- Corrente por pino: ATmega328P ~20 mA recomendado (40 mA máximo absoluto); ESP32 bem menos, na
  prática mantenha abaixo de ~12 mA. Para carga maior (relé, LED forte, buzzer), use transistor/MOSFET
  ou módulo com driver.
- Os pinos ADC2 do ESP32 não funcionam com o Wi-Fi ligado: leia sensores analógicos nos pinos do ADC1
  (GPIO 32–39).

## Barramentos e ligações

- **I²C (SDA/SCL):** vários sensores no mesmo par de fios, cada um com endereço (ex.: BME280 0x76/0x77).
  Precisa de resistores de pull-up (muitos módulos já trazem). Cabos curtos (até ~1 m).
- **1-Wire:** DS18B20 — vários sensores de temperatura num só fio, com resistor de 4,7 kΩ entre dados e
  VCC. Aguenta cabos de alguns metros (bom para medir rack e corredor).
- **UART (serial):** módulos GSM/GPS, leitura de console; atenção ao nível (3,3 V × 5 V) e ao GND comum.
- **SPI:** displays, leitores SD e o W5500 (Ethernet).
- **Entradas digitais** (porta aberta, alarme seco de nobreak): use `INPUT_PULLUP` e ligue o contato ao
  GND; trate o **debounce** (ignorar trocas por ~50 ms).
- GND comum entre a placa e tudo que se comunica com ela é obrigatório.

## Sensores úteis para POP e rack

- **Temperatura/umidade:** DHT22 (barato, lento: uma leitura a cada 2 s), **BME280** (I²C, preciso,
  também mede pressão), **SHT31** (I²C, muito estável), **DS18B20** (1-Wire, só temperatura, sonda à prova d'água).
- **Porta do rack/POP:** sensor magnético (reed switch) em entrada com pull-up.
- **Falta de energia AC:** contato seco do nobreak/retificador, ou detecção isolada (optoacoplador
  com módulo próprio). Com o ESP alimentado por nobreak/bateria, ele continua avisando quando a rede cai.
- **Tensão de bateria/retificador (12/24/48 V DC):** divisor resistivo para a faixa do ADC (ex.: 48 V
  → 3,3 V com 100 kΩ + 6,8 kΩ, mais diodo zener de proteção) e calibração com multímetro; ou módulo
  **INA219/INA226** (I²C) que mede tensão e corrente com precisão.
- **Corrente AC:** sensor de núcleo aberto (SCT-013) em volta de **um** dos fios, com o circuito de
  polarização adequado; não precisa cortar o cabo.
- **Fumaça/gás:** MQ-2 serve para alerta experimental; para incêndio de verdade, use detector certificado
  com contato seco ligado na placa.
- **Vazamento de água:** sonda de dois eletrodos no piso, entrada digital.

## Integração com o Zabbix

1. **HTTP para um coletor/agente:** o ESP32 faz um POST com os valores para um script no servidor
   (Python + `zabbix_utils` Sender, veja o guia de Python), que repassa ao Zabbix como item trapper.
2. **Zabbix sender direto:** o protocolo do trapper (porta 10051) é simples e pode ser
   implementado no ESP32; prefira o caminho 1 se quiser TLS e controle no servidor.
3. **Zabbix puxando:** o ESP32 expõe uma página `/metricas` em JSON e o Zabbix lê com item **HTTP agent**
   + pré-processamento JSONPath. É o caminho mais simples e não exige nada no servidor além do item.
4. **MQTT:** ESP32 publica num broker (Mosquitto) e um conector leva para o Zabbix/Grafana; bom para muitos sensores.

Defina triggers com histerese (ex.: alarme acima de 32 °C, normaliza abaixo de 30 °C) para não ficar
piscando.

## Exemplo: ESP32 com BME280 servindo JSON para o Zabbix (HTTP agent)

Bibliotecas (Arduino IDE ou PlatformIO): `Adafruit BME280`, `Adafruit Unified Sensor`. Ligações: BME280
VCC → 3V3, GND → GND, SDA → GPIO 21, SCL → GPIO 22.

```cpp
#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <Adafruit_BME280.h>

const char* WIFI_SSID = "POP-SENSORES";   // rede de gerência, isolada da rede de clientes
const char* WIFI_SENHA = "troque-esta-senha";
const int PINO_PORTA = 27;                // reed switch entre o GPIO 27 e o GND

Adafruit_BME280 bme;
WebServer servidor(80);
bool bmeOk = false;

void metricas() {
  float t = bmeOk ? bme.readTemperature() : NAN;
  float u = bmeOk ? bme.readHumidity() : NAN;
  bool portaAberta = digitalRead(PINO_PORTA) == HIGH;  // com pull-up: fechada = LOW
  String json = "{";
  json += "\"temperatura\":" + (isnan(t) ? String("null") : String(t, 1)) + ",";
  json += "\"umidade\":" + (isnan(u) ? String("null") : String(u, 1)) + ",";
  json += "\"porta_aberta\":" + String(portaAberta ? 1 : 0) + ",";
  json += "\"uptime_s\":" + String(millis() / 1000) + ",";
  json += "\"rssi\":" + String(WiFi.RSSI());
  json += "}";
  servidor.send(200, "application/json", json);
}

void setup() {
  Serial.begin(115200);
  pinMode(PINO_PORTA, INPUT_PULLUP);
  Wire.begin(21, 22);
  bmeOk = bme.begin(0x76) || bme.begin(0x77);
  if (!bmeOk) Serial.println("BME280 nao encontrado: confira as ligacoes e o endereco I2C");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_SENHA);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.printf("\nIP: %s\n", WiFi.localIP().toString().c_str());

  servidor.on("/metricas", metricas);
  servidor.begin();
}

void loop() {
  servidor.handleClient();
  // Wi-Fi caiu: reconecta sem travar o loop.
  static unsigned long ultimaTentativa = 0;
  if (WiFi.status() != WL_CONNECTED && millis() - ultimaTentativa > 10000) {
    ultimaTentativa = millis();
    WiFi.reconnect();
  }
}
```

No Zabbix: item **HTTP agent** com a URL `http://IP-DO-ESP/metricas` a cada 1 minuto, e itens
dependentes com pré-processamento JSONPath `$.temperatura`, `$.umidade`, `$.porta_aberta`.
Fixe o IP do ESP por reserva DHCP.

## Confiabilidade em campo

- **Watchdog:** no ESP32, o watchdog de tarefa (`esp_task_wdt`) reinicia a placa se o programa travar.
- **Reconexão:** sempre trate a queda de Wi-Fi/rede no `loop` sem bloquear.
- **Fonte:** use fonte de qualidade (5 V/2 A); fonte ruim causa reinícios aleatórios ("brownout").
  Alimente pelo nobreak do POP.
- **Caixa e conectores:** caixa plástica com ventilação, conectores parafusáveis (bornes), cabos
  identificados; sensor de temperatura longe da saída de ar quente da placa.
- **OTA:** atualização de firmware pela rede (ArduinoOTA) com senha, para não precisar ir ao POP.
- **Segurança:** coloque os sensores numa VLAN de gerência sem acesso à internet; troque senhas
  padrão; não exponha a porta do ESP para fora.

## Ferramentas e bancada

- Multímetro (tensão, continuidade), fonte de bancada com limite de corrente, ferro de solda com
  controle de temperatura, protoboard e jumpers para protótipo, analisador lógico barato para I²C/SPI.
- Teste o circuito na protoboard, depois passe para placa perfurada/PCB soldada para ir ao POP.
- **PlatformIO** (VS Code) organiza bibliotecas e versões melhor que a Arduino IDE em projetos maiores.

## Exemplos de pedidos que a NIA pode atender

- "Monte um sensor de temperatura e porta para o POP com ESP32 e mande para o Zabbix."
- "Como medir a tensão do banco de baterias de 48 V com um ESP32 com segurança?"
- "Escreva o código Arduino para ler três DS18B20 no mesmo fio."
- "Qual sensor de temperatura usar no rack e como ligar?"
