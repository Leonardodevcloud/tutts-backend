# Integração 99Entrega (Open Platform)

Documentação de referência da API da 99Entrega usada pelo Hub Logístico.

Adapter no código: `src/modules/logistics/adapters/noventanove/`

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| `API_Reference.txt` | Referência oficial dos endpoints (estimate, create order, order detail, cancel). Campos de request/response. |
| `Webhook.txt` | Eventos de webhook que a 99 envia (status da corrida, courier, etc.). |

## Mapa: doc → código

| Conceito na doc | Onde no código |
|---|---|
| `POST /v2/order/estimate` | `NinetyNineAdapter.getQuote` |
| `POST /v2/order/create` | `NinetyNineAdapter.createDelivery` + `noventanove.parser.js montarBodyCriacao` |
| `GET /v2/order/detail` | `NinetyNineAdapter.getDelivery` / `getProofOfDelivery` |
| `POST /v2/order/cancel` | `NinetyNineAdapter.cancelDelivery` |
| Webhook | `noventanove.webhook.js` |

## Códigos de verificação (pontos de atenção)

A 99 usa três códigos de 4 dígitos, retornados em `data.verify_info` no order/detail:

- `pickup_verify_code` — código de COLETA (remetente confirma)
- `dropoff_verify_code` — código de ENTREGA (destinatário confirma)
- `return_handover_code` — código de DEVOLUÇÃO (só quando a entrega falha e o pacote volta)

### Regras críticas (fonte de bugs)

1. **Default `true`**: `need_pickup_code` e `need_dropoff_code` têm default `true` na 99
   se NÃO enviados. Mas o parser SEMPRE envia explícito — então se a flag do painel
   estiver desligada, ele envia `false` e SOBRESCREVE o default. Resultado: sem a
   flag `verificacao_entrega_habilitada` ligada, a 99 nunca gera o `dropoff_code`.

2. **String vazia**: a 99 retorna `""` (não null) quando o código não é exigido.
   O adapter normaliza pra null.

3. **Devolução condicional**: `return_handover_code` só existe quando:
   - `return_type = 1` (devolver, não descartar) — default do parser
   - `return_handover_method = 3` (código) — requer `verificacao_devolucao_habilitada`
   - E a corrida REALMENTE entra em devolução (falha na entrega). Devolução é
     evento raro — a ausência de código não significa bug.

4. **Config do provider** (`logistics_providers.config` JSONB):
   - `verificacao_coleta_habilitada` / `need_pickup_code` → gera pickup_code
   - `verificacao_entrega_habilitada` / `need_dropoff_code` → gera dropoff_code
   - `verificacao_devolucao_habilitada` / `return_handover_99=3` → código na devolução
   - `return_type_99` (1=devolver, 2=descartar; default 1)

## Persistência

Os códigos ficam em `logistics_deliveries`:
- `pickup_code`, `dropoff_code`, `return_code`

Capturados pelo `TrackingPoller.js` (a 99 não tem webhook pra código — só o
order/detail traz). Expostos ao front por:
- Admin: mapeador em `logistics.routes.js`
- Portal cliente: `logistics/routes/portal.routes.js`
- solicitacao.html: objeto `hub.codigos` em `solicitacao/hub-status.shared.js`

## Histórico de investigação

- 2026-07: código de devolução/entrega não aparecia no front. Causa raiz:
  flag `verificacao_entrega_habilitada` desligada no provider (a 99 nunca gerava
  o dropoff_code); e devolução é evento raro. NÃO era bug de frontend, embora as
  telas também não renderizassem os códigos quando existentes.
