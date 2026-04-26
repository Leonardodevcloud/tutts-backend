/**
 * processar-planilha-bi.js
 * Lê o .xlsx baixado do sistema externo e aplica as transformações
 * que o Power Query do Excel "Tratar_Base.xlsm" fazia.
 *
 * Saída: array de objetos com 51 colunas, no formato que o endpoint
 *        POST /bi/entregas/upload espera.
 *
 * Transformações (espelha o Section1.m do Power Query):
 *   1. Lê aba "Serviços" do .xlsx, primeira linha = cabeçalho
 *   2. Seleciona 51 colunas relevantes (descarta 23)
 *   3. Cria coluna "Nome fantasia" condicional:
 *        - se cod_cliente em [225, 767, 997, 713, 1021, 1035, 1038, 1039,
 *          1040, 1041, 1042, 1043, 1046, 1056]: usa Centro custo
 *        - senão: mantém Nome fantasia original
 *   4. Latitude/Longitude: troca "." por ","
 *   5. Execução Comp/Espera/Espera P1: remove "-" sozinho (vira "")
 *   6. Velocidade Média: remove "-" sozinho (vira "")
 *
 * Não tipa colunas (deixa string). O endpoint do BI tem fallback robusto
 * que parseia int/float/data conforme precisa.
 */

'use strict';

const xlsx = require('xlsx');

// Códigos de cliente que usam "Centro custo" como Nome fantasia
const CLIENTES_TRATAR_NOME_FANTASIA = new Set([
  225, 767, 997, 713, 1021, 1035, 1038, 1039, 1040, 1041, 1042, 1043, 1046, 1056,
]);

// 51 colunas que vão pra base do BI (na ordem final do Power Query)
const COLUNAS_FINAIS = [
  'OS', 'Nº Pedido', 'Cód. cliente', 'Nome cliente', 'Empresa',
  'Nome fantasia', 'CPF/CNPJ', 'Solicitante', 'Filial', 'Centro custo',
  'Cidade P1', 'Endereço', 'Bairro', 'Obs endereço', 'Nº nota',
  'Valor nota', 'Latitude', 'Longitude', 'Cidade', 'Estado',
  'Cód. prof.', 'Nome prof.', 'Data/Hora', 'Data/Hora Alocado',
  'Data solicitado', 'Hora solicitado', 'Agendado', 'Info', 'Obs O.S',
  'Data Chegada', 'Hora Chegada', 'Data Saida', 'Hora Saida',
  'Assinatura - Nome', 'Assinatura - RG', 'Categoria', 'Valor',
  'Distância', 'Valor prof.', 'Valor liquido', 'Finalizado',
  'Tempo de espera (minutos)', 'Valor da espera', 'Execução Comp.',
  'Execução - Espera', 'Execução - Espera P1', 'Nota',
  'Tipo de Pagamento', 'Status', 'Motivo', 'Ocorrência', 'Velocidade Média',
];

/**
 * Lê o Excel e retorna array de objetos (1 por linha de dados),
 * com chaves no formato do cabeçalho original.
 */
function lerExcel(filepath) {
  const wb = xlsx.readFile(filepath, { cellDates: false, cellNF: false, cellText: true });
  const sheetName = 'Serviços';
  if (!wb.Sheets[sheetName]) {
    throw new Error(`Aba '${sheetName}' não encontrada. Abas disponíveis: ${wb.SheetNames.join(', ')}`);
  }
  const ws = wb.Sheets[sheetName];
  // raw=false → strings (como o Excel mostra). defval='' pra não pular células vazias.
  const linhas = xlsx.utils.sheet_to_json(ws, { defval: '', raw: false });
  return linhas;
}

/**
 * Transformação 5: remove "-" sozinho (linha tracejada do Excel)
 * Power Query M: Table.ReplaceValue(t, "-", "", Replacer.ReplaceText, {col})
 * Replacer.ReplaceText é REPLACE TOTAL (string igual a "-"), não substring.
 * Pra ser seguro, a gente só substitui se valor for EXATAMENTE "-".
 */
function removerHifen(valor) {
  if (valor === '-' || valor === ' - ' || (typeof valor === 'string' && valor.trim() === '-')) {
    return '';
  }
  return valor;
}

/**
 * Transformação 4: troca . por , (Latitude/Longitude → formato BR)
 * Replacer.ReplaceText em M é substituição de TEXTO (substring), não regex.
 * Aqui usa replace global mesmo.
 */
function pontoParaVirgula(valor) {
  if (valor == null || valor === '') return valor;
  return String(valor).replace(/\./g, ',');
}

/**
 * Aplica TODO o tratamento equivalente ao Power Query.
 * Retorna array de objetos com as 51 colunas.
 */
function tratarLinhas(linhasBrutas) {
  const resultado = [];
  for (const linha of linhasBrutas) {
    const out = {};

    // 1. Seleciona as 51 colunas (Power Query: Table.SelectColumns)
    for (const col of COLUNAS_FINAIS) {
      out[col] = linha[col] != null ? linha[col] : '';
    }

    // 2. Substituição condicional do Nome fantasia
    //    Power Query:
    //      "Nome fantasia ajuste" =
    //         if List.Contains(clientes_especiais, [Cód. cliente])
    //           then [Centro custo]
    //           else [Nome fantasia]
    //    Depois remove "Nome fantasia" e renomeia "Nome fantasia ajuste" → "Nome fantasia"
    const codCliente = parseInt(out['Cód. cliente'], 10);
    if (CLIENTES_TRATAR_NOME_FANTASIA.has(codCliente)) {
      out['Nome fantasia'] = out['Centro custo'] || '';
    }
    // (else: mantém o Nome fantasia que veio da bruta)

    // 3. Latitude/Longitude: ponto → vírgula
    out['Latitude']  = pontoParaVirgula(out['Latitude']);
    out['Longitude'] = pontoParaVirgula(out['Longitude']);

    // 4. Execução Comp/Espera/Espera P1: remove "-"
    out['Execução Comp.']        = removerHifen(out['Execução Comp.']);
    out['Execução - Espera']     = removerHifen(out['Execução - Espera']);
    out['Execução - Espera P1']  = removerHifen(out['Execução - Espera P1']);

    // 5. Velocidade Média: remove "-"
    out['Velocidade Média']      = removerHifen(out['Velocidade Média']);

    resultado.push(out);
  }
  return resultado;
}

/**
 * Mapeia o objeto com chaves do Excel ("Nome cliente", "Cód. cliente"...)
 * pra chaves snake_case que o endpoint /bi/entregas/upload espera.
 *
 * IMPORTANTE: o endpoint ATUAL já tem fallback que entende AMBAS as formas
 * (chaves Excel e snake_case). Mas aqui mando snake_case pra ser explícito
 * e consistente.
 */
function paraSnakeCase(linhasTratadas) {
  return linhasTratadas.map(e => ({
    os:                          e['OS'],
    num_pedido:                  e['Nº Pedido'],
    cod_cliente:                 e['Cód. cliente'],
    nome_cliente:                e['Nome cliente'],
    empresa:                     e['Empresa'],
    nome_fantasia:               e['Nome fantasia'],
    cpf_cnpj:                    e['CPF/CNPJ'],
    solicitante:                 e['Solicitante'],
    filial:                      e['Filial'],
    centro_custo:                e['Centro custo'],
    cidade_p1:                   e['Cidade P1'],
    endereco:                    e['Endereço'],
    bairro:                      e['Bairro'],
    obs_endereco:                e['Obs endereço'],
    num_nota:                    e['Nº nota'],
    valor_nota:                  e['Valor nota'],
    latitude:                    e['Latitude'],
    longitude:                   e['Longitude'],
    cidade:                      e['Cidade'],
    estado:                      e['Estado'],
    cod_prof:                    e['Cód. prof.'],
    nome_prof:                   e['Nome prof.'],
    data_hora:                   e['Data/Hora'],
    data_hora_alocado:           e['Data/Hora Alocado'],
    data_solicitado:             e['Data solicitado'],
    hora_solicitado:             e['Hora solicitado'],
    agendado:                    e['Agendado'],
    info:                        e['Info'],
    obs_os:                      e['Obs O.S'],
    data_chegada:                e['Data Chegada'],
    hora_chegada:                e['Hora Chegada'],
    data_saida:                  e['Data Saida'],
    hora_saida:                  e['Hora Saida'],
    assinatura_nome:             e['Assinatura - Nome'],
    assinatura_rg:               e['Assinatura - RG'],
    categoria:                   e['Categoria'],
    valor:                       e['Valor'],
    distancia:                   e['Distância'],
    valor_prof:                  e['Valor prof.'],
    valor_liquido:               e['Valor liquido'],
    finalizado:                  e['Finalizado'],
    tempo_espera_minutos:        e['Tempo de espera (minutos)'],
    valor_espera:                e['Valor da espera'],
    execucao_comp:               e['Execução Comp.'],
    execucao_espera:             e['Execução - Espera'],
    execucao_espera_p1:          e['Execução - Espera P1'],
    nota:                        e['Nota'],
    tipo_pagamento:              e['Tipo de Pagamento'],
    status:                      e['Status'],
    motivo:                      e['Motivo'],
    ocorrencia:                  e['Ocorrência'],
    velocidade_media:            e['Velocidade Média'],
  }));
}

/**
 * Pipeline completo: arquivo → JSON pronto pra POST.
 */
function processarArquivo(filepath) {
  const brutas = lerExcel(filepath);
  const tratadas = tratarLinhas(brutas);
  const formatoEndpoint = paraSnakeCase(tratadas);
  return {
    total: brutas.length,
    entregas: formatoEndpoint,
  };
}

module.exports = {
  processarArquivo,
  lerExcel,
  tratarLinhas,
  paraSnakeCase,
  CLIENTES_TRATAR_NOME_FANTASIA,
  COLUNAS_FINAIS,
};
