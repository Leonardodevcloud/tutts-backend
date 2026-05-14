# Módulo `logistics` — Hub multi-provider

Hub logístico extensível da Central Tutts. Orquestra integrações com parceiros (Uber Direct, 99 Corp, futuros) sob uma API canônica única.

> **Status atual: Fase 0** — setup, contratos, tabelas e backfill prontos. Operações de cotação/despacho ainda não estão ligadas (retornam HTTP 501). Worker dorme. O módulo `uber/` legado continua atendendo o tráfego em produção sem mudança alguma.
>
> Documento de arquitetura completo: `LOGISTICS_HUB_ARCHITECTURE.md` (na raiz da entrega).

## Princípio

> O core não conhece nenhum provider. Cada provider conhece apenas o core.

```
contracts/   ← O quê todo provider precisa entregar (interface canônica)
core/        ← Como o hub orquestra (Orchestrator, Registry, EventLogger…)
adapters/    ← Quem fala cada API externa (Fase 1: uber/, Fase 3: ninety_nine/)
routes/      ← API HTTP canônica (provider-agnóstica)
worker/      ← Polling Mapp + decisão de despacho
```

## O que existe agora (Fase 0)

```
src/modules/logistics/
├── index.js                          # entrypoint
├── logistics.migration.js            # 7 tabelas + backfill de uber_*
├── logistics.routes.js               # router /api/logistics/* (rotas op. retornam 501)
├── logistics.shared.js               # WS events, dispatch strategies, helpers
│
├── contracts/
│   ├── CanonicalStatus.js            # enum único de status + STATUS_TO_MAPP_ACTION
│   ├── CanonicalTypes.js             # JSDoc dos tipos (Quote, Delivery, Event, ...)
│   └── LogisticsProviderAdapter.js   # classe base abstrata
│
├── core/
│   ├── ProviderRegistry.js           # singleton — descobre/instancia adapters
│   ├── EventLogger.js                # logistics_events INSERT centralizado
│   ├── MappClient.js                 # STUB — extração na Fase 1
│   └── AddressParser.js              # STUB — extração na Fase 1
│
└── docs/
    └── README.md                     # este arquivo
```

## Tabelas criadas

| Tabela | Propósito | Substitui |
| --- | --- | --- |
| `logistics_providers` | Cadastro de parceiros (config, capabilities, segredos) | `uber_config` |
| `logistics_deliveries` | Entregas (provider-agnósticas) | `uber_entregas` |
| `logistics_events` | Auditoria/eventos centralizados | `uber_webhooks_log` (e generalizado) |
| `logistics_tracking` | Posições do entregador | `uber_tracking` |
| `logistics_oauth_tokens` | Tokens OAuth (Uber, futuros) | `uber_oauth_token` |
| `logistics_dispatch_rules` | Regras de despacho com `providers_preferidos[]` | `uber_regras_cliente` |
| `logistics_worker_state` | Cursor de polling do worker | `uber_config.worker_ultimo_id` |

**Tabelas `uber_*` continuam intactas.** Migration é não-destrutiva.

## Backfill automático (idempotente)

Ao subir o módulo pela primeira vez:
- `uber_config` → `logistics_providers` (1 linha, `provider_code='uber'`, `ativo=false`)
- `uber_regras_cliente` → `logistics_dispatch_rules` (com `providers_preferidos=['uber']`)
- `uber_oauth_token` (tokens ainda válidos) → `logistics_oauth_tokens`
- `uber_config.worker_ultimo_id` → `logistics_worker_state`

Rodar de novo é seguro: tudo usa `ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS`.

## API HTTP

### Endpoints já funcionais

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/api/logistics/health` | Status do módulo + providers ativos |
| `GET` | `/api/logistics/providers` | Lista providers (sem segredos) |
| `GET` | `/api/logistics/providers/:code` | Config de 1 provider (segredos mascarados) |

### Endpoints com 501 Not Implemented (Fase 1)

Todos os endpoints de cotação, despacho, cancelamento, métricas, eventos e dispatch rules. Eles existem no router mas devolvem payload explicativo:

```json
{
  "error": "not_implemented",
  "message": "Endpoint em desenvolvimento — disponível a partir da Fase 1",
  "rota": "POST /api/logistics/quotes",
  "fase_atual": "Fase 0 (Setup e contratos)"
}
```

### Webhook

`POST /api/logistics/webhook/:provider` **NÃO está montado nesta fase.** Será ativado na Fase 1 (junto com o UberAdapter). O webhook `/api/uber/webhook` legado continua funcionando.

## Como adicionar um adapter (referência)

Fluxo completo será documentado em `ADDING_NEW_PROVIDER.md` na Fase 1. Por ora, o esqueleto é:

```js
// src/modules/logistics/adapters/meuprovider/MeuProviderAdapter.js
const { LogisticsProviderAdapter } = require('../../contracts/LogisticsProviderAdapter');

class MeuProviderAdapter extends LogisticsProviderAdapter {
  get providerCode() { return 'meuprovider'; }
  get displayName()  { return 'Meu Provider'; }

  capabilities() {
    return {
      ...super.capabilities(),
      webhookAuthScheme: 'bearer',
      vehicleTypes: ['motorcycle'],
    };
  }

  async healthCheck() { /* ... */ }
  async createQuote(req)            { /* traduz, chama HTTP, retorna CanonicalQuote */ }
  async createDelivery(quote, req)  { /* ... */ }
  async cancelDelivery(extId)       { /* ... */ }
  async getDelivery(extId)          { /* ... */ }
  async validateWebhookSignature(req) { /* ... */ }
  parseWebhookEvent(payload)        { /* retorna CanonicalEvent */ }
  nativeToCanonical(nativeStatus)   { /* mapping table */ }
}

module.exports = { MeuProviderAdapter };
```

Depois, em `index.js`:

```js
const { MeuProviderAdapter } = require('./adapters/meuprovider/MeuProviderAdapter');
registry.registerClass('meuprovider', MeuProviderAdapter);
```

E inserir 1 linha em `logistics_providers` via UI ou SQL.

## Status canônico (resumo)

Vide `CANONICAL_STATUS.md` (Fase 1). Os 14 valores são:

`PENDING, QUOTED, DISPATCHED, COURIER_ASSIGNED, PICKUP_EN_ROUTE, ARRIVED_PICKUP, PICKED_UP, DROPOFF_EN_ROUTE, ARRIVED_DROPOFF, DELIVERED, CANCELED, RETURNED, FAILED, FALLBACK_QUEUE`

Cada adapter mantém seu `nativeToCanonical()` próprio.

## Decisão tomada nesta fase

- `provider_code` da 99 será **`'noventanove'`** internamente, com `display_name = '99'`. Razão: snake_case minúsculo sem dígito inicial, consistência com outros parceiros futuros (`lalamove`, `loggi`). Display sempre será "99" na UI.

## Próximos passos

| Fase | Entregável | Tempo estimado |
| --- | --- | --- |
| **Fase 1** | UberAdapter + extração MappClient/AddressParser + Orchestrator (estratégia única) + webhook `/api/logistics/webhook/uber` + cutover do worker | 5–7 dias |
| **Fase 2** | `/api/uber/*` vira alias do hub (frontend não precisa mudar) | 2 dias |
| **Fase 3** | NinetyNineAdapter | 7–10 dias |
| **Fase 4** | Estratégias multi-provider (`fallback`, `melhor_preco`, `melhor_eta`) | 5 dias |
| **Fase 5** | Frontend renomeado + provider switcher | 5 dias |
| **Fase 6** | Sunset Uber legado (60 dias após Fase 5) | 1–2 dias |
