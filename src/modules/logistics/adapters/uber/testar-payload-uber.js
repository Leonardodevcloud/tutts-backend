/**
 * testar-payload-uber.js
 * Mostra o payload que a Central envia pra Uber Direct, SEM enviar nada.
 * Use pra conferir o formato (e mandar o output pro time da Uber, se quiser).
 *
 *   node src/modules/logistics/adapters/uber/testar-payload-uber.js
 */

const {
  montarBodyQuote,
  montarBodyDelivery,
  servicoMappToCanonicalQuoteRequest,
} = require('./uber.parser');

// Config de exemplo (equivale ao logistics_providers.config da Uber no banco)
const config = {
  manifest_total_value_centavos: 10000,
  telefone_suporte: '71999999999',
  uber_item_weight_g: 1000,
  uber_item_length_cm: 20,
  uber_item_height_cm: 20,
  uber_item_depth_cm: 20,
};

// Servico Mapp de exemplo — dados propositalmente "sujos" pra exercitar os ajustes:
//  - nome de coleta "eeee" (placeholder)  -> deve virar fallback ("Loja")
//  - endereco com "N 1816"                -> deve sair sem o "N"
//  - complemento + obs na entrega         -> dropoff_notes junta os dois
const servico = {
  codigoOS: '123456',
  endereco: [
    { rua: 'Rua das Flores, N 1816, Centro, Goiania - GO - 74000-000', nome: 'eeee',
      telefone: '71988887777', complemento: '', obs: 'Retirar no balcao', latitude: -16.68, longitude: -49.25 },
    { rua: 'Av. Brasil, 500, Setor Sul, Goiania - GO - 74000-100', nome: 'Maria Silva',
      telefone: '71977776666', complemento: 'Apto 302', obs: 'Deixar na portaria', latitude: -16.70, longitude: -49.26 },
  ],
};

const req = servicoMappToCanonicalQuoteRequest(servico);

console.log('\n===== QUOTE (POST /delivery_quotes) =====');
const quote = montarBodyQuote(req, config);
console.log(JSON.stringify(quote, null, 2));

console.log('\n===== CREATE (POST /deliveries) =====');
const { body } = montarBodyDelivery('quote_exemplo_id', req, config, false);
console.log(JSON.stringify(body, null, 2));

// ---- Checagens automaticas dos itens que a Uber pediu ----
console.log('\n===== CHECAGENS =====');
const item = body.manifest_items[0];
const pickupStreet = JSON.parse(body.pickup_address).street_address;
const check = (nome, ok) => console.log((ok ? 'OK  ' : 'FALHA ') + nome);

check('Item 2 - dropoff_notes preenchido', !!body.dropoff_notes && body.dropoff_notes.length > 0);
check('Item 3 - street_address e array de ate 2', Array.isArray(pickupStreet) && pickupStreet.length <= 2);
check('Item 3 - sem "N" antes do numero', !/\bN\s+\d/.test(pickupStreet.join(' ')));
check('Item 4 - pickup_name nao e placeholder', body.pickup_name !== 'eeee');
check('Item 5 - manifest SEM size', !('size' in item));
check('Item 5 - manifest COM weight+dimensions', ('weight' in item) && ('dimensions' in item));
check('Item 6 - quote tem manifest_total_value', 'manifest_total_value' in quote);
check('Item 6 - quote tem external_store_id', 'external_store_id' in quote);

console.log('\ndropoff_notes   =', JSON.stringify(body.dropoff_notes));
console.log('pickup_name     =', JSON.stringify(body.pickup_name));
console.log('street_address  =', JSON.stringify(pickupStreet));
console.log('manifest_item   =', JSON.stringify(item));
