# ChatGPT normal: gateway MCP opcional

Este pacote preserva o servidor `stdio` da versão anterior e inclui um gateway HTTP local, que usa o mesmo processo Node/Playwright.

## Uso local (não expõe a rede)

1. Instale Node.js e as dependências do projeto (`npm ci`). O navegador do Playwright/Edge precisa estar disponível.
2. Gere um token criptograficamente aleatório (pelo menos 32 caracteres) e coloque-o na variável de ambiente `SDF_BRIDGE_TOKEN`, sem gravá-lo em arquivos públicos.
3. Execute `node server/remote-bridge.js` no computador que fará os acessos à Sala do Futuro.
4. Teste o endpoint `/mcp` local usando o cabeçalho `Authorization: Bearer <seu-token>`.

## ChatGPT normal

O chat comum não consegue executar um servidor `stdio` no seu computador automaticamente. Para acessar esta ponte, a conta e o cliente ChatGPT precisam oferecer configuração de conector/app MCP **remoto** que aceite um servidor compatível e o método de autenticação configurado.

Se houver tal opção, disponibilize o gateway atrás de **HTTPS**, proteção de acesso, túnel privado autenticado e permissões restritas. Informe a URL `https://SEU-ENDERECO/mcp` e o token como segredo no conector. O servidor não configura a publicação ou o conector automaticamente. Não exponha a porta em HTTP público, não inclua token em URL e não desative autenticação.

**Limitações atuais:** o portal e Khan Academy dependem de navegador/sessão no computador em execução; o computador precisa estar ligado. O chat comum só funcionará depois que a ponte for acessível e o conector for habilitado pelo cliente. Esta atualização, por si só, não garante disponibilidade nativa do plugin no chat normal. Alguns clientes exigem OAuth e não aceitam segredo bearer, caso em que será necessário um adaptador OAuth na frente da ponte.

## Segurança

- A ponte escuta somente em `127.0.0.1` por padrão.
- Todas as chamadas exigem token. O token não aparece em logs.
- O túnel é responsabilidade do operador. Evite compartilhamento público, pois as ferramentas podem enviar atividades em nome do estudante.
- Prefira permissão de leitura; autorize explicitamente ações de envio e alterações.
- Não envie RA, senha, cookies ou tokens escolares a sites de terceiros.
