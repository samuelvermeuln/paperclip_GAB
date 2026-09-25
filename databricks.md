# EspecificaÃ§Ã£o â€” Paperclip + Databricks Unity Gateway com combos dinÃ¢micos

**Status:** pronto para implementaÃ§Ã£o  
**RevisÃ£o de autenticaÃ§Ã£o:** 24/09/2026  
**Objetivo:** quando um novo combo (Model Service) for criado no Databricks, ele deve aparecer no Paperclip para seleÃ§Ã£o, sem cadastro duplicado e sem alteraÃ§Ã£o manual de cÃ³digo.

## 1. Resultado esperado

O Paperclip continuarÃ¡ usando o `codex_local` como executor. O Databricks serÃ¡ um provedor nativo de modelos dentro desse adapter.

Fluxo final:

```mermaid
flowchart TD
    A["Criar combo no Databricks"] --> B["Unity Gateway Model Service"]
    B --> C["Paperclip consulta os Model Services"]
    C --> D["Combo aparece no seletor do agente"]
    D --> E["Paperclip salva o ID do combo"]
    E --> F["Codex executa pelo Unity Gateway"]
    F --> G["Databricks escolhe o modelo e fallback"]
```

Exemplo:

1. Ã‰ criado `main.paperclip.combo_ux` no Databricks.
2. O usuÃ¡rio abre ou atualiza o campo **Combo** no Paperclip.
3. O Paperclip mostra **Combo UX**.
4. O agente salva `main.paperclip.combo_ux` como modelo.
5. A execuÃ§Ã£o usa `https://<workspace>/ai-gateway/codex/v1` com `wire_api = "responses"`.

## 2. DecisÃµes de arquitetura

### 2.1 NÃ£o criar outro executor

NÃ£o criar um adapter que replique toda a execuÃ§Ã£o do Codex. O adapter continua sendo:

```text
adapterType = codex_local
modelProvider = databricks
model = main.paperclip.combo_ux
```

O suporte ao Databricks deve ser implementado como uma integraÃ§Ã£o de provedor de primeira classe dentro do fluxo do `codex_local`.

### 2.2 Fonte Ãºnica dos combos

A lista oficial vem do Unity Gateway:

```http
GET /api/2.1/unity-catalog/model-services
    ?parent=schemas/main.paperclip
    &page_size=100
    &view=BASIC
```

O endpoint correto para descoberta Ã© **Model Services do Unity Catalog**. NÃ£o usar `GET /api/2.0/serving-endpoints`, pois Serving Endpoints Ã© outro recurso.

### 2.3 Identificador salvo

A API de descoberta retorna o nome no formato:

```text
model-services/main.paperclip.combo_ux
```

O Paperclip deve remover somente o prefixo `model-services/` e salvar:

```text
main.paperclip.combo_ux
```

Esse Ã© o valor enviado ao Codex/Databricks como `model`.

### 2.4 Sem fallback silencioso para OpenAI

Se o Databricks estiver indisponÃ­vel, sem quota ou sem acesso ao combo, a execuÃ§Ã£o deve falhar ou aguardar conforme a polÃ­tica do Paperclip. Nunca desviar silenciosamente para a OpenAI, pois isso quebra o controle de custo e governanÃ§a.

## 3. ConfiguraÃ§Ã£o funcional

Adicionar ao Paperclip uma conexÃ£o de IA do tipo `databricks` com:

| Campo | Tipo | Regra |
| --- | --- | --- |
| Nome | texto | Ex.: `Databricks ProduÃ§Ã£o` |
| Workspace URL | URL | Somente HTTPS; salvar apenas a origem |
| Client ID | texto | Application ID do service principal atribuÃ­do ao workspace |
| Client secret | segredo | Segredo OAuth do service principal; nunca retornar ao cliente |
| Catalog | texto | Ex.: `main` |
| Schema | texto | Ex.: `paperclip` |
| Filtro opcional | texto | Ex.: prefixo `combo_`; vazio lista todos os serviÃ§os acessÃ­veis |
| Compartilhamento | enum | pessoal ou organizaÃ§Ã£o, conforme o modelo atual de AI Connections |

VariÃ¡veis internas de execuÃ§Ã£o (somente no processo de autenticaÃ§Ã£o com escopo da organizaÃ§Ã£o):

```text
DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
DATABRICKS_CLIENT_ID=<application-id>
DATABRICKS_CLIENT_SECRET=<segredo OAuth>
```

NÃ£o persistir o client secret nem tokens de acesso no `adapterConfig`, `config.toml`, eventos, logs ou resposta da API. NÃ£o usar `DATABRICKS_TOKEN` fixo: ele expira e pode fazer tarefas longas falharem. A conexÃ£o do Paperclip armazena o secret cifrado no mecanismo de AI Connections, ligado a uma organizaÃ§Ã£o e a um grant.

### 3.1 PreparaÃ§Ã£o no Databricks

1. Criar um service principal para a organizaÃ§Ã£o (idealmente um por organizaÃ§Ã£o para que permissÃµes e limites sejam atribuÃ­dos separadamente) e atribuÃ­-lo ao workspace de destino.
2. Criar um OAuth secret desse principal e copiar uma vez o **Client ID** (Application ID) e o **Client secret**. Configurar validade e rotaÃ§Ã£o do secret. O secret de longa duraÃ§Ã£o Ã© distinto do access token OAuth de cerca de uma hora.
3. Conceder `USE_CATALOG` e `USE_SCHEMA` no catÃ¡logo e schema configurados, mais `EXECUTE` somente nos Model Services/combo autorizados. `READ_METADATA` permite descoberta, mas nÃ£o execuÃ§Ã£o.
4. Configurar os limites do Model Service para esse service principal conforme a governanÃ§a da organizaÃ§Ã£o. Se o mesmo principal for compartilhado por vÃ¡rias organizaÃ§Ãµes, o Databricks verÃ¡ uma Ãºnica identidade; evitar isso quando limites/telemetria precisarem ser separados.
5. Validar por conexÃ£o com o prÃ³prio principal: obter token OAuth M2M, listar os serviÃ§os autorizados e executar um combo de teste. Para scopes restritos, confirmar tanto a descoberta (`unity-catalog`) quanto as chamadas de inferÃªncia exigidas pela implantaÃ§Ã£o; nÃ£o presumir que apenas `unity-catalog` habilita o endpoint de inferÃªncia.

Para gerar um token manual de diagnÃ³stico, sem salvar seu valor:

```http
POST https://<workspace>/oidc/v1/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&scope=all-apis
```

`all-apis` Ã© apenas o exemplo de diagnÃ³stico da documentaÃ§Ã£o Databricks; restringir os scopes do secret/token apÃ³s confirmar os necessÃ¡rios para descoberta e inferÃªncia. Em produÃ§Ã£o, usar autenticaÃ§Ã£o unificada do Databricks para solicitar e renovar tokens automaticamente.

## 4. Contratos do Paperclip

### 4.1 ConfiguraÃ§Ã£o persistida no agente

```json
{
  "adapterType": "codex_local",
  "adapterConfig": {
    "modelProvider": "databricks",
    "model": "main.paperclip.combo_ux"
  },
  "runtimeConfig": {
    "aiConnection": {
      "provider": "databricks",
      "method": "oauth_m2m",
      "mode": "shared",
      "connectionId": "<uuid>",
      "grantId": "<uuid>"
    }
  }
}
```

### 4.2 Descoberta dos modelos

O contrato atual de `listModels()` nÃ£o recebe contexto de organizaÃ§Ã£o nem credencial. Ele deve ser ampliado de modo retrocompatÃ­vel:

```ts
interface AdapterModelDiscoveryContext {
  companyId: string;
  provider?: string;
  connectionId?: string;
  refresh?: boolean;
  resolvedCredential?: {
    host: string;
    clientId: string;
    clientSecret: string;
    catalog: string;
    schema: string;
    modelPrefix?: string;
  };
}

listModels?: (
  context?: AdapterModelDiscoveryContext,
) => Promise<AdapterModel[]>;

refreshModels?: (
  context?: AdapterModelDiscoveryContext,
) => Promise<AdapterModel[]>;
```

As implementaÃ§Ãµes existentes podem ignorar o parÃ¢metro.

O endpoint atual permanece:

```http
GET /api/companies/:companyId/adapters/codex_local/models
    ?provider=databricks
    &connectionId=<uuid>
    &refresh=1
```

O servidor deve:

1. validar o acesso do usuÃ¡rio Ã  organizaÃ§Ã£o;
2. localizar a conexÃ£o dentro da mesma organizaÃ§Ã£o;
3. validar o grant pessoal/compartilhado;
4. resolver client ID e secret somente no servidor;
5. obter ou reutilizar token OAuth M2M vÃ¡lido, renovando antes de expirar; chamar a descoberta do Databricks;
6. devolver apenas `id` e `label`.

Resposta ao navegador:

```json
[
  {
    "id": "main.paperclip.combo_ux",
    "label": "Combo UX"
  },
  {
    "id": "main.paperclip.combo_dev",
    "label": "Combo Dev"
  }
]
```

### 4.3 PaginaÃ§Ã£o obrigatÃ³ria

O Databricks retorna no mÃ¡ximo 100 itens por pÃ¡gina. Continuar consultando enquanto existir `next_page_token`:

```ts
do {
  const response = await listModelServices({
    parent: `schemas/${catalog}.${schema}`,
    page_size: 100,
    page_token: nextPageToken,
    view: "BASIC",
  });

  services.push(...response.model_services);
  nextPageToken = response.next_page_token;
} while (nextPageToken);
```

### 4.4 NormalizaÃ§Ã£o

Para cada serviÃ§o:

```ts
function toAdapterModel(resourceName: string): AdapterModel {
  const id = resourceName.replace(/^model-services\//, "");
  const shortName = id.split(".").at(-1) ?? id;

  return {
    id,
    label: shortName
      .replace(/^combo[-_]?/i, "Combo ")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim(),
  };
}
```

Ordenar pelo `label`. Remover duplicados pelo `id`. NÃ£o aceitar nomes fora do `catalog.schema` configurado.

## 5. ExecuÃ§Ã£o pelo Unity Gateway com OAuth M2M

O Paperclip deve configurar o `codex_local` por execuÃ§Ã£o com o combo selecionado, sem segredo no TOML. A versÃ£o instalada do Codex deve suportar `[model_providers.<id>.auth]` e o gateway `/ai-gateway/codex/v1`; verificar esse suporte na implementaÃ§Ã£o.

```toml
model = "main.paperclip.combo_ux"
model_provider = "databricks"

[model_providers.databricks]
name = "Databricks Unity Gateway"
base_url = "https://<workspace>.cloud.databricks.com/ai-gateway/codex/v1"
wire_api = "responses"
supports_websockets = false

[model_providers.databricks.auth]
command = "/opt/paperclip/bin/databricks-oauth-token"
args = []
timeout_ms = 5000
refresh_interval_ms = 1800000
```

O caminho acima representa o helper a instalar no servidor Paperclip. Ele deve realizar OAuth M2M em `POST https://<workspace>/oidc/v1/token` com `grant_type=client_credentials` e as credenciais do service principal, extrair `access_token` com parser JSON, imprimir **somente o valor do token** em stdout e emitir erro sanitizado em stderr. Pode usar um SDK Databricks que exponha o token M2M Ã  integraÃ§Ã£o, desde que isso seja confirmado na implementaÃ§Ã£o. **NÃ£o usar `databricks auth token`: esse comando da CLI suporta somente OAuth de usuÃ¡rio (U2M), nÃ£o client ID e secret M2M.** O TOML efetivo deve apontar `command` para o caminho absoluto desse helper e usar argumentos fixos sem segredos; nunca usar shell com interpolaÃ§Ã£o de host ou credenciais. Validar antes que a versÃ£o do Codex aceita o comando de autenticaÃ§Ã£o, a renovaÃ§Ã£o e `supports_websockets = false`.

O helper recebe somente o contexto da conexÃ£o selecionada para aquela execuÃ§Ã£o. O runtime resolve o `clientId`/`clientSecret` da mesma organizaÃ§Ã£o, fornece as credenciais ao helper em canal protegido e garante que uma execuÃ§Ã£o de outra organizaÃ§Ã£o nÃ£o consiga invocÃ¡-lo ou ler essas credenciais. Um processo Codex capaz de executar comandos no mesmo ambiente pode alcanÃ§ar segredos herdados; por isso, o isolamento do processo por organizaÃ§Ã£o/execuÃ§Ã£o e a separaÃ§Ã£o entre processo de autenticaÃ§Ã£o e ferramentas do agente sÃ£o requisitos para multi-tenant. Se o adapter atual nÃ£o oferece essa separaÃ§Ã£o, implementÃ¡-la antes de habilitar o conector para mÃºltiplas organizaÃ§Ãµes.

Fluxo do helper:

1. No inÃ­cio e aproximadamente a cada 30 minutos, obter um novo access token por OAuth M2M do workspace correspondente; usar as credenciais e o host da conexÃ£o selecionada, nunca as do ambiente global.
2. Entregar o token apenas ao Codex em memÃ³ria/stdout do comando de autenticaÃ§Ã£o. NÃ£o expor o secret ou o token em parÃ¢metros de processo, TOML, logs, eventos, prompt ou browser.
3. Em falha de renovaÃ§Ã£o, retornar erro autenticÃ¡vel/sanitizado e bloquear a chamada. Nunca usar identidade de outra conexÃ£o ou OpenAI como fallback.
4. Na revogaÃ§Ã£o/rotaÃ§Ã£o do secret, invalidar qualquer token em cache do Paperclip e impedir novas execuÃ§Ãµes com essa conexÃ£o. Tokens OAuth jÃ¡ emitidos podem permanecer vÃ¡lidos atÃ© expirar no Databricks; interromper execuÃ§Ãµes em andamento quando a revogaÃ§Ã£o da conexÃ£o exigir bloqueio imediato. Preservar e limpar a configuraÃ§Ã£o de execuÃ§Ã£o conforme o ciclo de vida do adapter.

O mecanismo `PAPERCLIP_CODEX_PROVIDERS` pode continuar gerando a configuraÃ§Ã£o do provider, mas precisa aceitar `auth.command` com renovaÃ§Ã£o. Em Databricks, a prontidÃ£o do `codex_local` deve verificar a conexÃ£o M2M, a disponibilidade do helper e o acesso ao combo; nÃ£o exigir `OPENAI_API_KEY` ou `DATABRICKS_TOKEN` estÃ¡tico. O teste de conectividade nÃ£o deve disparar tarefa longa. A autenticaÃ§Ã£o com client credentials acontece nos bastidores e permanece invisÃ­vel para quem seleciona o combo.

## 6. Interface

Na configuraÃ§Ã£o do agente Codex:

```text
Provedor de modelo
â””â”€â”€ OpenAI
â””â”€â”€ Databricks Unity Gateway

ConexÃ£o Databricks
â””â”€â”€ Databricks ProduÃ§Ã£o

Combo
â””â”€â”€ Combo EconÃ´mico
â””â”€â”€ Combo Dev
â””â”€â”€ Combo Review
â””â”€â”€ Combo UX
```

Regras:

- Ao escolher Databricks, exigir uma conexÃ£o vÃ¡lida antes de listar combos.
- Buscar a lista ao abrir o seletor.
- Manter botÃ£o **Atualizar combos** usando `refresh=1`.
- Cache normal de no mÃ¡ximo 60 segundos.
- O refresh manual ignora o cache.
- Se o combo salvo tiver sido removido, mantÃª-lo visÃ­vel como `IndisponÃ­vel` e bloquear nova execuÃ§Ã£o atÃ© a seleÃ§Ã£o ser corrigida.
- NÃ£o misturar modelos OpenAI com combos Databricks na mesma lista.
- Trocar o rÃ³tulo `Model` por `Combo` quando `modelProvider = databricks`.

## 7. Cache e isolamento multi-tenant

Chave do cache:

```text
companyId + connectionId + credentialVersion + databricksHost + catalog + schema + modelPrefix
```

Nunca usar apenas `provider=databricks` como chave. Isso poderia exibir combos de uma organizaÃ§Ã£o para outra.

Regras adicionais:

- TTL: 60 segundos.
- NÃ£o persistir respostas de descoberta no banco no MVP.
- NÃ£o compartilhar cache entre organizaÃ§Ãµes, conexÃµes ou versÃµes de credencial diferentes.
- Invalidar ao editar, rotacionar ou revogar a conexÃ£o.
- Retornar somente serviÃ§os que o service principal daquela conexÃ£o pode acessar.

## 8. SeguranÃ§a

- Armazenar somente o OAuth client secret no sistema de segredos/AI Connections usado pelo Paperclip; manter access tokens efÃªmeros em memÃ³ria e em cache associado Ã  conexÃ£o/versÃ£o.
- Nunca enviar client secret nem access token ao navegador.
- Nunca incluir client secret ou token em URL, argumento de processo, TOML, log, erro, evento, prompt ou telemetria.
- NÃ£o repassar credenciais do service principal Ã s ferramentas executadas pelo agente; isolar processos e arquivos por organizaÃ§Ã£o/execuÃ§Ã£o.
- Aceitar somente `https://` para o workspace.
- Normalizar a URL para `origin`; rejeitar `userinfo`, query string e fragmento.
- Adotar allowlist de host para ambientes SaaS. Hosts privados devem ser habilitados explicitamente pelo administrador.
- Aplicar timeout de 10 segundos e limite de resposta na descoberta.
- Tratar `401` como credencial invÃ¡lida, `403` como permissÃ£o insuficiente, `429` como limite/quota e `5xx` como indisponibilidade temporÃ¡ria.
- Respeitar `Retry-After` quando existir.
- NÃ£o realizar fallback para credencial global de outra organizaÃ§Ã£o.

PermissÃµes mÃ­nimas recomendadas no Databricks:

- `USE_CATALOG` no catÃ¡logo;
- `USE_SCHEMA` no schema;
- `EXECUTE` nos Model Services que devem aparecer e ser executados. `READ_METADATA` isolado serve para descoberta, mas produziria um combo que nÃ£o executa.
- Workspace atribuÃ­do ao principal; OAuth secret com scopes suficientes para listar e inferir.

## 9. Economia e contabilizaÃ§Ã£o de tokens

O Paperclip deve registrar:

```text
provider = databricks
model = main.paperclip.combo_ux
inputTokens
outputTokens
cachedTokens, quando informado
latÃªncia
status HTTP
```

O modelo real escolhido dentro do combo pertence ao Databricks. NÃ£o inventar esse valor no Paperclip. SÃ³ registrar o destino real se o Databricks o devolver de forma confiÃ¡vel em metadados da resposta ou telemetria.

Para reduzir consumo:

- evitar chamada de LLM durante a descoberta;
- usar apenas a API REST de Model Services;
- manter cache curto de 60 segundos;
- nÃ£o carregar descriÃ§Ã£o completa, destinos ou regras com `view=FULL` no seletor;
- usar `view=BASIC`;
- nÃ£o enviar a lista de combos no prompt do agente.

## 10. Arquivos previstos no repositÃ³rio Paperclip

### Compartilhado

- `packages/shared/src/ai-connections.ts`
  - adicionar provider `databricks`;
  - adicionar mÃ©todo `oauth_m2m` para Databricks;
  - mapear para `codex_local` e credenciais M2M do service principal.
- `packages/adapter-utils/src/types.ts`
  - adicionar `AdapterModelDiscoveryContext`;
  - tornar `listModels` e `refreshModels` contextuais e retrocompatÃ­veis.

### Servidor

- `server/src/adapters/registry.ts`
  - encaminhar o contexto para `listModels`/`refreshModels`.
- `server/src/routes/agents.ts`
  - aceitar `provider=databricks` e `connectionId`;
  - resolver e autorizar a conexÃ£o antes da descoberta.
- `server/src/services/ai-connections.ts`
  - resolver client ID e secret com escopo de organizaÃ§Ã£o/grant, incluindo versÃ£o e revogaÃ§Ã£o.
- `server/src/services/ai-connection-runtime.ts`
  - preparar autenticaÃ§Ã£o M2M por execuÃ§Ã£o e configuraÃ§Ã£o do provider sem token fixo.
- novo `server/src/services/databricks-model-services.ts`
  - cliente REST, paginaÃ§Ã£o, cache, normalizaÃ§Ã£o e mapeamento de erros; usar cliente OAuth M2M com renovaÃ§Ã£o.
- `server/src/adapters/codex-models.ts`
  - combinar apenas a fonte correspondente ao provider selecionado.

### Adapter Codex

- `packages/adapters/codex-local/src/server/runtime-config.ts`
  - gerar provider Databricks por execuÃ§Ã£o com `auth.command` e `supports_websockets = false`.
- `packages/adapters/codex-local/src/server/auth-check.ts` e caminhos de readiness
  - verificar M2M/helper e nÃ£o exigir chave OpenAI quando Databricks estiver ativo.
- `packages/adapters/codex-local/src/server/test.ts`
  - teste de conectividade usando o combo selecionado sem consumir uma tarefa real extensa.

### Interface

- `ui/src/components/AgentConfigForm.tsx`
  - provedor, conexÃ£o e seletor de combo;
  - busca ao abrir e refresh manual.
- `ui/src/api/agents.ts`
  - enviar provider e connectionId na descoberta.
- `ui/src/adapters/codex-local/`
  - campos e labels especÃ­ficos do Databricks.

### DocumentaÃ§Ã£o

- `docs/adapters/codex-local.md`
  - configuraÃ§Ã£o e diagnÃ³stico.
- `docs/deploy/environment-variables.md`
  - variÃ¡veis apenas para modo single-tenant/administrado, se esse fallback for mantido.

## 11. Ordem de implementaÃ§Ã£o

- [ ] **T01 â€” Contratos compartilhados:** adicionar `databricks` Ã s AI Connections e criar o contexto de descoberta.
- [ ] **T02 â€” Cliente Databricks:** implementar listagem paginada, normalizaÃ§Ã£o, timeout e erros.
- [ ] **T03 â€” SeguranÃ§a:** resolver client ID/secret por organizaÃ§Ã£o, validar grants e implementar isolamento dos processos e ferramentas.
- [ ] **T04 â€” Registro de modelos:** passar contexto por `listAdapterModels` e `refreshAdapterModels`.
- [ ] **T05 â€” Runtime:** gerar provider Codex com `base_url`, `wire_api`, `supports_websockets = false` e `auth.command` sem segredos.
- [ ] **T06 â€” AutenticaÃ§Ã£o:** criar helper OAuth M2M com renovaÃ§Ã£o e parser de token; remover dependÃªncia obrigatÃ³ria de `OPENAI_API_KEY` quando Databricks estiver ativo.
- [ ] **T07 â€” API:** ampliar o endpoint de modelos com provider/conexÃ£o e cache de 60 segundos.
- [ ] **T08 â€” UI:** adicionar seleÃ§Ã£o de provedor, conexÃ£o e combo com refresh.
- [ ] **T09 â€” Observabilidade:** registrar provider, combo, tokens, latÃªncia e erros sem segredos.
- [ ] **T10 â€” Testes unitÃ¡rios e de integraÃ§Ã£o:** cobrir paginaÃ§Ã£o, cache, autorizaÃ§Ã£o, runtime, renovaÃ§Ã£o OAuth e erros.
- [ ] **T11 â€” Teste E2E:** criar `combo_ux` no Databricks e confirmar aparecimento/execuÃ§Ã£o no Paperclip.
- [ ] **T12 â€” RevisÃ£o final:** verificar que todo o escopo e critÃ©rios de aceite foram atendidos.

## 12. Testes obrigatÃ³rios

### UnitÃ¡rios

- remove apenas o prefixo `model-services/`;
- transforma `combo_ux` em `Combo UX`;
- pagina atÃ© `next_page_token` desaparecer;
- ordena e remove duplicados;
- respeita prefixo opcional;
- nÃ£o devolve serviÃ§os de outro schema;
- `refresh=1` ignora cache;
- `401`, `403`, `429`, timeout e `5xx` sÃ£o classificados corretamente;
- logs e erros nÃ£o contÃªm client secret nem access token;
- o helper extrai `access_token`, imprime sÃ³ o token e rejeita resposta JSON malformada;
- a renovaÃ§Ã£o antecede a expiraÃ§Ã£o e falhas nÃ£o trocam de conexÃ£o.

### IntegraÃ§Ã£o

- organizaÃ§Ã£o A nÃ£o enxerga combos da conexÃ£o da organizaÃ§Ã£o B;
- usuÃ¡rio sem acesso ao grant recebe `403`;
- conexÃ£o revogada nÃ£o pode listar nem executar;
- novo combo aparece apÃ³s refresh sem reiniciar o Paperclip;
- combo removido nÃ£o provoca fallback para OpenAI;
- o provider temporÃ¡rio contÃ©m `/ai-gateway/codex/v1`, `wire_api=responses`, `auth.command` e nenhum segredo;
- a autenticaÃ§Ã£o renova token numa tarefa com duraÃ§Ã£o superior a uma hora;
- o navegador e o banco nÃ£o recebem access token; apenas o segredo cifrado permanece nas AI Connections;
- tarefas da organizaÃ§Ã£o B nÃ£o podem ler credenciais ou acionar o helper da organizaÃ§Ã£o A;
- a execuÃ§Ã£o envia exatamente o ID selecionado no campo `model`.

### E2E manual

1. Criar e atribuir um service principal no Databricks; conceder `USE_CATALOG`, `USE_SCHEMA` e `EXECUTE` nos combos de teste.
2. Criar OAuth secret e cadastrar workspace URL, client ID e client secret numa conexÃ£o Databricks no Paperclip.
3. Selecionar `main.paperclip.combo_dev` e executar uma tarefa curta.
4. Criar `main.paperclip.combo_ux` no Databricks e conceder `EXECUTE` ao principal.
5. Abrir o seletor ou clicar em **Atualizar combos**.
6. Confirmar que **Combo UX** aparece sem editar cÃ³digo ou reiniciar serviÃ§os.
7. Selecionar o combo e executar uma tarefa.
8. Confirmar no Databricks que a chamada foi atribuÃ­da ao Model Service correto e ao service principal esperado.
9. Manter uma execuÃ§Ã£o por mais de uma hora e confirmar a renovaÃ§Ã£o do token.
10. Revogar a permissÃ£o/rotacionar o secret e confirmar que o Paperclip bloqueia acesso indevido sem expor credenciais.

## 13. CritÃ©rios de aceite

- [ ] Um Model Service novo aparece no Paperclip sem cadastro manual duplicado.
- [ ] A descoberta usa `/api/2.1/unity-catalog/model-services` com `parent=schemas/<catalog>.<schema>`.
- [ ] O ID salvo e executado Ã© o nome qualificado sem `model-services/`.
- [ ] O Codex usa `/ai-gateway/codex/v1`, Responses API e autenticaÃ§Ã£o OAuth M2M renovÃ¡vel.
- [ ] NÃ£o existe fallback silencioso para OpenAI.
- [ ] Nenhum client secret/access token chega ao navegador, logs ou TOML; nÃ£o hÃ¡ credenciais de uma organizaÃ§Ã£o em ferramentas de outra.
- [ ] O isolamento por organizaÃ§Ã£o estÃ¡ coberto por teste.
- [ ] PaginaÃ§Ã£o, cache, refresh e renovaÃ§Ã£o de token em tarefas longas funcionam.
- [ ] Erros de quota e permissÃ£o sÃ£o claros e acionÃ¡veis.
- [ ] Typecheck, testes direcionados, `pnpm test` e build passam.

## 14. Fora do MVP

- criar ou editar combos do Databricks dentro do Paperclip;
- provisionamento automÃ¡tico de service principals e rotaÃ§Ã£o automÃ¡tica do client secret de longa duraÃ§Ã£o (a renovaÃ§Ã£o automÃ¡tica do access token estÃ¡ no MVP);
- mostrar visualmente cada destino interno e percentual do combo;
- alterar as regras de routing/fallback do Databricks;
- sincronizaÃ§Ã£o em tempo real por webhook;
- cÃ¡lculo do custo real por destino quando o Databricks nÃ£o fornecer esse dado.

## 15. ReferÃªncias validadas

- [Paperclip â€” repositÃ³rio e arquitetura de adapters](https://github.com/paperclipai/paperclip)
- [Paperclip â€” registry com `listModels` e `refreshModels`](https://github.com/paperclipai/paperclip/blob/master/server/src/adapters/registry.ts)
- [Databricks â€” integraÃ§Ã£o com Codex e `ai-gateway/codex/v1`](https://docs.databricks.com/aws/en/ai-gateway/coding-agent-integration-model-services)
- [Databricks â€” API de Model Services do Unity Gateway](https://docs.databricks.com/api/ai-gateway/v1/model-service)
- [Databricks â€” OAuth M2M para service principals](https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m)
- [Databricks â€” `auth token` da CLI suporta apenas U2M](https://docs.databricks.com/aws/en/dev-tools/cli/reference/auth-commands)
- [Databricks â€” configuraÃ§Ã£o do Codex](https://docs.databricks.com/aws/en/ai-gateway/coding-agent-codex)

---

### Resumo da implementaÃ§Ã£o

```text
Paperclip codex_local
  -> conexÃ£o M2M do service principal da organizaÃ§Ã£o
  -> lista Model Services do schema autorizado
  -> mostra os combos no seletor
  -> salva o nome qualificado do combo
  -> autentica/renova OAuth M2M e injeta provider Databricks por execuÃ§Ã£o
  -> Databricks executa routing, limites e fallback
```