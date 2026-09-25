# Implementation Plan: Databricks Unity Gateway — Combos Dinâmicos via OAuth M2M

## Overview

Esta migração substitui a autenticação por Personal Access Token estático (`method: "api_key"`,
`DATABRICKS_TOKEN`) do provider Databricks por OAuth 2.0 Machine-to-Machine (client credentials),
com um helper externo (`auth.command`) responsável por trocar `clientId`/`clientSecret` por um
Access Token de curta duração a cada `refresh_interval_ms`. A implementação segue a ordem de
dependência técnica: contratos compartilhados → serviço de troca/cache de token → serviços de
conexão e descoberta → runtime de execução → adapter `codex_local` (payload + helper binário +
readiness) → UI → compatibilidade com conexões existentes e documentação.

Nenhum código deste plano introduz um novo adapter: `codex_local` continua sendo o único adapter
executor: Databricks é apenas um provedor de modelo dentro dele.

## Tasks

- [x] 1. Contratos compartilhados para OAuth M2M
  - [x] 1.1 Atualizar `packages/shared/src/ai-connections.ts`
    - Estender `aiAuthMethodSchema` com `"oauth_m2m"`.
    - Tornar `envKey` opcional em `AI_CONNECTION_CAPABILITIES[...].methods[...]` (assinatura
      `Partial<Record<AiAuthMethod, { adapters: readonly string[]; envKey?: string }>>`) e mudar
      `AI_CONNECTION_CAPABILITIES.databricks.methods` de `api_key` para `oauth_m2m: { adapters: ["codex_local"] }`
      (sem `envKey`).
    - Adicionar `databricksOAuthCredentialSchema` (`{ clientId, clientSecret }`, `.strict()`) e
      exportar `DatabricksOAuthCredential`.
    - Atualizar `createAiConnectionSchema`: adicionar campos opcionais `clientId`/`clientSecret`;
      no `superRefine` para `provider === "databricks"`, exigir `method === "oauth_m2m"` (rejeitar
      qualquer outro valor com mensagem indicando que `oauth_m2m` é o único método suportado) e
      exigir `clientId`/`clientSecret`/`workspaceHost`/`catalog`/`schema` não vazios.
    - Manter `databricksConnectionConfigSchema` (workspace host/catalog/schema/modelPrefix)
      inalterado — ele já não carrega segredo.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_
  - [x] 1.2 Escrever testes unitários em `packages/shared/src/ai-connections.test.ts`
    - `createAiConnectionSchema` rejeita `provider: "databricks"` com `method` diferente de
      `oauth_m2m`; rejeita ausência/vazio de `clientId`, `clientSecret`, `workspaceHost`,
      `catalog`, `schema` com uma issue por campo ausente.
    - `databricksOAuthCredentialSchema` aceita um par válido e rejeita campos ausentes, vazios ou
      excedentes (`.strict()`).
    - _Requirements: 2.1, 2.2_
  - [x] 1.3 Atualizar `AdapterModelDiscoveryContext` em `packages/adapter-utils/src/types.ts`
    - Trocar `resolvedCredential.token` por `clientId: string; clientSecret: string;` e adicionar
      `credentialVersion: string`, mantendo `host`/`catalog`/`schema`/`modelPrefix`.
    - _Requirements: 5.1, 5.2_

- [x] 2. Serviço de troca/cache de token OAuth M2M
  - [x] 2.1 Adicionar `fast-check` (versão `4.10.2`, fixa) como devDependency em `server/package.json`
    para os testes de propriedade das tarefas 2.4, 4.3 e 4.4.
  - [x] 2.2 Implementar `server/src/services/databricks-oauth.ts`
    - `fetchDatabricksAccessToken(input: { host, clientId, clientSecret })`: `POST {host}/oidc/v1/token`
      com `grant_type=client_credentials`, timeout de 10s, sem retry implícito.
    - `resolveDatabricksAccessToken(key: DatabricksDiscoveryKey, credential, options?: { forceRefresh?: boolean })`:
      cache por chave completa (`companyId`+`connectionId`+`credentialVersion`+`host`), reaproveita
      uma entrada com `expiresAt > now + 60_000`, coalesce chamadas concorrentes por chave (mesmo
      padrão `pending` de `databricks-model-services.ts`).
    - `invalidateDatabricksAccessToken(connectionId: string)`: remove toda entrada em cache dessa
      conexão (todas as versões), mesmo padrão de `invalidateDatabricksModelServiceCache`.
    - Reutiliza a classe `DatabricksDiscoveryError`/`DatabricksDiscoveryErrorKind` já exportada por
      `databricks-model-services.ts` para classificar 401/403/429(+Retry-After)/5xx/timeout; nunca
      inclui `clientSecret`, o token emitido, ou o corpo da resposta na mensagem de erro.
    - _Requirements: 4.7, 5.2, 5.3, 6.2, 6.3, 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x] 2.3 Escrever testes unitários em `server/src/services/databricks-oauth.test.ts`
    - Cache hit sem I/O de rede quando `expiresAt > now + 60_000`; cache miss/expirado dispara
      exatamente uma troca; chamadas concorrentes para a mesma chave coalescem em uma única
      requisição; `forceRefresh` ignora o cache.
    - Classificação de erro para 401/403/429 (com e sem `Retry-After`)/5xx/timeout de rede.
    - Nenhuma mensagem de erro ou log contém `clientSecret` ou o valor do token.
    - `invalidateDatabricksAccessToken` remove todas as entradas da conexão, inclusive de
      diferentes `credentialVersion`.
    - **Validates: Property 3** (nenhum segredo em superfícies observáveis)
    - _Requirements: 5.2, 5.3, 6.2, 6.3, 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x] 2.4 Escrever teste de propriedade (fast-check) em `server/src/services/databricks-oauth.test.ts`
    - ∀ sequência de leituras de cache com `expiresAt`/`now` gerados aleatoriamente,
      `resolveDatabricksAccessToken` nunca retorna um token cujo `expiresAt` já tenha passado (ou
      esteja a menos de 60s no futuro) no momento do retorno.
    - **Property 4: Token nunca expirado é usado**
    - **Validates: Requirements 4.7**

- [x] 3. Serviço de conexão: resolução de credencial OAuth M2M e ciclo de vida
  - [x] 3.1 Atualizar `server/src/services/ai-connections.ts`
    - `resolveDatabricksCredential` passa a retornar `{ clientId, clientSecret, host, catalog,
      schema, modelPrefix, credentialVersion }` em vez de `{ token, ... }`; `credentialVersion` é o
      `latestVersion` do secret resolvido, nunca `undefined`.
    - `save()`: para `provider === "databricks"`, serializa `{ clientId, clientSecret }` (validado
      por `databricksOAuthCredentialSchema`) como o valor do secret em vez de um PAT bruto.
    - No fluxo de reconexão/rotação e de revogação (`revokeConnectionGrant`/rotate), incrementa
      `credentialVersion` para um valor nunca usado antes por essa conexão e chama
      `invalidateDatabricksModelServiceCache(id)` **e** `invalidateDatabricksAccessToken(id)`.
    - Toda resposta de API (criação, atualização, leitura individual, listagem) continua excluindo
      `clientSecret`.
    - _Requirements: 2.5, 5.1, 5.2, 6.1, 6.2, 6.4_
  - [x] 3.2 Escrever testes de integração em `server/src/__tests__/ai-connections.test.ts`
    - Isolamento multi-tenant: uma credencial/token/lista de combos resolvida para a organização A
      nunca é retornada para uma requisição da organização B, mesmo com `connectionId` inexistente
      (mensagem idêntica a "não encontrado").
    - Rotação/revogação: `credentialVersion` nunca se repete mesmo em sucessão rápida; uma troca de
      token com o `clientSecret` antigo é rejeitada com o mesmo erro de credencial inválida usado
      para 401; um token já emitido antes da rotação não é revogado remotamente.
    - **Validates: Property 2** (isolamento multi-tenant), **Property 7** (revogação bloqueia
      emissão futura, não retroage)
    - _Requirements: 2.5, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4_

- [x] 4. Serviço de descoberta: integração OAuth, chave de cache, paginação, normalização de rótulo
  - [x] 4.1 Atualizar `server/src/services/databricks-model-services.ts`
    - `DatabricksModelServiceCredential`: trocar `token` por `clientId`/`clientSecret`.
    - `DatabricksDiscoveryKey`: adicionar `credentialVersion: string`; `serializeKey` usa um
      marcador fixo e distinto de qualquer prefixo real (ex.: um símbolo reservado) quando
      `modelPrefix` estiver ausente, em vez de `null`.
    - `fetchPage`/`fetchAllPages`: antes de cada página, resolver o access token via
      `resolveDatabricksAccessToken` (de `databricks-oauth.ts`) e usá-lo no header `Authorization`.
    - `fetchAllPages`: limitar a 1000 iterações consecutivas com `next_page_token` presente; ao
      atingir o limite sem concluir a paginação, interromper e lançar `DatabricksDiscoveryError`
      com `kind: "unavailable"`.
    - `validateDatabricksCredential`: aceitar `clientId`/`clientSecret`, chamar
      `fetchDatabricksAccessToken` (sem cache, pois ainda não existe `connectionId`/`credentialVersion`
      nesse ponto) e então uma única página sem paginação/cache, como hoje.
    - `toAdapterModel`: reescrever a derivação do rótulo para exatamente o Critério 1.4 — a partir
      do nome curto (último segmento após `.`), substituir cada `-`/`_` por espaço e capitalizar
      apenas a primeira letra de cada palavra resultante, preservando a caixa das demais letras
      dessa palavra (remover a lógica atual de "stripar prefixo combo" e de lowercase do restante
      da palavra).
    - `matchesPrefix`: confirmar comparação sensível a maiúsculas/minúsculas (Critério 1.5) e a
      qualificação `catalog.schema` (Critério 1.6) permanecem sensíveis a caixa.
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 5.1, 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x] 4.2 Escrever testes unitários em `server/src/services/databricks-model-services.test.ts`
    - `toAdapterModel`: `"combo_ux"` → `"Combo Ux"`; `"comboUX"` (sem separador) preserva o
      restante da caixa (`"ComboUX"`, não `"Comboux"`); `"dev-team"` → `"Dev Team"`.
    - Filtro de prefixo é sensível a maiúsculas/minúsculas; qualificação `catalog.schema` exclui
      recursos fora do par configurado; `refresh: true` ignora o cache; ordenação e deduplicação
      por `id` mantendo a primeira ocorrência.
    - Paginação que excede 1000 páginas com `next_page_token` é classificada como `unavailable`.
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_
  - [x] 4.3 Escrever teste de propriedade (fast-check) em `server/src/services/databricks-model-services.test.ts`
    - ∀ sequência de páginas simuladas com `next_page_token` gerado aleatoriamente (inclusive
      sequências sem token final, respeitando o limite de 1000), `fetchAllPages`/a lista final
      retornada é exatamente a união de todas as páginas, sem duplicação por `id`.
    - **Property 5: Paginação completa e sem duplicação**
    - **Validates: Requirements 1.2, 1.7**
  - [x] 4.4 Escrever teste de propriedade (fast-check) em `server/src/services/databricks-model-services.test.ts`
    - ∀ par de `DatabricksDiscoveryKey` que diferem em pelo menos um campo (`companyId`,
      `connectionId`, `credentialVersion`, `host`, `catalog`, `schema`, `modelPrefix` incluindo o
      caso ausente-vs-presente), `serializeKey` nunca produz a mesma string para ambos.
    - **Property 2 (suporte): injetividade da chave de cache**
    - **Validates: Requirements 5.1**

- [x] 5. Validação de credencial OAuth M2M na camada de rotas
  - [x] 5.1 Atualizar `server/src/routes/ai-connections.ts`
    - Renomear/ajustar `validateDatabricksApiKey` para validar `clientId`/`clientSecret` reais via
      `validateDatabricksCredential` (agora client-credentials, não mais um `GET` com PAT).
    - Ajustar o corpo de entrada lido de `createAiConnectionSchema` (usar `input.clientId`/
      `input.clientSecret` em vez de `input.apiKey`) no branch `provider === "databricks"` de
      `save()`'s caller.
    - Manter `assertDatabricksHostAllowed` chamado antes de qualquer chamada de rede (inalterado).
    - _Requirements: 2.1, 2.2, 2.3, 2.7, 8.1, 8.2, 8.3, 8.4, 8.6_
  - [x] 5.2 Escrever testes de integração em `server/src/__tests__/ai-connections.test.ts`
    - Criação de conexão Databricks com `clientId`/`clientSecret` válidos sucede; com credencial
      inválida retorna erro mapeado de 401; com permissão insuficiente, de 403; com host fora do
      allowlist SaaS, retorna 422 sem nenhuma chamada de rede.
    - _Requirements: 2.1, 2.2, 2.3, 2.7, 8.1, 8.2, 8.6_

- [x] 6. Checkpoint — Garantir que os testes de servidor (contratos, token, conexão, descoberta,
  rotas) passem antes de seguir para o runtime de execução.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Runtime de execução: arquivo de credencial efêmero e dica de provider
  - [x] 7.1 Atualizar `server/src/services/ai-connection-runtime.ts`
    - Remover a injeção de `env.DATABRICKS_TOKEN` via `capability.envKey` (agora ausente para
      `databricks`); o branch genérico `env[capability.envKey] = value` passa a só executar quando
      `capability.envKey` existir.
    - Para `input.binding.provider === "databricks"`: fazer `JSON.parse` do valor do secret
      resolvido (`{ clientId, clientSecret }`), escrever um arquivo `databricks-credential.json`
      (modo `0o600`) dentro do home efêmero da execução com `{ host, clientId, clientSecret }`, e
      expor seu caminho em `env.DATABRICKS_CREDENTIAL_FILE`.
    - Construir `providerRuntimeHint` como `{ provider: "databricks", baseUrl, wireApi: "responses",
      authCommand, authArgs: [], authTimeoutMs: 5_000, authRefreshIntervalMs: 1_800_000 }`, com
      `authCommand` resolvido como caminho absoluto do binário publicado pelo pacote `codex-local`
      (tarefa 9.1) — nunca dependente de `PATH`.
    - Se a criação do arquivo de credencial ou a restrição de permissão falhar, abortar a
      preparação do runtime sem retornar um `config` utilizável (a execução não deve iniciar o
      processo Codex).
    - `cleanup()`: remover o arquivo de credencial e o home efêmero, exatamente como já ocorre para
      o restante do home (`rm(home, { recursive: true, force: true })` já cobre o arquivo, desde
      que ele viva dentro de `home`).
    - _Requirements: 2.5, 4.2, 4.8, 4.9, 5.4, 5.5, 5.6_
  - [x] 7.2 Escrever testes de integração em `server/src/__tests__/agent-hire-ai-connections.test.ts`
    - O arquivo de credencial é criado com permissão `0600` e removido após `cleanup()` (sucesso e
      falha da execução).
    - Duas execuções concorrentes (mesma organização ou organizações diferentes) recebem homes
      efêmeros distintos; uma não consegue ler o arquivo de credencial da outra.
    - Uma falha simulada ao criar/restringir o diretório efêmero aborta a preparação sem produzir
      um `config` utilizável.
    - Nenhum log, evento ou `config` retornado contém `clientSecret` ou o `access_token`.
    - **Validates: Property 2** (isolamento multi-tenant), **Property 3** (nenhum segredo em
      superfícies observáveis)
    - _Requirements: 4.8, 4.9, 5.4, 5.5, 5.6_

- [x] 8. Payload de provider do adapter `codex_local` (auth.command)
  - [x] 8.1 Atualizar `packages/adapters/codex-local/src/server/databricks-provider-runtime.ts`
    - Estender `DatabricksProviderRuntimeHint` com `authCommand: string`, `authArgs: string[]`,
      `authTimeoutMs: number`, `authRefreshIntervalMs: number` (mantendo `provider`/`baseUrl`/`wireApi`).
    - `isDatabricksProviderRuntimeHint`: validar também os novos campos.
    - `buildDatabricksProvidersPayload`: gerar `auth: { command, args, timeout_ms, refresh_interval_ms }`
      em vez de `env_key`; incluir `supports_websockets: false` sempre; manter `wire_api: "responses"`.
    - `checkDatabricksConnectivity` permanece com a mesma assinatura `(baseUrl, token)` — quem
      obtém `token` passa a ser o chamador (tarefa 10.2), via o helper, não mais via
      `env.DATABRICKS_TOKEN`.
    - _Requirements: 4.1, 4.2, 4.3, 4.8_
  - [x] 8.2 Atualizar/escrever testes em `packages/adapters/codex-local/src/server/databricks-provider-runtime.test.ts`
    - `buildDatabricksProvidersPayload` nunca inclui `env_key` nem um segredo literal; inclui
      `auth.command`/`args`/`timeout_ms`/`refresh_interval_ms`; `supports_websockets` é sempre
      `false`; `wire_api` é sempre `"responses"`.
    - O campo `model` do payload nunca é reescrito pelo Paperclip (verificação end-to-end com
      `prepareCodexRuntimeConfig`, reaproveitando o teste de integração já existente).
    - **Property 6: Somente o combo selecionado**
    - **Validates: Requirements 4.1, 4.2, 4.3**

- [x] 9. Helper binário `auth.command` (OAuth M2M standalone)
  - [x] 9.1 Implementar `packages/adapters/codex-local/src/server/databricks-oauth-token-cli.ts`
    - Lê `DATABRICKS_CREDENTIAL_FILE` do ambiente, parseia o JSON `{ host, clientId, clientSecret }`.
    - Troca client credentials por um access token via `POST {host}/oidc/v1/token`, com timeout
      (`AbortSignal.timeout`), reimplementando localmente a chamada HTTP (este pacote não pode
      depender de `server/src/*` — mesma restrição de fronteira já documentada para
      `checkDatabricksConnectivity`).
    - Em sucesso: escreve exclusivamente o `access_token` em `stdout`, sem quebra de linha ou
      qualquer outro caractere antes/depois.
    - Em falha (arquivo ausente/malformado, HTTP não-2xx, timeout): escreve em `stderr` uma
      mensagem sanitizada que nunca inclui `clientSecret`, o token, ou o corpo da resposta;
      finaliza com código de saída diferente de zero.
    - Nunca aceita `clientSecret` via argumento de linha de comando.
    - Adicionar a entrada `"bin": { "paperclip-databricks-oauth-token":
      "./dist/server/databricks-oauth-token-cli.js" }` em `packages/adapters/codex-local/package.json`
      (nos dois blocos, raiz e `publishConfig`, seguindo o padrão de `paperclip-mcp-server`).
    - _Requirements: 4.4, 4.5, 4.6, 4.8_
  - [x] 9.2 Escrever testes unitários em `packages/adapters/codex-local/src/server/databricks-oauth-token-cli.test.ts`
    - Extrai `access_token` de uma resposta JSON válida e imprime somente esse valor em `stdout`.
    - Rejeita um arquivo de credencial ausente/malformado ou uma resposta HTTP de erro com
      `stderr` sanitizado (sem `clientSecret`/corpo da resposta) e código de saída não-zero.
    - Nunca inclui `clientSecret` em `argv` do processo filho (o teste inspeciona a chamada de
      `fetch`/comando, não apenas a saída).
    - **Validates: Property 3** (nenhum segredo em superfícies observáveis)
    - _Requirements: 4.5, 4.6, 4.8_

- [x] 10. Readiness, auth-check e probe de conectividade
  - [x] 10.1 Atualizar `packages/adapters/codex-local/src/server/codex-home.ts` e `execute.ts`
    - `evaluateCodexCredentialReadiness`: no branch `activeProvider === "databricks"`, trocar o
      critério de prontidão de "`configuredDatabricksToken` não vazio" para "o helper
      (`providerRuntimeHint.authCommand`) está configurado e `DATABRICKS_CREDENTIAL_FILE` aponta
      para um arquivo existente e legível" — nunca inspeciona `clientSecret` diretamente.
    - `execute.ts`: remover a leitura de `envConfig.DATABRICKS_TOKEN` como sinal de prontidão;
      passar o novo indicador de prontidão (presença do arquivo de credencial) para
      `assertCodexCredentialsLaunchable`/`evaluateCodexCredentialReadiness` no lugar de
      `configuredDatabricksToken`.
    - `resolveCodexBillingType`/`resolveCodexBiller`: continuam classificando um run Databricks-ativo
      como `billingType: "api"` / `biller: "databricks"`, agora com base em `providerRuntimeHint`
      em vez de um `DATABRICKS_TOKEN` configurado.
    - _Requirements: 3.1, 4.9, 9.1, 9.2_
  - [x] 10.2 Atualizar `packages/adapters/codex-local/src/server/test.ts`
    - No branch de conectividade Databricks: em vez de ler `env.DATABRICKS_TOKEN`, invocar o helper
      (`databricksHint.authCommand`/`authArgs`, com `DATABRICKS_CREDENTIAL_FILE` no ambiente) como
      um subprocesso de vida curta, capturar seu `stdout` como o access token, e então chamar
      `checkDatabricksConnectivity(databricksHint.baseUrl, token)` como hoje.
    - Se o helper falhar (código de saída não-zero) ou não estiver configurado, emitir um check de
      nível `error`/`warn` apropriado (equivalente ao atual `databricks_connectivity_token_missing`)
      sem tentar a chamada HTTP de conectividade.
    - _Requirements: 4.5, 4.6, 8.1, 8.2, 8.3, 8.4_
  - [x] 10.3 Atualizar testes existentes
    - `packages/adapters/codex-local/src/server/codex-home.test.ts`: prontidão Databricks baseada
      no helper/arquivo de credencial, não em `DATABRICKS_TOKEN`.
    - `packages/adapters/codex-local/src/server/execute.auth-precedence.test.ts` e
      `execute.databricks-billing.test.ts`: `billingType`/`biller` seguem `"api"`/`"databricks"`
      com o novo indicador de prontidão.
    - `packages/adapters/codex-local/src/server/test.test.ts`: o probe de conectividade Databricks
      invoca o helper simulado e nunca lê `env.DATABRICKS_TOKEN`.
    - **Validates: Property 1** (nenhum fallback silencioso), **Property 8** (sem token estático de
      longa duração)
    - _Requirements: 3.1, 4.9_

- [x] 11. Checkpoint — Garantir que os testes do adapter `codex_local` (payload, helper, readiness,
  probe) passem antes de seguir para a interface.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Interface: passo de conexão Databricks dedicado e seletor de combo
  - [x] 12.1 Atualizar `ui/src/components/ai-connections/AiConnectionCredentialStep.tsx`
    - Adicionar um passo dedicado para `provider === "databricks"` (em vez de cair em
      `SubscriptionConnectionStep`, genérico demais para um provider `api_key`/`oauth_m2m`): campos
      Workspace URL, Client ID, Client secret, Catalog, Schema, Prefixo (opcional), e o seletor de
      Compartilhamento (`personal`/`shared`) já usado pelos demais passos.
    - Envia `provider: "databricks"`, `method: "oauth_m2m"`, `clientId`, `clientSecret`,
      `workspaceHost`, `catalog`, `schema`, `modelPrefix` para `aiConnectionsApi.create`.
    - Nunca ecoa `clientSecret` de volta na UI após o envio (limpa o campo do formulário no
      `onSettled`, mesmo padrão de `ApiKeyConnectionStep`).
    - _Requirements: 2.1, 2.2, 2.5, 2.6_
  - [x] 12.2 Escrever testes de componente para o novo passo (novo arquivo
    `ui/src/components/ai-connections/AiConnectionCredentialStep.test.tsx`, ou extensão do
    `AiConnectionAuth.test.tsx` existente)
    - Bloqueia o envio até que Workspace URL/Client ID/Client secret/Catalog/Schema estejam
      preenchidos; exibe o erro do servidor quando a criação falha; nunca renderiza o valor de
      `clientSecret` de volta após um envio bem-sucedido ou com falha.
    - _Requirements: 2.2, 2.5_
  - [x] 12.3 Revisar `ui/src/components/AgentConfigForm.tsx`
    - Confirmar que o seletor de combo continua funcionando com o novo formato de conexão: rótulo
      "Combo" quando `modelProvider === "databricks"`; requer uma conexão Databricks não revogada e
      autorizada antes de exibir o seletor; oculta o seletor e mostra uma indicação quando não há
      conexão elegível; preserva a seleção atual e mostra uma indicação de erro quando a listagem
      falhar; mostra "Indisponível" para um combo salvo ausente na descoberta atual; mostra uma
      indicação quando a lista retornar vazia.
    - Ajustar qualquer referência residual ao formato antigo de credencial Databricks (nenhuma
      esperada no cliente, já que o token nunca chegou à UI, mas confirmar o `databricksConnectionId`
      e o botão de refresh continuam compatíveis com o novo contrato de erro do endpoint).
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_
  - [x] 12.4 Escrever/estender testes de componente para o seletor de combo em `AgentConfigForm`
    - Sem conexão Databricks elegível: seletor de combo oculto com indicação apropriada.
    - Falha na listagem (rede ou erro classificado): indicação de erro exibida, combo previamente
      selecionado preservado sem alteração.
    - Lista vazia: indicação de "nenhum combo encontrado".
    - Combo salvo ausente na lista atual: exibido como "Indisponível", início de execução bloqueado.
    - _Requirements: 7.5, 7.7, 7.8, 7.9_

- [x] 13. Compatibilidade com conexões existentes e documentação
  - [x] 13.1 Tratar conexões Databricks legadas (`method: "api_key"`) em `server/src/services/ai-connections.ts`
    - `resolveDatabricksCredential`: se a conexão armazenada tiver `metadata.data.method !== "oauth_m2m"`
      (uma conexão criada antes desta migração), retornar uma falha classificada explícita (reaproveitando
      `reason: "connection_unavailable"`, com mensagem indicando que a conexão precisa ser reconectada
      com Client ID/Client secret) em vez de tentar interpretar o secret armazenado como um par
      OAuth ou deixar uma exceção não tratada escapar.
    - Não migrar automaticamente o secret armazenado (um PAT) para o novo formato — a reconexão
      pelo usuário, através do novo passo de UI (tarefa 12.1), é o único caminho suportado.
    - _Requirements: 2.1_
  - [x] 13.2 Escrever teste unitário em `server/src/__tests__/ai-connections.test.ts`
    - Uma conexão Databricks pré-existente com `method: "api_key"` faz `resolveDatabricksCredential`
      retornar a falha classificada de reconexão necessária, sem lançar uma exceção não tratada e
      sem tentar trocar o PAT armazenado por um access token OAuth.
    - _Requirements: 2.1_
  - [x] 13.3 Atualizar documentação
    - `docs/adapters/codex-local.md`: substituir a seção "Databricks Unity Gateway (Combos)" para
      descrever `method: "oauth_m2m"` (Client ID/Client secret em vez de PAT), o helper
      `auth.command`/renovação por `refresh_interval_ms`, e a ausência de qualquer
      `DATABRICKS_TOKEN` no ambiente do processo Codex.
    - `docs/deploy/environment-variables.md`: confirmar que `PAPERCLIP_DATABRICKS_HOST_ALLOWLIST` e
      `PAPERCLIP_DATABRICKS_ALLOW_PRIVATE_HOSTS` permanecem corretos (nenhuma variável de ambiente
      nova é necessária para o helper, que recebe a credencial por arquivo efêmero, não por env);
      adicionar uma nota removendo qualquer expectativa de `DATABRICKS_TOKEN` de longa duração, se
      mencionada em outro ponto da documentação de deploy.
    - _Requirements: 4.9_

- [x] 14. Checkpoint final — Garantir que toda a suíte (contratos, servidor, adapter, UI,
  compatibilidade) passe.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tarefas marcadas com `*` são de teste e podem ser puladas para um MVP mais rápido; o modelo de
  execução de tarefas não deve implementá-las.
- Toda referência a `_Requirements: X.Y_` aponta para os critérios de aceitação numerados em
  `requirements.md`; toda referência a "Property N" aponta para as Correctness Properties do
  `design.md`.
- `fast-check` (tarefa 2.1) é adicionado como devDependency fixa (`4.10.2`) porque o repositório
  ainda não o utiliza em nenhum pacote — apesar do `design.md` descrevê-lo como "já disponível no
  monorepo", uma busca no repositório não encontrou nenhuma ocorrência prévia.
- A tarefa 13.1 assume que nenhuma migração automática de PAT→OAuth é desejada nesta revisão; se o
  usuário preferir uma migração assistida (ex.: um banner de "reconectar" específico na UI para
  conexões legadas), isso é um requisito adicional fora do escopo atual de `requirements.md`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "2.1", "2.2", "8.1", "9.1"] },
    { "id": 1, "tasks": ["1.2", "2.3", "3.1", "4.1", "8.2", "9.2"] },
    { "id": 2, "tasks": ["2.4", "3.2", "4.2", "5.1", "7.1", "12.1", "12.3"] },
    { "id": 3, "tasks": ["4.3", "5.2", "7.2", "10.1", "10.2", "12.2", "12.4", "13.1"] },
    { "id": 4, "tasks": ["4.4", "10.3", "13.2", "13.3"] }
  ]
}
```
