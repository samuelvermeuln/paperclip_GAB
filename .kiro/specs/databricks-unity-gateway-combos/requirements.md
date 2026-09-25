# Requirements Document

## Introduction

Esta feature permite que o Paperclip descubra automaticamente os Model Services ("combos") publicados no Databricks Unity Catalog de uma organização e os disponibilize como opção de modelo para agentes que usam o adapter `codex_local`, autenticando a execução por OAuth 2.0 Machine-to-Machine (client credentials) em vez de um Personal Access Token estático. Os requisitos abaixo derivam do design aprovado em `design.md` e do documento fonte `databricks.md` (revisão de autenticação de 24/09/2026).

O escopo cobre: descoberta paginada de combos via Unity Catalog, criação de conexões de IA Databricks com OAuth M2M, ausência de fallback silencioso para OpenAI, execução via Unity Gateway com um helper externo de autenticação, isolamento multi-tenant de cache e credenciais, ciclo de vida de rotação/revogação de credencial, o fluxo de seleção na UI, tratamento de erros/segurança, e contabilização de uso sem inventar dados.

## Glossary

- **Paperclip**: O control plane que orquestra agentes de IA e suas execuções.
- **Company**: A organização (tenant) à qual uma conexão, agente ou execução pertence.
- **Agent**: Uma configuração de agente do Paperclip que usa o `Codex_Local_Adapter` como executor.
- **Combo**: Um Model Service do Databricks Unity Catalog, identificado pelo nome qualificado `<catalog>.<schema>.<nome>` sem o prefixo `model-services/`.
- **Codex_Local_Adapter**: O adapter `codex_local` responsável por executar tarefas do agente, incluindo a seleção de provedor de modelo.
- **Codex_Runtime**: O componente do `Codex_Local_Adapter` (`packages/adapters/codex-local`) que gera a configuração `config.toml` e prepara a execução do processo Codex.
- **Databricks_Discovery_Service**: O serviço do servidor (`server/src/services/databricks-model-services.ts`) responsável por consultar, paginar, normalizar e cachear a lista de combos do Unity Catalog.
- **Databricks_OAuth_Service**: O serviço do servidor (`server/src/services/databricks-oauth.ts`) responsável por trocar `clientId`/`clientSecret` por um Access_Token OAuth M2M e cachear esse token.
- **AI_Connection_Service**: O serviço do servidor (`server/src/services/ai-connections.ts`) responsável por criar, validar, resolver e revogar conexões de IA, incluindo conexões Databricks.
- **Model_Discovery_Endpoint**: O endpoint HTTP `GET /api/companies/:companyId/adapters/codex_local/models` usado pela UI para obter a lista de combos.
- **Agent_Config_UI**: O componente de interface (`ui/src/components/AgentConfigForm.tsx`) usado para configurar o provedor de modelo, a conexão e o combo de um agente.
- **Databricks_Auth_Helper**: O binário externo (`auth.command`) invocado pelo processo Codex para obter um Access_Token OAuth M2M durante a execução.
- **Unity_Catalog_API**: A API REST do Databricks Unity Catalog usada para listar Model Services (`GET /api/2.1/unity-catalog/model-services`).
- **Unity_Gateway**: O endpoint de execução do Databricks AI Gateway (`/ai-gateway/codex/v1`) usado pelo Codex para inferência.
- **Access_Token**: O token OAuth M2M de curta duração (~1 hora) obtido por client credentials e usado para autenticar chamadas ao `Unity_Catalog_API` e ao `Unity_Gateway`.
- **Client_ID / Client_Secret**: As credenciais do service principal Databricks usadas na troca client-credentials.
- **Credential_Version**: O identificador de versão do secret de uma conexão, incrementado em toda rotação ou revogação.

## Requirements

### Requirement 1: Descoberta de combos via Unity Catalog Model Services

**User Story:** Como administrador de uma organização, eu quero que novos combos criados no Databricks apareçam automaticamente no Paperclip, para que eu não precise cadastrá-los manualmente nem alterar código.

#### Acceptance Criteria

1. WHEN uma requisição de descoberta de combos é recebida com uma conexão Databricks válida, THE Databricks_Discovery_Service SHALL solicitar os Model Services ao Unity_Catalog_API restringidos ao catalog e schema configurados na conexão.
2. WHILE a resposta do Unity_Catalog_API contiver um `next_page_token`, THE Databricks_Discovery_Service SHALL continuar solicitando as páginas seguintes até receber uma resposta sem `next_page_token`.
3. THE Databricks_Discovery_Service SHALL derivar o identificador de cada combo a partir do nome do recurso retornado, removendo o prefixo `model-services/` somente quando esse prefixo estiver presente no início do nome, e mantendo o nome do recurso sem alteração quando o prefixo estiver ausente.
4. THE Databricks_Discovery_Service SHALL derivar o rótulo de cada combo a partir do nome curto do identificador, substituindo cada ocorrência de hífen (`-`) ou sublinhado (`_`) por um espaço e capitalizando a primeira letra de cada palavra resultante, sem alterar a caixa das demais letras dessa palavra.
5. WHERE um filtro de prefixo estiver configurado na conexão, THE Databricks_Discovery_Service SHALL excluir da lista os combos cujo nome curto não iniciar, em comparação sensível a maiúsculas e minúsculas, com o prefixo configurado.
6. IF os dois primeiros segmentos, separados por ponto, do identificador derivado de um recurso retornado não corresponderem, em comparação sensível a maiúsculas e minúsculas, exatamente ao catalog e ao schema configurados na conexão, respectivamente, THEN THE Databricks_Discovery_Service SHALL excluir esse recurso da lista de combos retornada.
7. THE Databricks_Discovery_Service SHALL retornar a lista de combos ordenada por rótulo em ordem ascendente por comparação ordinal sensível a maiúsculas e minúsculas (código de caractere Unicode), com identificadores duplicados removidos mantendo apenas a primeira ocorrência de cada identificador na ordem em que os recursos foram recebidos do Unity_Catalog_API antes da ordenação.
8. WHEN uma requisição de descoberta incluir `refresh=1`, THE Databricks_Discovery_Service SHALL ignorar a lista de combos em cache e emitir novas requisições ao Unity_Catalog_API.
9. IF o Unity_Catalog_API retornar 1000 páginas consecutivas contendo `next_page_token` para a mesma requisição de descoberta sem que a paginação seja concluída, THEN THE Databricks_Discovery_Service SHALL interromper a paginação dessa requisição e SHALL classificar a falha como um erro de indisponibilidade temporária.

### Requirement 2: Conexão de IA Databricks com autenticação OAuth M2M

**User Story:** Como administrador de uma organização, eu quero cadastrar uma conexão Databricks usando as credenciais OAuth de um service principal, para que a execução de agentes não dependa de um token estático de longa duração.

#### Acceptance Criteria

1. IF uma requisição de criação de conexão de IA para o provider `databricks` tiver o campo `method` diferente de `oauth_m2m`, THEN THE AI_Connection_Service SHALL rejeitar a requisição com um erro de validação indicando que `oauth_m2m` é o único método de autenticação suportado para o provider `databricks`.
2. IF a requisição de criação para provider `databricks` omitir ou fornecer um valor vazio para Client_ID, Client_Secret, workspace host, catalog ou schema, THEN THE AI_Connection_Service SHALL rejeitar a requisição com um erro de validação identificando cada campo ausente ou vazio.
3. IF o valor do workspace host não for uma URL cujo esquema seja `https`, ou contiver userinfo, um caminho diferente de vazio ou de uma única barra (`/`), query string ou fragment, THEN THE AI_Connection_Service SHALL rejeitar a requisição de criação da conexão com um erro de validação indicando que o workspace host deve ser uma URL `https://` somente com origin.
4. WHEN um workspace host for aceito conforme o Critério 3, THE AI_Connection_Service SHALL normalizar e persistir esse valor em sua forma de origin (protocolo, host e porta), sem barra final.
5. THE AI_Connection_Service SHALL persistir o Client_Secret exclusivamente no mecanismo de segredos cifrados e SHALL excluir o valor do Client_Secret de toda resposta de API relativa a essa conexão — incluindo criação, atualização, consulta individual e listagem — emitida em qualquer momento após a criação da conexão.
6. WHERE a propriedade (`ownership`) da conexão for `shared`, THE AI_Connection_Service SHALL tornar a conexão utilizável pelos membros da organização conforme o grant configurado; WHERE a propriedade for `personal`, THE AI_Connection_Service SHALL restringir o uso da conexão ao usuário criador.
7. WHERE a implantação do Paperclip for uma implantação SaaS, IF o workspace host normalizado não estiver presente na allowlist de hosts SaaS configurada e nenhuma liberação administrativa para hosts privados estiver configurada, THEN THE AI_Connection_Service SHALL rejeitar a conexão.

### Requirement 3: Ausência de fallback silencioso para OpenAI

**User Story:** Como administrador responsável por governança de custos, eu quero que uma falha do Databricks nunca desvie a execução para a OpenAI sem aviso, para que o controle de custo e de acesso a modelos seja preservado.

#### Acceptance Criteria

1. IF a resolução de credencial, a troca de token OAuth M2M, ou a chamada de execução ao Unity_Gateway falhar para um agente configurado com `modelProvider` igual a `databricks`, THEN THE Codex_Local_Adapter SHALL, conforme a política de retentativa de execução já configurada para o agente, falhar a execução com um erro observável indicando a etapa que falhou (resolução de credencial, troca de token, ou chamada de execução) ou aguardar antes de tentar novamente, SHALL preservar o `modelProvider` da execução como `databricks` em toda tentativa subsequente, e SHALL NOT substituir o provedor de modelo por OpenAI ou por qualquer outra conexão em nenhuma tentativa.
2. WHILE o `modelProvider` de um agente estiver definido como `databricks`, THE Databricks_Discovery_Service SHALL retornar ao Agent_Config_UI somente identificadores de Model Services do Databricks, e SHALL NOT incluir nenhum identificador de modelo de outro provedor, incluindo OpenAI, na mesma resposta.
3. IF o identificador de combo previamente salvo de um agente estiver ausente nos resultados de descoberta atuais, OU a descoberta necessária para confirmar essa presença não puder ser concluída, THEN THE Codex_Local_Adapter SHALL bloquear o início de uma nova execução desse agente, retornando um erro indicando que o combo selecionado não está disponível, até que o usuário selecione um combo disponível.

### Requirement 4: Execução via Unity Gateway com helper externo de autenticação M2M

**User Story:** Como operador do Paperclip, eu quero que a execução do Codex use o Unity Gateway autenticado por um helper OAuth M2M renovável, para que tarefas longas não falhem por expiração de token e nenhum segredo fique exposto.

#### Acceptance Criteria

1. WHEN uma execução iniciar para um agente configurado com `modelProvider` igual a `databricks`, THE Codex_Runtime SHALL gerar uma configuração de provedor de modelo cujo `base_url` termine em `/ai-gateway/codex/v1`, cujo `wire_api` seja igual a `responses`, e cujo `supports_websockets` seja igual a `false`.
2. WHEN uma execução iniciar para um agente configurado com `modelProvider` igual a `databricks`, THE Codex_Runtime SHALL configurar a seção `auth` do provedor de modelo gerado com um comando de caminho absoluto, uma lista de argumentos, um `timeout_ms` inteiro positivo e um `refresh_interval_ms` inteiro positivo estritamente menor que a duração de vida do Access_Token (~1 hora, conforme Glossário), e SHALL excluir `env_key` e qualquer valor de segredo literal dessa seção.
3. THE Codex_Runtime SHALL definir o campo `model` enviado ao Codex como exatamente o identificador de combo selecionado pelo usuário, sem reescrevê-lo ou reinterpretá-lo.
4. WHEN o intervalo definido em `refresh_interval_ms` transcorrer durante uma execução ativa, THE Databricks_Auth_Helper SHALL obter um novo Access_Token OAuth M2M.
5. WHEN o Databricks_Auth_Helper obtiver um Access_Token com sucesso, THE Databricks_Auth_Helper SHALL escrever na saída padrão exclusivamente o valor do Access_Token, sem nenhum caractere adicional, incluindo quebra de linha, antes ou depois desse valor.
6. IF o Databricks_Auth_Helper falhar ao obter um Access_Token, THEN THE Databricks_Auth_Helper SHALL escrever na saída de erro uma mensagem de erro que exclua o valor do Client_Secret, o valor de todo Access_Token e o corpo da resposta recebida do endpoint OAuth do Databricks, e SHALL finalizar com um código de saída diferente de zero.
7. THE Databricks_OAuth_Service SHALL NOT retornar, a partir do cache, um Access_Token cujo horário de expiração esteja a menos de 60 segundos no futuro ou já tenha passado no momento em que o token é servido a partir do cache.
8. THE Codex_Runtime SHALL excluir o valor do Client_Secret e de todo Access_Token da configuração TOML gerada, dos logs de execução, dos eventos de runtime, do conteúdo de prompt do agente e de toda resposta enviada ao navegador.
9. THE AI_Connection_Service e THE Codex_Runtime SHALL limitar o material de credencial Databricks persistido ao Client_Secret cifrado e a Access_Tokens de curta duração mantidos somente em memória ou em arquivo efêmero por execução, sem persistir em `adapterConfig`, `config.toml`, registros de banco de dados ou variável de ambiente de longa duração um valor equivalente a um `DATABRICKS_TOKEN` fixo.

### Requirement 5: Isolamento multi-tenant de cache e credenciais

**User Story:** Como administrador de uma organização, eu quero ter certeza de que combos, credenciais e tokens de outra organização nunca fiquem visíveis ou reutilizáveis pela minha, para que o isolamento multi-tenant seja preservado.

#### Acceptance Criteria

1. THE Databricks_Discovery_Service SHALL indexar cada lista de combos em cache pela combinação de `companyId`, `connectionId`, `credentialVersion`, `host`, `catalog`, `schema` e `modelPrefix`, usando, para a parte `modelPrefix` da chave, um marcador fixo e distinto de qualquer prefixo real quando a conexão não tiver um filtro de prefixo configurado.
2. THE Databricks_OAuth_Service SHALL indexar cada Access_Token em cache pela combinação de `companyId`, `connectionId`, `credentialVersion` e `host`.
3. WHEN uma requisição de descoberta ou de token for recebida em nome de um `companyId`, THE Databricks_Discovery_Service e THE Databricks_OAuth_Service SHALL restringir toda entrada de cache retornada, reaproveitada ou exposta em resposta a essa requisição a entradas indexadas por esse mesmo `companyId`, tratando qualquer entrada indexada por um `companyId` diferente como inexistente para essa requisição.
4. WHILE uma execução estiver em andamento para uma organização, THE Codex_Runtime SHALL manter um arquivo de credencial e um diretório home efêmero exclusivos dessa execução, não compartilhados nem reaproveitados por nenhuma outra execução, com acesso de leitura restrito ao processo dessa execução, de modo que um processo pertencente à execução de outra organização não consiga ler o arquivo de credencial nem o diretório home efêmero dessa execução.
5. IF THE Codex_Runtime não conseguir criar ou restringir o acesso ao arquivo de credencial ou ao diretório home efêmero de uma execução, THEN THE Codex_Runtime SHALL abortar essa execução sem iniciar o processo Codex.
6. WHEN uma execução for concluída, com sucesso ou com falha, THE Codex_Runtime SHALL remover o arquivo de credencial e o diretório home efêmero dessa execução, de modo que nenhuma execução subsequente ou processo de outra execução consiga ler esse arquivo ou diretório.

### Requirement 6: Revogação e rotação de credencial

**User Story:** Como administrador de uma organização, eu quero revogar ou rotacionar o secret de uma conexão Databricks e ter certeza de que novas execuções são bloqueadas imediatamente, para que uma credencial comprometida não continue em uso.

#### Acceptance Criteria

1. WHEN o Client_Secret de uma conexão Databricks for rotacionado, ou a conexão for revogada por uma ação administrativa deliberada do administrador (e não por uma falha transitória de rede ou de disponibilidade do Databricks), THE AI_Connection_Service SHALL incrementar o Credential_Version da conexão para um valor que nunca tenha sido usado anteriormente por essa conexão, inclusive quando rotações ou revogações ocorrerem em sucessão rápida.
2. WHEN o Credential_Version de uma conexão mudar, THE Databricks_Discovery_Service e THE Databricks_OAuth_Service SHALL garantir que nenhuma requisição subsequente de listagem de combos ou de troca de token para essa conexão seja atendida por uma entrada em cache indexada pelo Credential_Version anterior, invalidando explicitamente toda lista de combos e todo Access_Token em cache associados a esse Credential_Version anterior.
3. IF uma requisição de troca de token para uma conexão Databricks usar ou depender de um Client_Secret que tenha sido rotacionado ou de uma conexão que tenha sido revogada, THEN THE Databricks_OAuth_Service SHALL rejeitar a troca, SHALL NOT retornar nenhum Access_Token em cache associado ao Credential_Version anterior dessa conexão, e SHALL classificar a falha com o mesmo erro de credencial inválida usado para uma resposta HTTP 401 do Databricks.
4. THE AI_Connection_Service SHALL limitar toda ação de rotação ou revogação à invalidação do cache e da credencial armazenados pelo Paperclip. THE AI_Connection_Service SHALL NOT emitir nenhuma chamada de revogação remota ao Databricks para um Access_Token já emitido. THE AI_Connection_Service SHALL tratar um Access_Token emitido pelo Databricks antes de uma rotação como válido até seu horário de expiração original.
5. WHILE uma conexão Databricks referenciada por um agente estiver revogada, THE Codex_Local_Adapter SHALL bloquear, antes de qualquer chamada ao Databricks_OAuth_Service ou ao Unity_Gateway, toda tentativa de iniciar uma execução desse agente — incluindo uma nova tarefa, uma execução em fila ou uma retentativa — apresentando uma indicação de erro que exija reconfiguração, sem substituir o provedor da execução por outro. THE Codex_Local_Adapter SHALL cessar esse bloqueio assim que a conexão referenciada pelo agente resolver a credencial com sucesso, seja por reconexão da mesma conexão com uma credencial válida, seja pela seleção de outra conexão Databricks que resolva com sucesso.

### Requirement 7: Fluxo de seleção na interface

**User Story:** Como usuário configurando um agente, eu quero escolher o provedor Databricks, a conexão e o combo de forma guiada, com opção de atualizar a lista manualmente, para que eu sempre veja os combos disponíveis mais recentes.

#### Acceptance Criteria

1. WHEN um usuário selecionar "Databricks" como provedor de modelo de um agente, THE Agent_Config_UI SHALL exigir a seleção de uma conexão Databricks da organização atual, não revogada, que o usuário atual esteja autorizado a usar, antes de exibir o seletor de combo.
2. WHEN o seletor de combo for aberto, THE Agent_Config_UI SHALL solicitar a lista de combos ao Model_Discovery_Endpoint.
3. WHEN um usuário ativar o controle de atualização, THE Agent_Config_UI SHALL solicitar a lista de combos ao Model_Discovery_Endpoint com `refresh=1`, ignorando qualquer resposta em cache.
4. WHILE nenhuma atualização for solicitada, THE Model_Discovery_Endpoint SHALL servir uma resposta de lista de combos em cache por até 60 segundos a partir da requisição anterior com a mesma chave de cache.
5. IF o identificador de combo salvo de um agente estiver ausente nos resultados de descoberta atuais, THEN THE Agent_Config_UI SHALL exibir esse combo com o rótulo "Indisponível" e SHALL impedir o início de uma nova execução desse agente até que o usuário selecione um combo presente nos resultados de descoberta atuais.
6. WHILE o `modelProvider` de um agente for igual a `databricks`, THE Agent_Config_UI SHALL rotular o campo de seleção de modelo como "Combo".
7. IF a organização atual não possuir nenhuma conexão Databricks não revogada que o usuário atual esteja autorizado a usar, THEN THE Agent_Config_UI SHALL exibir uma indicação de que nenhuma conexão Databricks está disponível e SHALL ocultar o seletor de combo até que uma conexão elegível seja configurada.
8. IF a requisição de lista de combos ao Model_Discovery_Endpoint falhar, incluindo falha de rede ou uma resposta de erro classificada como credencial inválida, permissão insuficiente, limite de taxa, ou indisponibilidade temporária, THEN THE Agent_Config_UI SHALL exibir uma indicação de erro identificando o tipo de falha e SHALL preservar o combo atualmente selecionado do agente sem alteração.
9. WHEN a lista de combos retornada pelo Model_Discovery_Endpoint estiver vazia, THE Agent_Config_UI SHALL exibir uma indicação de que nenhum combo foi encontrado para a conexão selecionada.

### Requirement 8: Segurança e tratamento de erros

**User Story:** Como operador do Paperclip, eu quero que falhas de autenticação, permissão, limite de taxa e indisponibilidade do Databricks sejam classificadas de forma clara e sem expor segredos, para que problemas sejam diagnosticáveis e o sistema permaneça seguro.

#### Acceptance Criteria

1. IF a resposta do Unity_Catalog_API retornar HTTP 401, THEN THE Databricks_Discovery_Service SHALL classificar a falha como um erro de credencial inválida e SHALL excluir o corpo dessa resposta HTTP de todo log e de toda mensagem de erro. IF a resposta do endpoint de token do Databricks retornar HTTP 401, THEN THE Databricks_OAuth_Service SHALL classificar a falha como um erro de credencial inválida e SHALL excluir o corpo dessa resposta HTTP de todo log e de toda mensagem de erro.
2. IF a resposta do Unity_Catalog_API retornar HTTP 403, THEN THE Databricks_Discovery_Service SHALL classificar a falha como um erro de permissão insuficiente e SHALL excluir o corpo dessa resposta HTTP de todo log e de toda mensagem de erro. IF a resposta do endpoint de token do Databricks retornar HTTP 403, THEN THE Databricks_OAuth_Service SHALL classificar a falha como um erro de permissão insuficiente e SHALL excluir o corpo dessa resposta HTTP de todo log e de toda mensagem de erro.
3. IF a resposta do Unity_Catalog_API retornar HTTP 429, THEN THE Databricks_Discovery_Service SHALL classificar a falha como um erro de limite de taxa e SHALL excluir o corpo dessa resposta HTTP de todo log e de toda mensagem de erro. IF a resposta do endpoint de token do Databricks retornar HTTP 429, THEN THE Databricks_OAuth_Service SHALL classificar a falha como um erro de limite de taxa e SHALL excluir o corpo dessa resposta HTTP de todo log e de toda mensagem de erro. WHEN o cabeçalho `Retry-After` estiver presente em uma dessas respostas HTTP 429, THE Databricks_Discovery_Service e THE Databricks_OAuth_Service SHALL incluir o valor desse cabeçalho na falha classificada retornada ao chamador, e SHALL NOT emitir automaticamente uma nova requisição equivalente antes do intervalo indicado por esse valor.
4. IF a resposta do Unity_Catalog_API retornar um status HTTP 5xx, ou a requisição ao Unity_Catalog_API não for concluída dentro de 10 segundos, THEN THE Databricks_Discovery_Service SHALL classificar a falha como um erro de indisponibilidade temporária e SHALL excluir o corpo de toda resposta HTTP recebida dessa requisição de todo log e de toda mensagem de erro. IF a resposta do endpoint de token do Databricks retornar um status HTTP 5xx, ou a requisição ao endpoint de token não for concluída dentro de 10 segundos, THEN THE Databricks_OAuth_Service SHALL classificar a falha como um erro de indisponibilidade temporária e SHALL excluir o corpo de toda resposta HTTP recebida dessa requisição de todo log e de toda mensagem de erro.
5. THE Databricks_Discovery_Service SHALL aplicar um timeout de 10 segundos a cada requisição de descoberta ao Unity_Catalog_API. THE Databricks_OAuth_Service SHALL aplicar um timeout de 10 segundos a cada requisição ao endpoint de token do Databricks realizada durante uma descoberta de combos.
6. IF o workspace host de uma requisição de descoberta não estiver presente na allowlist de hosts SaaS configurada e nenhuma liberação administrativa para hosts privados estiver configurada, THEN THE Databricks_Discovery_Service SHALL rejeitar a requisição de descoberta antes de emitir qualquer chamada de rede ao Unity_Catalog_API ou ao endpoint de token do Databricks.

### Requirement 9: Observabilidade e contabilização de tokens

**User Story:** Como administrador de uma organização, eu quero ver o uso de tokens e a latência de execuções Databricks registrados com precisão, sem que o Paperclip invente dados que o Databricks não forneceu, para que eu possa confiar na contabilização exibida.

#### Acceptance Criteria

1. WHEN uma execução com provedor `databricks` atingir um estado terminal (sucesso, falha, cancelamento ou timeout), THE Codex_Local_Adapter SHALL registrar o identificador de provedor `databricks`, o identificador do combo selecionado, a contagem de tokens de entrada informada, a contagem de tokens de saída informada, a latência da execução em milissegundos medida desde o início da chamada ao Unity_Gateway até o estado terminal e, quando uma resposta HTTP da chamada ao Unity_Gateway tiver sido recebida, o código de status HTTP dessa resposta.
2. THE Codex_Local_Adapter SHALL excluir valores de Client_Secret e de Access_Token de todo registro de execução gravado.
3. IF a resposta do Unity_Gateway não informar a contagem de tokens de entrada, a contagem de tokens de saída ou a contagem de tokens em cache, THEN THE Codex_Local_Adapter SHALL registrar a contagem correspondente como ausente no registro de execução, sem atribuir o valor zero ou qualquer valor estimado.
4. IF os metadados da resposta do Unity_Gateway incluírem uma contagem de tokens em cache, THEN THE Codex_Local_Adapter SHALL registrar essa contagem de tokens em cache informada.
5. IF uma falha de rede impedir que qualquer resposta HTTP seja recebida da chamada ao Unity_Gateway, THEN THE Codex_Local_Adapter SHALL registrar essa execução sem um valor de status HTTP e SHALL registrar uma indicação de que nenhuma resposta foi recebida do Unity_Gateway.
6. IF os metadados ou a telemetria da resposta do Unity_Gateway não informarem um destino de modelo interno, THEN THE Codex_Local_Adapter SHALL registrar a execução sem um valor de destino de modelo interno.
7. IF os metadados ou a telemetria da resposta do Unity_Gateway informarem de forma confiável um destino de modelo interno, THEN THE Codex_Local_Adapter SHALL registrar esse destino de modelo interno informado.
