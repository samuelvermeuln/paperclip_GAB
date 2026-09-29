# Paperclip — investigar e registrar a falha OAuth do Databricks

## Objetivo

Identificar a causa real da falha ao criar `databricks/discovery-sessions`, corrigir o problema comprovado e substituir o erro genérico por diagnóstico seguro. Manter o escopo restrito ao OAuth e à observabilidade; não refazer a descoberta de catálogos.

## Evidências disponíveis

- No Windows/Git Bash, a chamada direta retornou **HTTP 200 e token recebido**, usando `scope=unity-catalog`.
- No Paperclip, o retorno continua sendo `DATABRICKS_UPSTREAM_ERROR`, `stage=oauth`, `retryable=true`.
- O log do servidor mostra **422 local**, em aproximadamente 862 ms, mas não informa o status ou a resposta externa.
- Isso confirma que as credenciais usadas no teste local funcionam. Não confirma que o container usa os mesmos valores ou executa a mesma requisição.
- Não atribuir a falha ao Databricks, ao secret ou à rede sem evidência. O código atual ainda precisa ser inspecionado.

## Investigação e alteração

1. Localizar a rota de discovery, a função que solicita o token e o ponto que converte exceções em `DATABRICKS_UPSTREAM_ERROR`. Verificar se o `catch` também encobre erro de parsing, validação da resposta ou criação do rascunho após OAuth bem-sucedido.
2. Comparar a implementação com a chamada que funcionou:

   ```text
   POST https://dbc-2ada2295-fbcd.cloud.databricks.com/oidc/v1/token
   Authorization: Basic <clientId:clientSecret codificados>
   Content-Type: application/x-www-form-urlencoded
   grant_type=client_credentials&scope=unity-catalog
   ```

3. Conferir HTTP Basic, corpo URL-encoded, scope efetivamente enviado, host e origem da credencial. Verificar uso indevido de secret antigo, cache ou variável de ambiente sobrescrevendo o formulário. Não modificar o secret silenciosamente.
4. Instrumentar a chamada externa **antes** do tratamento genérico. Ler a resposta uma única vez e tratar JSON, resposta não JSON e falha sem resposta HTTP separadamente.
5. Reproduzir no **mesmo container do Paperclip**, com o mesmo runtime e configuração HTTP da aplicação. Um teste no Windows ou apenas no host da VPS não reproduz integralmente esse ambiente. Não colocar credenciais em histórico de comandos ou saídas.
6. Conferir proxy, DNS, TLS, timeout e redirecionamentos se a evidência apontar para rede. Não desabilitar validação TLS. Confirmar também que a imagem em execução contém a alteração de diagnóstico.

## Log estruturado obrigatório

Reutilizar o logger existente. Emitir um evento de falha com:

```text
event: databricks.oauth.failed
requestId: correlação com a requisição local
stage: oauth_request | oauth_response | oauth_parse | discovery_session
workspaceHost, endpointPath, method, scope
credentialSource: request | stored_connection | environment
durationMs, upstreamStatus, responseContentType
upstreamError, upstreamErrorDescription
networkCode, causeCode, retryable
```

Os nomes de campos são propostos. `upstreamStatus` deve ser nulo quando não houver resposta HTTP. Códigos de rede vêm da exceção e de sua causa, sem serializar o objeto completo. Registrar sucesso OAuth apenas com status, duração e presença do token, nunca com seu valor.

**Proteção dos logs:** usar lista explícita de campos permitidos. Sanitizar e limitar descrições externas a 500 caracteres, removendo quebras de linha, credenciais conhecidas e padrões de token/autorização; se não for seguro sanitizar, omitir a descrição. Nunca registrar secret, access/refresh token, Basic/Bearer, cookies, corpo bruto, resposta de sucesso ou objeto completo de erro HTTP. Para HTML/texto inesperado, registrar apenas status, content-type e tamanho, sem conteúdo.

## Classificação e resposta ao frontend

| Evidência | Tratamento |
|---|---|
| `invalid_client` explícito | Erro de autenticação; sem retry automático |
| Escopo rejeitado explicitamente | Erro de escopo; sem ampliar privilégios automaticamente |
| HTTP 429, 5xx ou timeout transitório | Retry limitado, respeitando `Retry-After` quando presente |
| DNS/TLS/conexão | Código de transporte específico; decidir retry conforme a causa |
| Resposta inesperada ou inválida | Preservar status/content-type; não assumir credencial incorreta |
| OAuth 200 seguido de falha interna | Classificar na etapa interna correta, não como falha externa |

Manter o envelope compatível com o frontend. Acrescentar `requestId`, `stage`, `upstreamStatus` e código externo sanitizado quando disponíveis. Mensagem curta e segura para o usuário; detalhes técnicos ficam no servidor. Não marcar toda exceção como `retryable=true`.

## Validação e entrega

- [ ] Testar OAuth 200 válido, `invalid_client`, rejeição de escopo, 429/5xx, timeout, resposta não JSON e erro interno após token válido.
- [ ] Usar credenciais fictícias nos testes e verificar que nenhum valor sensível aparece nos logs ou respostas.
- [ ] Reproduzir a falha real no container e relacionar o evento OAuth ao log da rota pelo `requestId`.
- [ ] Corrigir somente a causa demonstrada; validar nova tentativa pelo onboarding.
- [ ] Entregar arquivos alterados, causa comprovada, exemplo de log sanitizado e testes executados. Se faltar acesso ao ambiente, informar a verificação pendente sem declarar o problema resolvido.

Referência oficial: https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m
