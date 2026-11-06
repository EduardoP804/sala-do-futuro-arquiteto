# Sala do Futuro Arquiteto: migração em andamento

Esta branch contém o código do plugin pessoal v0.7.3 em `plugin-runtime/` e o backend MCP existente em `src/`.

**Importante:** os dois componentes ainda não estão integrados. O `Dockerfile` atual inicia apenas o servidor de `src/server.js`. Não afirmar que o plugin completo já funciona na AWS.

## Etapa 1: teste privado do backend AWS

O arquivo `compose.aws.yaml` executa o backend já existente com exposição restrita ao localhost do servidor. Ele não publica o MCP na internet e não inclui credenciais.

Na instância AWS, após clonar esta branch:

```bash
cd sala-do-futuro-arquiteto
git fetch origin
git switch integration/plugin-0.7.3
openssl rand -hex 32
```

Salve o valor gerado em um `.env` local (nunca no GitHub):

```dotenv
MCP_TOKEN=COLE_AQUI_UM_TOKEN_ALEATORIO
```

Inicie:

```bash
sudo docker compose -f compose.aws.yaml up -d --build
sudo docker compose -f compose.aws.yaml ps
curl -fsS http://127.0.0.1:10000/health
```

O endpoint MCP requer bearer token e ainda precisa de um proxy HTTPS autenticado antes de qualquer acesso remoto.

## Próximas etapas

- Revisar e retirar quaisquer tokens embutidos no código importado antes de expor o serviço.
- Criar adaptador MCP para as funcionalidades do plugin v0.7.3; o gateway legado em `plugin-runtime/server/remote-bridge.js` não foi validado como implementação completa do protocolo.
- Adaptar o painel, que originalmente assume execução no computador local, para o ambiente remoto.
- Proteger dados dos estudantes, manter login assistido e exigir aprovação para ações de envio de respostas.
- Executar testes de memória na instância de 1 GB antes de habilitar Chromium.
- Configurar HTTPS e autenticação antes de conectar o ChatGPT.

A presença de `node_modules` no histórico do Git é desnecessária; a exclusão no `.dockerignore` evita incluí-lo no build. O histórico não é alterado.
