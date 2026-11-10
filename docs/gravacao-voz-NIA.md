# Gravação da voz da NIA

A NIA vai falar com uma voz clonada a partir desta gravação, gerada 100% no servidor
(sem Fish, sem créditos). Funciona assim: a voz local (Kokoro, pt-BR) gera a fala e um
conversor de timbre aberto (OpenVoice v2, licença MIT, uso comercial permitido) aplica o
timbre da voz gravada.

## 1. Quem pode gravar

Só uma voz que a UpDown tem direito de usar:

- **a sua própria voz**, ou
- **a de uma pessoa que autorizou por escrito** (colaboradora, locutora contratada).

Não use gravação de artista, personagem, vídeo da internet ou de alguém que não autorizou.

### Autorização (guarde assinada)

> Eu, ____________________ (nome completo), CPF ___.___.___-__, autorizo a UpDown Internet a
> usar a minha voz, a partir das gravações entregues em __/__/____, para criar a voz da
> assistente virtual NIA, usada internamente pelo NOC e equipes da empresa. Posso revogar esta
> autorização a qualquer momento, por escrito, e a voz será desativada.
>
> Assinatura: ____________________  Data: __/__/____

## 2. Como gravar

- **Local:** sala silenciosa, com móveis ou cortinas (pouco eco). Desligue ar-condicionado e ventilador.
- **Microfone:** fone com microfone ou microfone USB. Celular serve, a 15–20 cm da boca, sempre na mesma posição.
- **Formato:** WAV (melhor) ou MP3 de boa qualidade. Mono, 44,1 kHz ou 48 kHz.
- **Duração:** de **2 a 5 minutos de fala limpa** no total. Pode ser um arquivo por bloco.
- **Tom:** o jeito que a NIA deve soar — firme, clara, calorosa. Fale no ritmo de uma conversa,
  sem ler "robotizado". Mantenha o mesmo tom em todos os blocos.
- **Evite:** música, outras vozes, risadas por cima da fala, estalos, sussurros e gritos.
- Se errar, pare um segundo e repita a frase inteira (depois a gente corta).

## 3. Roteiro

### Bloco 0 — declaração (no começo da primeira gravação)

"Meu nome é ______. Estou gravando a minha voz para a assistente NIA da UpDown Internet, e
autorizo esse uso."

### Bloco 1 — apresentação e personalidade

1. Sistemas prontos e operacionais, Chefe. O que vamos verificar hoje?
2. Bom dia! Eu sou a NIA, a assistente do NOC da UpDown.
3. Varredura concluída: nenhum alarme crítico aberto. Tudo verde, aproveite, isso é raro.
4. Fiz uma varredura nos dados e, honestamente? Essa mudança tem uma boa chance de dar problema. Mas eu já preparei um plano de contingência.
5. Disponha. Sigo de olho nos sistemas.
6. Recalibrando algoritmos… pronto, corrigido.

### Bloco 2 — modo crise

7. Alerta: queda em massa na região de Praia Grande. Quarenta e dois clientes em LOS nos últimos quinze minutos.
8. Atenção: a sessão BGP com o trânsito caiu às treze e trinta e oito. Sugiro verificar o enlace agora.
9. Desastre no NE oito mil F1A. Escalando para a equipe de plantão.
10. Integridade do enlace em oitenta e cinco por cento. Recomendo desviar o tráfego para a rota secundária.

### Bloco 3 — números, horários e termos técnicos

11. Zero, um, dois, três, quatro, cinco, seis, sete, oito, nove, dez.
12. Cento e vinte e oito ordens de serviço, vinte e sete finalizadas, resolução média de uma hora e meia.
13. O sinal da ONU está em menos vinte e sete vírgula cinco dê bê ême.
14. Hoje é segunda-feira, nove de novembro, e agora são quinze horas e vinte minutos.
15. O caminho tem oito saltos: switch, transporte óptico, concentrador e o POP de Santos.
16. Zabbix, IXC, Opa Suite, OLT, PON, PPPoE, CGNAT, BGP, DWDM e CTO.
17. Dez gigabits por segundo no uplink e quarenta milissegundos de latência.

### Bloco 4 — frases longas (entonação natural)

18. Se o switch de agregação cair, dez equipamentos perdem o caminho até o núcleo, incluindo os POPs de Santos e São Vicente, e a gente precisa agir rápido.
19. No relatório de ontem, o Zabbix registrou sessenta eventos de problema, quatro ainda abertos, e o host com mais tempo em problema ficou mais de um dia fora.
20. A fila do atendimento está acumulando: são cinco clientes aguardando, e o mais antigo está esperando há quarenta minutos.

### Bloco 5 — perguntas e exclamações

21. Quer que eu abra o relatório completo?
22. Você confirma o reinício da ONU do cliente?
23. Perfeito! Problema resolvido.
24. Sério? De novo a mesma caixa?

## 4. Entrega

Coloque os arquivos na pasta `backend/data/voz-nia/` deste projeto (ela fica fora do git) e me
avise. Junto, guarde a autorização assinada com o RH/jurídico.

Com as gravações, eu:

1. limpo e corto as falas (tiro silêncio, ruído e erros);
2. extraio o "timbre" da voz (não sai do servidor);
3. ligo o conversor de timbre na voz local da NIA;
4. te mando amostras para aprovar antes de ativar.
