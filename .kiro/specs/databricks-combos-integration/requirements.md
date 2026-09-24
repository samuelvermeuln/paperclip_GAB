# Requirements Document

## Databricks Unity Gateway Combos Integration

## Introduction

Paperclip companies run agents through the existing `codex_local` adapter. Today the only model
provider available to that adapter is OpenAI. Some companies route their LLM traffic through a
Databricks Unity Gateway "combo" (a Model Service that encapsulates routing, fallback, and cost
policy across one or more underlying models). This feature lets a company connect a Databricks
workspace to Paperclip and select one of that workspace's combos as the model for a `codex_local`
agent, with the combo list discovered live from the workspace rather than hardcoded or manually
duplicated into Paperclip. The feature is scoped to discovery and execution of existing combos; it
does not let Paperclip create, edit, or otherwise manage combos inside Databricks.

This document derives formal, testable requirements from `design.md`, and treats the source
specification's Section 13 ("Critérios de aceite") as the included-scope baseline and Section 14
("Fora do MVP") as the explicit exclusion baseline.

## Glossary

- **Combo**: A Databricks Unity Catalog Model Service that encapsulates routing, fallback, and
  cost policy across one or more underlying models. Identified by a qualified id such as
  `main.paperclip.combo_ux` after the `model-services/` resource-name prefix is stripped.
- **Model Service**: The Unity Catalog resource type backing a Combo, discovered via the
  `GET /api/2.1/unity-catalog/model-services` endpoint.
- **Unity Catalog**: The Databricks workspace's governance layer that registers and exposes
  Model Services (Combos) under a `catalog.schema` namespace.
- **PAT (Personal Access Token)**: The Databricks personal access token used as the credential
  for the `api_key` authentication method on a Databricks AI Connection.
- **AI Connection**: A Paperclip-managed, company-scoped credential and configuration record
  (e.g. `provider: "databricks"`) that lets an agent adapter authenticate to an external model
  provider.
- **Grant**: A company-scoped authorization record that determines which actors may use a given
  AI Connection. A grant is either personal (owned by a single actor) or shared (available to an
  audience of actors within the company).
- **Company-scoped**: Restricted so that a resource (connection, grant, cached discovery result,
  credential) is only visible to and usable by the company that owns it, never across companies.
- **Discovery**: The process of querying a Databricks workspace's Unity Catalog for the current
  list of Model Services (Combos) available to a given AI Connection.
- **TTL/Cache**: The time-to-live-bounded (60-second) server-side and client-side cache of a
  discovery result, keyed by connection and query parameters, bypassed on demand via a refresh
  flag or when it expires.

## Requirements

### Requirement 1: Databricks as an AI Connection provider

**User Story:** As a company administrator, I want to add a Databricks workspace as an AI
Connection, so that my `codex_local` agents can use Databricks combos as their model without any
code change.

#### Acceptance Criteria

1. WHEN an administrator creates an AI Connection with `provider: "databricks"` and
   `method: "api_key"` THEN the system SHALL store the PAT via the existing secret-storage path
   used by other `api_key` AI Connections, and SHALL NOT accept `method: "subscription"` for this
   provider.
2. WHEN an administrator submits a Databricks connection with a `workspaceHost` that is not an
   `https://` origin (i.e. it includes `http://`, a path, a query string, a fragment, or userinfo)
   THEN the system SHALL reject the request with a `422` validation error and SHALL NOT persist the
   connection.
3. WHEN an administrator submits a Databricks connection with a valid `https://` host THEN the
   system SHALL normalize and persist only the origin (scheme + host \[+ port\]).
4. IF the deployment is a SaaS environment AND the submitted workspace host is not on the
   configured allowlist THEN the system SHALL reject connection creation, UNLESS an administrator
   has explicitly enabled private/self-hosted hosts for that deployment.
5. WHEN a Databricks connection is created, edited, or revoked THEN the system SHALL write an
   activity log entry for that mutation, consistent with every other mutating AI Connection action.
6. WHEN a Databricks connection's PAT is stored or resolved THEN the system SHALL NOT return the
   token value in any API response, including the connection's own read/list endpoints.

### Requirement 2: Combo discovery via Unity Catalog Model Services

**User Story:** As an agent operator, I want the combo selector to reflect exactly what exists in
my Databricks workspace right now, so that a newly created combo is usable without a Paperclip
code change or restart.

#### Acceptance Criteria

1. WHEN the system discovers combos for a connection THEN it SHALL call
   `GET /api/2.1/unity-catalog/model-services` with `parent=schemas/<catalog>.<schema>`,
   `page_size=100`, and `view=BASIC`, and SHALL NOT call `GET /api/2.0/serving-endpoints` for this
   purpose.
2. WHEN a discovery response includes `next_page_token` THEN the system SHALL continue requesting
   subsequent pages using that token until a response omits `next_page_token`, and SHALL return the
   union of all pages' `model_services`.
3. WHEN normalizing a discovered resource name of the form `model-services/<id>` THEN the system
   SHALL strip only the `model-services/` prefix and SHALL persist/return `<id>` unmodified
   otherwise (e.g. `model-services/main.paperclip.combo_ux` becomes `main.paperclip.combo_ux`).
4. WHEN deriving a display label for a combo id THEN the system SHALL take the last
   dot-separated segment, strip a leading `combo`/`combo_`/`combo-` token (case-insensitive),
   replace remaining separators with spaces, and title-case the result (e.g. `combo_ux` becomes
   `Combo UX`-style formatting per the normalization rule in `design.md`).
5. WHEN the discovery result set contains duplicate ids THEN the system SHALL de-duplicate by id
   before returning the list.
6. WHEN returning the combo list THEN the system SHALL sort entries by their display label.
7. IF a connection specifies an optional `modelPrefix` THEN the system SHALL exclude any combo
   whose short name does not start with that prefix.
8. IF a discovered resource's catalog/schema does not match the connection's configured
   `catalog`/`schema` THEN the system SHALL exclude it from the result, even if the Databricks API
   response included it.
9. WHEN a caller requests discovery with `refresh=1` THEN the system SHALL bypass any cached result
   for that connection and re-query Databricks, then repopulate the cache with the fresh result.
10. WHEN a caller requests discovery without `refresh=1` and a non-expired cache entry exists for
    the exact same `(companyId, connectionId, host, catalog, schema, modelPrefix)` key THEN the
    system SHALL return the cached result without calling Databricks.
11. WHEN a cache entry is older than 60 seconds THEN the system SHALL treat it as expired and SHALL
    query Databricks again on the next request for that key.

### Requirement 3: Company- and grant-scoped access control

**User Story:** As a company administrator, I want Databricks combo discovery and execution to
respect the same organizational boundaries as every other Paperclip resource, so that one
company's agents can never see or use another company's Databricks combos.

#### Acceptance Criteria

1. WHEN a discovery or execution request references a `connectionId` that does not belong to the
   requesting `companyId` THEN the system SHALL respond as if the connection does not exist (404 /
   `connection_missing`) and SHALL NOT reveal that the connection exists in a different company.
2. WHEN the requesting actor has no usable grant (personal grant not owned by them, or shared
   grant outside their audience) on an otherwise-valid Databricks connection THEN the system SHALL
   deny the request with a `403` and SHALL NOT perform discovery or execution.
3. WHEN a Databricks connection has been revoked THEN the system SHALL deny both discovery and
   execution requests against it with a `409`-class error, and SHALL NOT serve a previously cached
   discovery result for that connection.
4. WHEN a Databricks connection is edited or revoked THEN the system SHALL invalidate any cached
   discovery results associated with that `connectionId`.
5. WHEN resolving a Databricks credential for any request THEN the system SHALL NOT fall back to
   a different company's connection, a different connection's cached credential, or any
   instance-level/global Databricks credential.

### Requirement 4: No silent fallback to OpenAI

**User Story:** As a company administrator relying on Databricks for cost/governance control, I
want any Databricks failure to be visible and blocking, so that spend never silently shifts to an
unmanaged OpenAI call.

#### Acceptance Criteria

1. IF Databricks discovery fails for any reason (invalid credential, insufficient permission,
   rate limit, timeout, or 5xx) THEN the system SHALL return an error to the caller and SHALL NOT
   substitute OpenAI's model list in the response.
2. IF an agent's persisted combo id is no longer present in a fresh discovery result THEN the
   system SHALL mark that agent's model selection as unavailable and SHALL block starting a new run
   for that agent until a valid combo is re-selected, rather than silently switching the run to an
   OpenAI model.
3. IF the Databricks Unity Gateway is unreachable or returns an error at execution time (not just
   discovery time) THEN the run SHALL fail with that error surfaced, and the system SHALL NOT retry
   the same run against an OpenAI provider.
4. The UI combo/model selector SHALL NOT present OpenAI models and Databricks combos in the same
   list for a single agent at the same time.

### Requirement 5: Secret handling

**User Story:** As a security-conscious operator, I want the Databricks PAT to never leave
server-side storage in the clear, so that a logging or API mistake cannot leak workspace access.

#### Acceptance Criteria

1. The system SHALL NOT persist the Databricks token in `adapterConfig`, in the generated
   `config.toml` literal values, in run events, in activity log entries, or in any API response
   body.
2. The system SHALL write the token only into the spawned Codex process's environment
   (`DATABRICKS_TOKEN`) for the duration of a single run, and SHALL remove or let expire that
   environment when the run's process ends.
3. WHEN generating the per-run Codex provider configuration THEN the system SHALL reference the
   token only via `env_key = "DATABRICKS_TOKEN"` indirection, and SHALL NOT inline the literal
   token value into `config.toml`.
4. The system SHALL NOT include the token value in any log line, error message, or telemetry event
   emitted by discovery, credential resolution, or execution code paths.
5. WHEN a run completes (success, failure, or crash before cleanup) THEN the system SHALL restore
   `config.toml` to its pre-run state on the next run preparation, consistent with existing
   `codex_local` runtime-config restore behavior.

### Requirement 6: Codex execution via Unity Gateway

**User Story:** As an agent operator, I want my selected combo to actually be the model Codex
calls, so that execution matches what I configured.

#### Acceptance Criteria

1. WHEN a `codex_local` agent's `adapterConfig.modelProvider` is `"databricks"` THEN the system
   SHALL generate a per-run Codex model-provider entry with `base_url` equal to
   `https://<workspace-host>/ai-gateway/codex/v1` and `wire_api = "responses"`.
2. WHEN executing such a run THEN the system SHALL set the Codex `model` field to exactly the
   persisted combo id (the qualified name with the `model-services/` prefix already removed),
   unmodified.
3. WHEN a Databricks provider is active for a run THEN the system SHALL NOT require
   `OPENAI_API_KEY` to be present for the run to be considered credential-ready; readiness SHALL be
   satisfied by a non-empty `DATABRICKS_TOKEN` instead.
4. WHEN a run using a non-Databricks provider is prepared THEN the existing `OPENAI_API_KEY` /
   `auth.json` readiness behavior SHALL remain unchanged.

### Requirement 7: Contract synchronization across layers

**User Story:** As a maintainer, I want the Databricks integration's data shapes to be consistent
across the codebase, so that a schema or behavior change in one layer cannot silently break
another.

#### Acceptance Criteria

1. WHEN `packages/shared` adds the `databricks` AI Connection provider and capability entry THEN
   `server` route/service validation, `ui` connection forms, and any `packages/db`-backed
   persistence SHALL use that same shared definition rather than a duplicated local one.
2. WHEN `packages/adapter-utils` adds `AdapterModelDiscoveryContext` THEN every existing
   `ServerAdapterModule.listModels`/`refreshModels` implementation SHALL remain valid without
   modification (the parameter is optional), and the `codex_local` implementation SHALL be the
   only one that reads Databricks-specific fields from it in this scope.
3. WHEN the UI requests adapter models with `provider=databricks` THEN it SHALL also supply
   `connectionId`, and the server SHALL require `connectionId` whenever `provider=databricks` is
   present, returning a `422` if it is missing.

### Requirement 8: User interface for provider, connection, and combo selection

**User Story:** As an agent operator, I want a clear way to pick Databricks as my model provider,
choose a connection, and pick a combo, so that configuring a Databricks-backed agent feels the
same as configuring any other model choice.

#### Acceptance Criteria

1. WHEN an operator selects "Databricks Unity Gateway" as the model provider for a `codex_local`
   agent THEN the UI SHALL require a valid Databricks connection to be selected before it fetches
   or displays any combos.
2. WHEN the combo selector is opened THEN the UI SHALL fetch the current combo list for the
   selected connection.
3. WHEN an operator clicks "Refresh combos" THEN the UI SHALL request discovery with the
   cache-bypassing refresh flag and SHALL update the displayed list from that response.
4. WHEN `adapterConfig.modelProvider` is `"databricks"` THEN the UI SHALL relabel the model field
   as "Combo" instead of "Model".
5. IF an agent's saved combo id is absent from the current discovery result THEN the UI SHALL still
   display that id in the selector, labeled "Indisponível"/"Unavailable", and SHALL prevent
   starting a new run for that agent until a different, valid combo is selected.
6. The UI SHALL apply a client-side cache of at most 60 seconds for a given provider/connection
   combination, consistent with the server-side TTL, and a manual refresh SHALL always bypass it.

### Requirement 9: Observability without secret exposure

**User Story:** As an operator, I want to see which combo and provider a run used, and diagnose
failures, without any risk of exposing the workspace token.

#### Acceptance Criteria

1. WHEN a run using the Databricks provider completes THEN the system SHALL record provider
   (`databricks`), the combo id used, input/output token counts, latency, and HTTP status, using
   the same run-log path used for other providers' runs.
2. IF Databricks reports cached-token counts in its response metadata THEN the system MAY record
   them; the system SHALL NOT fabricate a cached-token value when Databricks does not report one.
3. The system SHALL NOT infer or display which underlying model the combo routed to unless
   Databricks reliably provides that value in response metadata or telemetry; it SHALL NOT invent
   this value.
4. Errors recorded for a failed Databricks discovery or execution SHALL be classified consistently
   with Requirement 10 below, and SHALL NOT contain the token value.

### Requirement 10: Consistent HTTP error mapping

**User Story:** As a developer integrating with or debugging this feature, I want Databricks
failure modes to map to predictable, standard HTTP statuses, so that clients can handle them
without provider-specific guesswork.

#### Acceptance Criteria

1. WHEN Databricks responds `401` to a discovery or execution call THEN the system SHALL surface
   this as an invalid-credential condition (`401` to the Paperclip API caller).
2. WHEN Databricks responds `403` THEN the system SHALL surface this as an insufficient-permission
   condition (`403` to the Paperclip API caller).
3. WHEN Databricks responds `429` THEN the system SHALL surface this as a rate-limit condition
   (`429`), and SHALL echo the `Retry-After` header value when Databricks provides one.
4. WHEN Databricks responds with any `5xx` status, or the request times out, or a network error
   occurs THEN the system SHALL surface this as a temporary-unavailability condition distinct from
   Paperclip's own internal errors.
5. WHEN a discovery or connection-create request supplies a malformed or disallowed workspace host
   THEN the system SHALL respond `422`.
6. WHEN a discovery request references a connection the actor cannot use per Requirement 3 THEN the
   system SHALL respond with the status defined in Requirement 3 for that condition (`403`, `404`,
   or `409` as applicable), not a generic `500`.

### Requirement 11: Performance and quota-conscious discovery

**User Story:** As a company operator, I want combo discovery to be cheap and fast, so that it
does not add noticeable latency or LLM spend to configuring an agent.

#### Acceptance Criteria

1. Discovery calls SHALL use `view=BASIC` and SHALL NOT use `view=FULL`.
2. Discovery calls SHALL use `page_size=100` per request.
3. Discovery SHALL NOT invoke any LLM call.
4. The combo list SHALL NOT be included in any agent prompt or system message.
5. Each Databricks HTTP request made by discovery SHALL apply a 10-second timeout and a bounded
   response size limit.

## Out of Scope (MVP Exclusions)

The following are explicitly excluded from this feature and MUST NOT be implemented as part of
satisfying the acceptance criteria above, per the source specification's Section 14:

1. Creating or editing Databricks combos (Model Services) from within Paperclip. Paperclip only
   discovers and selects existing combos.
2. OAuth or machine-to-machine authentication with automatic token rotation for Databricks. Only
   PAT (`api_key` method) is supported in this scope.
3. Visualizing each combo's internal routing destinations or traffic-split percentages in the
   Paperclip UI.
4. Changing or influencing Databricks' own routing/fallback rules for a combo.
5. Real-time synchronization of the combo list via webhook; discovery is pull-based (on selector
   open, and on manual/TTL-based refresh) only.
6. Computing or displaying the real per-destination cost of a combo invocation when Databricks does
   not supply that data.

## Traceability to Design

Every requirement above maps to a concrete component in `design.md`:

- Requirement 1 → AI Connections contract extension, connection config storage.
- Requirement 2 → `databricks-model-services.ts`, `codex-models.ts`.
- Requirement 3 → `ai-connections.ts` (`resolveDatabricksCredential`), cache keying.
- Requirement 4 → `codex-models.ts` single-source selection, UI "Unavailable" handling.
- Requirement 5 → `ai-connection-runtime.ts`, `runtime-config.ts` env-key indirection.
- Requirement 6 → `runtime-config.ts`, `codex-home.ts` readiness branch.
- Requirement 7 → `packages/shared`, `packages/adapter-utils` contract changes.
- Requirement 8 → `AgentConfigForm.tsx`, `api/agents.ts`.
- Requirement 9 → run-log/observability integration (existing path, new fields only).
- Requirement 10 → `DatabricksDiscoveryError` mapping table in `design.md`.
- Requirement 11 → discovery client's request parameters and timeout/size limits.
