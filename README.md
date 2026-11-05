# Sala do Futuro Remote MCP

Node/Playwright server for a private Render web service. A request wakes a sleeping free service. The browser runs headlessly and loads encrypted session state from Postgres. The server never stores the student's password. CAPTCHA and other interactive challenges require the user to take over; no bypass is implemented.

## Runtime configuration

- `MCP_TOKEN`: random high-entropy bearer token for the private MCP endpoint.
- `SESSION_KEY`: 32 random bytes encoded as base64; used for AES-256-GCM encryption of the browser state.
- `DATABASE_URL`: Render Postgres connection URL. A free Render database expires after 30 days, so it is a test environment rather than durable production storage.
- `PORT`: set by Render.

Deploy the Dockerfile as a Render web service. It binds to `0.0.0.0:$PORT`. The service exposes `/health` and authenticated `/mcp`. Do not commit credentials or session state. Configure the plugin's remote MCP connection with the HTTPS `/mcp` URL and API-key bearer authentication. Use `bootstrap_login` once to create the server-side session, then `open_session` to check it after cold starts.

The code can run locally for protocol testing with `npm ci` and `npm start`. Browser-dependent calls require an installed Playwright Chromium. On Render, the pinned Docker base image includes the browser.
# Estado de validação

Este servidor é um protótipo MCP remoto. O transporte HTTP, a autenticação do
endpoint e a lista de ferramentas foram testados localmente. O login real da
Sala do Futuro em Chromium headless, a seleção de perfil, a listagem completa
das atividades e o envio de uma atividade ainda não foram validados de ponta
a ponta. Não implante para uso de produção antes dessa validação.

O fluxo de login atual recebe RA, dígito e senha, mas ainda não recebe UF.
O retorno `login_failed_or_more_steps_required` exige intervenção e não deve
ser tratado como autenticação concluída. CAPTCHA requer resolução manual.

O código do servidor do zunder.lat não está disponível na página pública;
seus termos descrevem autenticação direta nas plataformas oficiais, sem
documentar endpoints ou protocolos. Não há base verificada para replicar
um login por token sem navegador.

## Pesquisa do protocolo oficial (04/11/2026)

O aplicativo web oficial envia `POST` para
`https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken`
com JSON contendo `user` e `senha`. Em um teste com dados fictícios, `user`
foi formado como RA + dígito + UF. A chamada inclui o cabeçalho
`Ocp-Apim-Subscription-Key`; sem ele, a API responde que falta uma chave de
assinatura. O mesmo teste com a chave capturada da aplicação pública,
executado por `fetch` no Node sem navegador, recebeu `401` com a resposta
normal de credenciais inválidas. Um teste autorizado com a conta do usuário
retornou `200` e os campos `token`, `tokenResumo` e `DadosUsuario`. Assim, o
login direto sem janela está demonstrado. O teste não armazenou o token, e
o servidor MCP ainda usa o fluxo Playwright anterior. Não registre valores
da chave, senha ou token.

O servidor agora expõe `direct_login(ra, digit, uf, password)`. O teste local
retornou `authenticated_api_ephemeral` com um perfil e identificador de
usuário presentes. Em produção, com `DATABASE_URL` e `SESSION_KEY`, o token
é salvo cifrado e o resultado passa a `authenticated_api`. A consulta de
atividades ainda não consome esse token; `direct_login` confirma apenas o
acesso à API de autenticação.

Os arquivos públicos do aplicativo também referenciam `ValidarToken`,
`Login/Token` e rotas de dados acadêmicos. A forma de usar o token nas rotas
de tarefas deve ser medida em uma sessão autorizada antes de implementar a
integração direta. Não deduza a estrutura de respostas a partir dos nomes
dessas rotas.

Uma sessão de navegador headless recebeu `200` no login e nas consultas de
turma e bimestre, porém voltou à escolha de perfil ao abrir `/tarefas`.
Portanto, a listagem e a submissão precisam de mais análise; resposta HTTP
de sucesso no login não comprova que a interface está pronta para tarefas.


