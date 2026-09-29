# Paperclip — descoberta automática do Databricks via OAuth M2M

Data: 28/09/2026. Status: especificação para implementação.

## 1. Objetivo e diagnóstico

Permitir que o usuário informe somente **Workspace URL, Client ID e Client secret** para conectar e carregar as opções disponíveis. Catálogo e schema passam a ser selecionados em listas dependentes, seguidos dos Model Services usados como combos no Paperclip.

Essas credenciais permitem iniciar a descoberta, mas não concedem acesso adicional: os recursos exibidos dependem das permissões do Service Principal, da atribuição ao workspace e da disponibilidade dos recursos naquele ambiente.

Os logs fornecidos mostram um `422` do Paperclip, sem a resposta original do Databricks. Eles não comprovam credencial incorreta, bug na chamada externa ou ausência de permissão. Trocar os campos por `system / ai` também não comprova que a conexão esteja válida.

Esta especificação é uma proposta de implementação baseada nas fontes oficiais abaixo. O código atual do repositório não foi inspecionado nesta tarefa; os nomes de classes e novas rotas são propostos e devem ser ajustados às convenções existentes.

## 2. Contratos oficiais confirmados

Todas as chamadas abaixo partem do backend e usam o host do workspace validado.

| Etapa | Método e caminho | Parâmetros e resultado relevantes | Fonte |
|---|---|---|---|
| Autenticação | `POST /oidc/v1/token` | HTTP Basic com Client ID/secret; formulário `grant_type=client_credentials`; scope compatível; resposta com `access_token`, `token_type`, `expires_in` | [D1] |
| Catálogos | `GET /api/2.1/unity-catalog/catalogs` | `max_results=0`; continuação com `page_token`; resposta `catalogs`, `next_page_token` | [D2] |
| Schemas | `GET /api/2.1/unity-catalog/schemas` | `catalog_name=<selecionado>`, `max_results=0`, `page_token`; resposta `schemas`, `next_page_token` | [D3] |
| Model Services | `GET /api/2.1/unity-catalog/model-services` | `parent=schemas/{catalog}.{schema}`, `page_size=100`, `view=BASIC`, `page_token`; resposta `model_services`, `next_page_token` | [D4] |

Para catálogos e schemas, a API pode retornar uma página vazia com continuação. Encerrar somente quando não houver `next_page_token`. As listas são filtradas conforme os privilégios do chamador, sem garantia de ordenação. Não solicitar `include_unbound=true`; não usar `include_browse=true` neste fluxo inicial. [D2][D3]

O nome canônico de um serviço é `model-services/{catalog}.{schema}.{model_service}`. Guardá-lo integralmente. A listagem exige acesso aos pais e pode incluir serviços visíveis por `EXECUTE`, `READ_METADATA`, `MANAGE` ou propriedade; visibilidade não prova capacidade de executar. [D4]

Para executar, são necessários `USE CATALOG`, `USE SCHEMA` e `EXECUTE` no serviço. Não exigir privilégios administrativos para conectar. [D5]

O Databricks documenta serviços próprios em `system.ai` e serviços personalizados em outros schemas. A disponibilidade depende também de Unity Catalog e região suportada. Portanto, `system.ai` pode aparecer como sugestão quando descoberto, nunca como valor obrigatório ou prova de autenticação. [D6]

“Combo” é um nome de produto do Paperclip. Nesta integração, ele representa um Model Service; não criar uma entidade Databricks fictícia chamada combo, nem confundir esse serviço com tabela, modelo registrado ou endpoint legado.

## 3. Experiência do usuário

### Etapa A — conectar

Campos iniciais: nome da conexão, Workspace URL, Client ID e Client secret. Manter as configurações locais de compartilhamento existentes. Catálogo, schema e prefixo não são pré-requisitos de autenticação.

Botão **Conectar e buscar opções**:

1. Valida o formulário e envia as credenciais uma única vez ao backend.
2. Mostra “Verificando conexão…”.
3. Quando a autenticação funciona, mostra “Autenticado” e inicia a listagem dos catálogos.
4. Se a descoberta falhar depois, preserva o resultado da autenticação e informa a etapa que falhou.

Não concluir “credenciais inválidas” a partir de lista vazia ou falha em metadados.

### Etapa B — escolher recursos

| Campo | Comportamento proposto |
|---|---|
| Catálogo | Seletor pesquisável, preenchido pelo backend |
| Schema | Habilitado após catálogo; busca apenas os schemas daquele catálogo |
| Serviços/combos | Lista do schema selecionado, com nome e descrição quando houver |
| Prefixo | Opção avançada local; vazio por padrão |
| Compartilhamento | Política local do Paperclip; não vem do Databricks |

Não selecionar silenciosamente a primeira opção. Uma opção única pode ser pré-selecionada visualmente, com confirmação no salvamento. Ordenar nomes na interface, preservando o valor original para as chamadas.

Ao trocar catálogo, limpar schema e lista de serviços. Ao trocar schema, limpar somente serviços. Cancelar solicitações antigas ou ignorar respostas cuja versão da seleção mudou. Ao alterar host ou credenciais, invalidar a sessão de descoberta e todas as seleções.

Estados obrigatórios: carregando, opções disponíveis, vazio, falha, resultados parciais e sessão expirada. O usuário pode tentar novamente sem redigitar credenciais enquanto a sessão continuar válida.

Mensagens de vazio:

- Catálogos: “Conexão autenticada. Nenhum catálogo acessível foi retornado para este Service Principal.”
- Schemas: “Nenhum schema acessível foi retornado neste catálogo.”
- Serviços: “Nenhum serviço visível neste schema. Escolha outro schema ou confira os acessos no Databricks.”

Não afirmar que um objeto inexiste apenas porque não foi retornado. Não ocultar catálogos ou schemas por nomes como `samples` ou `information_schema`; listas vazias são uma resposta válida.

### Etapa C — salvar

O usuário escolhe o catálogo/schema que delimitará a descoberta futura. Salvar conexão mesmo quando o schema não tiver serviços, com estado `configured_empty`; ela não poderá iniciar um agente sem um serviço selecionado.

Se houver falha de permissão ou descoberta incompleta, manter o rascunho e permitir corrigir/tentar novamente. Não apresentar esse caso como configuração pronta.

Serviços apenas visíveis recebem indicação “Execução ainda não verificada”. Não executar inferência para validar credenciais ou carregar listas. A autorização de execução será aplicada pelo Databricks durante o uso e seu erro deverá ser tratado separadamente. Adaptar essa indicação à interface sem expor detalhes técnicos desnecessários.

## 4. Backend e responsabilidades

Seguir a arquitetura existente; não introduzir outro framework ou ORM para esta funcionalidade.

| Componente proposto | Responsabilidade |
|---|---|
| Controller/rotas | Sessão local, autorização por empresa, DTOs e respostas |
| `DatabricksOAuthClient` | Solicitar e renovar token; nunca devolvê-lo à UI |
| `DatabricksDiscoveryClient` | Implementar os três contratos de listagem |
| `DatabricksConnectionService` | Orquestrar rascunho, descoberta, validação e salvamento |
| Repositório de conexões | Persistir configuração e referência ao segredo |
| Cofre existente | Criptografia e recuperação restrita de credenciais |
| Classificador de erros | Etapa, código, status externo e mensagem segura |

Reutilizar o mecanismo existente de secrets e autorização. Não armazenar credenciais em JSON comum se já houver cofre no projeto.

### Sessão temporária de descoberta

Proposta: criar um rascunho com ID opaco, associado a `companyId`, usuário criador e versão das credenciais. Prazo inicial de 15 minutos, configurável. Em implantação com múltiplas réplicas, usar armazenamento compartilhado com criptografia/TTL; memória de processo isolada não atende esse cenário.

Não tornar o ID uma credencial de acesso: cada requisição exige sessão Paperclip e verificação de proprietário/empresa. Excluir os dados temporários ao cancelar, expirar ou concluir. O salvamento deve transferir a credencial ao mecanismo persistente em operação consistente, sem deixá-la perdida ou exposta.

### Rotas internas propostas

Base: `/api/companies/:companyId/ai-connections/databricks`.

| Método | Sufixo | Entrada/efeito |
|---|---|---|
| POST | `/discovery-sessions` | Recebe host/client/secret, autentica e cria rascunho |
| GET | `/discovery-sessions/:id/catalogs` | Página de catálogos |
| GET | `/discovery-sessions/:id/schemas` | `catalog` e cursor opcional |
| GET | `/discovery-sessions/:id/model-services` | `catalog`, `schema` e cursor opcional |
| DELETE | `/discovery-sessions/:id` | Cancela e descarta rascunho |

Estender o POST de criação já existente, `/api/companies/:companyId/ai-connections`, para aceitar `discoverySessionId`, `catalog`, `schema`, nome, prefixo e regras locais de acesso. Não reenviar secret nessa etapa.

Manter compatibilidade com o contrato atual de criação direta, se houver outros consumidores. Ele deve chamar o mesmo serviço interno e retornar os mesmos erros classificados. Rejeitar payload que combine fontes de credenciais conflitantes.

Para conexões salvas, disponibilizar listagens equivalentes sob o ID da conexão, com a autorização existente. Não exigir que a UI recupere ou reenvie o secret para atualizar opções.

### DTOs internos propostos

```ts
type DiscoveryPage<T> = {
  items: T[];
  nextCursor: string | null;
  complete: boolean;
  fetchedAt: string;
};

type CatalogOption = { name: string; comment?: string };
type SchemaOption = { name: string; catalog: string; fullName: string };
type ModelServiceOption = {
  resourceName: string;
  catalog: string;
  schema: string;
  label: string;
  comment?: string;
  supportedApiTypes: string[];
  executionAccess: "unknown" | "verified" | "denied";
};

type DiscoveryFailure = {
  code: string;
  stage: "input" | "oauth" | "catalogs" | "schemas" | "model_services" | "save";
  message: string;
  upstreamStatus?: number;
  upstreamCode?: string;
  retryable: boolean;
  requestId: string;
};
```

Esses DTOs são do Paperclip. Não assumir que campos como `executionAccess`, `label` ou `complete` existem na API externa. Inicializar acesso de execução como desconhecido; uma leitura de metadados não o verifica.

## 5. Implementação das chamadas e paginação

Usar `URL` e `URLSearchParams`; não concatenar valores não escapados. Credenciais HTTP Basic pertencem exclusivamente à requisição do token. Usar Bearer nas demais chamadas.

Para OAuth, enviar formulário URL-encoded. O exemplo oficial usa `scope=all-apis`; secrets com escopo restrito limitam o token, e as operações de descoberta documentam `unity-catalog`. Tornar o escopo configuração interna: adotar `unity-catalog` para descoberta e confirmar os escopos adicionais necessários no adaptador de inferência existente. Não ampliar escopo automaticamente após falha. [D1][D7]

Guardar token apenas no servidor, respeitar `expires_in` e renovar com margem configurável, inicialmente 60 segundos. Implementar trava por credencial para evitar renovações concorrentes. Um `401` em GET permite uma renovação e uma repetição; impedir loop infinito.

Paginar de ponta a ponta: a UI deve carregar páginas seguintes ao rolar ou pesquisar. Uma busca local não pode anunciar “nenhum resultado” enquanto houver páginas não carregadas. O backend pode encapsular o token externo num cursor vinculado ao rascunho, operação e seleção; rejeitar seu uso em outro contexto.

Propostas operacionais: timeout de 15 segundos por chamada, até duas novas tentativas para falhas transitórias, espera com jitter e respeito a `Retry-After`. Não repetir erro de credencial ou de permissão. Cancelamento da UI deve interromper trabalho desnecessário. Detectar cursor repetido e reportar resposta inválida, sem travar.

Cache de metadados por até 60 segundos, isolado por empresa, conexão/rascunho, versão da credencial e seleção. Não compartilhar cache por host apenas. “Atualizar” ignora esse cache. Cache não substitui autorização.

## 6. Erros e observabilidade

O problema a resolver é a perda de contexto, não apenas o número `422`. HTTP abaixo é uma proposta para a API interna; preservar separadamente o status externo.

| Situação | Código interno sugerido | HTTP interno / comportamento |
|---|---|---|
| Entrada inválida | `DATABRICKS_INVALID_INPUT` | 400; destacar campo |
| Rejeição OAuth explícita | `DATABRICKS_AUTH_FAILED` | 422; etapa OAuth e motivo seguro |
| Escopo rejeitado | `DATABRICKS_SCOPE_REJECTED` | 422; orientar revisar escopos |
| Acesso externo negado | `DATABRICKS_ACCESS_DENIED` | 422; manter estado autenticado quando já comprovado |
| Recurso/rota externa não encontrado | `DATABRICKS_RESOURCE_UNAVAILABLE` | 422; não concluir automaticamente que Gateway não está habilitado |
| Limite de requisições | `DATABRICKS_RATE_LIMITED` | 429; indicar nova tentativa |
| Timeout | `DATABRICKS_TIMEOUT` | 504 |
| Falha de rede/5xx/resposta inválida | `DATABRICKS_UPSTREAM_ERROR` | 502 |
| Lista vazia | Sem erro | 200; estado vazio |
| Sessão de descoberta expirada | `DATABRICKS_DISCOVERY_EXPIRED` | 410; solicitar reconexão |

Falhas de autenticação/autorização do próprio Paperclip continuam usando seus códigos locais 401/403. Não confundi-las com o Databricks.

Classificar pela etapa, status e código externo quando disponível. Um `403` pode exigir investigar permissões, escopo ou políticas do workspace; um `404` pode indicar caminho incorreto, recurso indisponível ou contexto errado. Não apresentar suposição como diagnóstico confirmado.

Registrar somente campos permitidos: correlação, empresa, conexão, operação, caminho sem segredos, duração, status externo e código externo sanitizado. Não registrar corpo bruto, objeto completo de exceção HTTP, headers de autorização, cookie, secret ou token. Desabilitar captura desses dados também no tracing e logger de requisições.

Exemplo de resposta local, sem credenciais:

```json
{
  "error": {
    "code": "DATABRICKS_ACCESS_DENIED",
    "stage": "schemas",
    "message": "Autenticação concluída, mas o Databricks negou a consulta aos schemas deste catálogo.",
    "upstreamStatus": 403,
    "retryable": false,
    "requestId": "id-de-correlacao"
  }
}
```

## 7. Segurança e isolamento

- Validar HTTPS, hostname e destino antes de enviar credenciais; bloquear URLs com usuário/senha, destinos locais, metadata endpoints e redirecionamento para outra origem. Aplicar política de egress/SSRF existente. PrivateLink deve ser permitido por configuração administrativa explícita, sem liberar endereços arbitrários.
- Aceitar URL base; remover barra final e orientar correção de caminhos/query/fragmento em vez de tratar esses valores como endpoint.
- Secret fica em campo de senha e estado transitório do formulário; não usar localStorage, URL, analytics ou resposta de API. Limpar o campo após criar o rascunho.
- Autorizar todas as operações por empresa e usuário. Validar os agentes indicados contra a mesma empresa; não confiar em `companyId`/`agentIds` do cliente.
- Compartilhamento Personal segue as regras locais; acesso ao recurso no Databricks não autoriza compartilhamento com outros usuários do Paperclip.
- Verificar novamente o catálogo/schema selecionado no salvamento. Não confiar apenas na opção previamente exibida nem no cache.
- Rotação do secret invalida tokens/cache da versão anterior. Não exigir novo secret apenas para editar o nome da conexão.
- Preservar maiúsculas, caracteres e nomes retornados. Usar os identificadores canônicos; não separar nomes arbitrariamente com `split('.')` para reconstruir recursos.

## 8. Persistência e sincronização de combos

Persistir os campos existentes de identidade, propriedade e agentes, mais `workspaceHost` normalizado, `clientId`, referência criptografada do secret, catálogo/schema separados, prefixo opcional, versão da credencial e timestamps de descoberta. Separar `authStatus` de `discoveryStatus`.

Não guardar access token no DTO público ou como credencial permanente. Não preencher catálogos ausentes com `system` durante migração. Conexões antigas mantêm suas seleções e passam pelo novo fluxo na próxima edição/atualização.

Depois de salvar, buscar serviços do schema configurado ao abrir o seletor de agente e pelo botão Atualizar. O novo combo deverá aparecer na próxima atualização, sem reiniciar o Paperclip ou alterar código. Não prometer push em tempo real: esta implementação usa consulta sob demanda e cache curto.

Usar chave composta de empresa, conexão e resource name para evitar colisão entre serviços homônimos. Encaminhar a seleção ao adaptador de inferência, preservando o nome canônico e o tipo de API compatível. Se a compatibilidade não puder ser determinada, informar isso sem declarar o serviço pronto para aquele agente.

Prefixo, nesta proposta, é filtro literal do nome curto do serviço dentro do escopo escolhido. Não usá-lo no OAuth ou para construir endpoints. Se o projeto já tiver outra semântica, preservar o comportamento documentado e ajustar este requisito antes da alteração.

Atualização parcial nunca deve apagar opções existentes. Somente uma varredura completa bem-sucedida pode marcar um serviço ausente como indisponível para novas seleções. Não excluir configurações de agentes; mostrar a referência antiga indisponível e pedir substituição. Não ativar fallback para outro combo silenciosamente.

## 9. Plano de implementação

- [ ] **T01 — mapear implementação atual.** Localizar formulário/onboarding, DTOs compartilhados, rota de criação, cliente Databricks, cofre, ACL e seletor de modelos. Identificar onde erros viram mensagem genérica. Entrega: mapa dos arquivos reais e compatibilidades a preservar.
- [ ] **T02 — separar OAuth e descoberta.** Implementar clientes, contratos externos, renovação e erro por etapa. Entrega: autenticação funciona sem catálogo/schema.
- [ ] **T03 — sessão temporária e autorização.** Implementar TTL, criptografia, isolamento e descarte, incluindo múltiplas réplicas. Entrega: nenhum segredo no contrato público.
- [ ] **T04 — APIs de opções.** Implementar listagens, cursores, cache e cancelamento. Entrega: todas as páginas acessíveis, inclusive após página vazia.
- [ ] **T05 — formulário progressivo.** Trocar entradas manuais por seletores, estados e atualização. Entrega: conectar somente com as três credenciais técnicas, sem valores fixos.
- [ ] **T06 — persistência e edição.** Integrar salvamento, rotação, compatibilidade e migrações necessárias. Entrega: conexão antiga continua editável sem expor secret.
- [ ] **T07 — descoberta nos agentes.** Integrar serviços ao seletor e preservar IDs/escopo. Entrega: novo serviço aparece após atualização e não atravessa empresas.
- [ ] **T08 — diagnóstico seguro.** Implementar classificação, correlação, mensagens e sanitização no logger/tracing. Entrega: identificar a etapa do erro sem vazamento.
- [ ] **T09 — testes automatizados.** Executar a matriz abaixo e as verificações existentes afetadas. Entrega: resultados reproduzíveis, sem chamadas de inferência automáticas.
- [ ] **T10 — validação real.** Executar os testes manuais com workspace e acesso autorizados. Entrega: evidências sanitizadas e pendências explícitas.
- [ ] **T11 — revisão de escopo.** Conferir requisito por requisito, compatibilidade e critérios de aceite. Entrega: lista do implementado, não implementado e não validado; não marcar validação real como concluída por passar em mocks.

Dependências: T01 → T02 → T03/T04 → T05/T06 → T07; T08 acompanha backend; T09 → T10 → T11.

## 10. Matriz mínima de testes

| Cenário | Resultado esperado |
|---|---|
| OAuth válido sem catálogo/schema | Sessão criada; catálogos podem ser consultados |
| Secret inválido ou escopo rejeitado | Erro específico na etapa OAuth |
| OAuth válido e catálogo negado | Autenticação preservada; falha de descoberta |
| Catálogo com múltiplos schemas | Exibir os retornados e preservar seleção correta |
| Página vazia com continuação | Continuar carregamento |
| Mais de uma página de serviços | Todos disponíveis após paginação, sem duplicação |
| Schema sem serviços | Estado vazio; permitir salvar escopo vazio |
| Visibilidade sem comprovação de execução | Não afirmar execução autorizada |
| Troca rápida de catálogo | Resposta antiga não sobrescreve seleção nova |
| Timeout/429/5xx | Tentativas limitadas e UI recuperável |
| Token expirado | Uma renovação compartilhada, sem tempestade de requisições |
| Empresa/usuário diferente | Acesso negado ao rascunho, cache e conexão |
| URL maliciosa ou redirect externo | Bloqueio antes do envio de credenciais |
| Falha de paginação intermediária | Sem remoção de serviços pelo resultado parcial |
| Novo serviço no Databricks | Aparece após atualizar |
| Serviço removido ou acesso revogado | Referência preservada, indisponibilidade indicada |
| Edição de nome de conexão existente | Não exige recuperar secret na UI |
| Erros externos com dados sensíveis | Resposta, logs e tracing permanecem sanitizados |

### Validação manual necessária

Usar ambiente de teste autorizado para confirmar escopos aceitos, atribuição do Service Principal, listagens e nomes reais, permissões restritas, disponibilidade do Gateway, renovação e comportamento após mudanças de acesso. Não há acesso autenticado ao workspace nesta pesquisa.

Criar um serviço de teste no Databricks, atualizar o seletor e registrar o resultado. Conferir também uma conexão já existente. Inferência real é uma validação separada que pode gerar custo: executar apenas com autorização e orçamento de teste, nunca como efeito de abrir o formulário.

## 11. Critérios de aceite

1. O usuário inicia a descoberta com host/client/secret, sem digitar catálogo/schema.
2. A interface mostra opções reais retornadas, sem impor `system.ai`.
3. Acesso negado, erro OAuth, recurso indisponível e lista vazia têm estados diferentes.
4. A paginação não omite resultados nem encerra em página vazia com cursor.
5. Novo combo é descoberto na atualização do escopo salvo.
6. Secret e token nunca aparecem na resposta, no armazenamento do navegador ou nos logs.
7. Empresas, usuários e conexões não compartilham opções indevidamente.
8. Conexões existentes continuam funcionando conforme seus contratos compatíveis.
9. Listar um serviço não é apresentado como teste de inferência bem-sucedido.
10. O relatório final de implementação identifica testes executados e pendências reais.

## 12. Fontes oficiais

Consultadas em 28/09/2026. As decisões de UI, rotas locais, TTL, cache, arquitetura e códigos internos são propostas deste documento, não imposições do Databricks.

- **[D1] OAuth M2M:** https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m
- **[D2] List catalogs:** https://docs.databricks.com/api/uc-catalogs/v1/list-catalogs
- **[D3] List schemas:** https://docs.databricks.com/api/uc-schemas/v1/list-schemas
- **[D4] Model Service API:** https://docs.databricks.com/api/ai-gateway/v1/model-service
- **[D5] Govern access to model services:** https://docs.databricks.com/aws/en/ai-gateway/govern-model-services
- **[D6] Create model services:** https://docs.databricks.com/aws/en/ai-gateway/create-model-services
- **[D7] API scopes:** https://docs.databricks.com/api/workspace/scopes
