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


