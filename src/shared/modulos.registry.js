/**
 * modulos.registry.js (2026-07) — FASE 1 do refactor de permissoes
 * ---------------------------------------------------------------------------
 * FONTE DE VERDADE unica do catalogo de modulos do sistema.
 *
 * Nesta fase o registry e DESCRITIVO (identidade + UI + abas) e esta INERTE:
 * nada importa ele ainda. Ele existe para, nas proximas fases, aposentar os
 * hardcodes duplicados (SISTEMA_MODULOS_CONFIG no app.js e o mapa manual do login).
 *
 * Gerado a partir do SISTEMA_MODULOS_CONFIG real (bate 100%).
 *
 * Campos de ROTEAMENTO (mountAt, ownedPaths, roles, mount) NAO estao aqui de
 * proposito — entram na Fase 3, com verificacao rota-a-rota contra o server.js,
 * pra nao arriscar trancar ninguem fora da API.
 *
 * Cada item:
 *   id             slug canonico (bate com users.allowed_modules e o front)
 *   label / icon   exibicao no menu e na tela de permissoes
 *   ordem          posicao no menu
 *   soAdmin        modulo marcado como admin-only no catalogo original
 *   sempreLiberado nunca restringivel (roadmap, confirmafacil)
 *   abas           sub-abas [{id,label}] para nav + permissao granular
 */

'use strict';

const MODULOS = [
  {
    "id": "solicitacoes",
    "label": "Solicitações",
    "icon": "📋",
    "ordem": 10,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "dashboard",
        "label": "Dashboard"
      },
      {
        "id": "search",
        "label": "Busca"
      },
      {
        "id": "ranking",
        "label": "Ranking"
      },
      {
        "id": "relatorios",
        "label": "Relatórios"
      }
    ]
  },
  {
    "id": "financeiro",
    "label": "Financeiro",
    "icon": "💰",
    "ordem": 20,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "home-fin",
        "label": "🏠 Home"
      },
      {
        "id": "solicitacoes",
        "label": "📋 Solicitações"
      },
      {
        "id": "limites",
        "label": "🔓 Limites"
      },
      {
        "id": "stark-bank",
        "label": "🏦 Pix Stark"
      },
      {
        "id": "acerto-prof",
        "label": "💼 Acerto Prof"
      },
      {
        "id": "conciliacao-acerto",
        "label": "📊 Conc. Acerto"
      },
      {
        "id": "validacao",
        "label": "✅ Validação"
      },
      {
        "id": "conciliacao",
        "label": "🔄 Conciliação"
      },
      {
        "id": "resumo",
        "label": "📑 Resumo"
      },
      {
        "id": "gratuidades",
        "label": "🎁 Gratuidades"
      },
      {
        "id": "restritos",
        "label": "🚫 Restritos"
      },
      {
        "id": "indicacoes",
        "label": "🤝 Indicações"
      },
      {
        "id": "promo-novatos",
        "label": "🎯 Promo Novatos"
      },
      {
        "id": "loja",
        "label": "🛒 Loja"
      },
      {
        "id": "relatorios",
        "label": "📈 Relatórios"
      },
      {
        "id": "horarios",
        "label": "⚙️ Configurações"
      },
      {
        "id": "avisos",
        "label": "📢 Avisos"
      },
      {
        "id": "backup",
        "label": "💾 Backup"
      },
      {
        "id": "saldo-plific",
        "label": "💳 Saldo Plific"
      }
    ]
  },
  {
    "id": "operacional",
    "label": "Operacional",
    "icon": "⚙️",
    "ordem": 30,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "indicacoes",
        "label": "Indicações"
      },
      {
        "id": "promo-novatos",
        "label": "Promo Novatos"
      },
      {
        "id": "avisos",
        "label": "Avisos"
      },
      {
        "id": "novas-operacoes",
        "label": "Novas Operações"
      },
      {
        "id": "recrutamento",
        "label": "Recrutamento"
      },
      {
        "id": "localizacao-clientes",
        "label": "Localização Clientes"
      },
      {
        "id": "relatorio-diario",
        "label": "Relatório Diário"
      },
      {
        "id": "score-prof",
        "label": "Score Prof"
      },
      {
        "id": "incentivos",
        "label": "Acompanhamento"
      }
    ]
  },
  {
    "id": "disponibilidade",
    "label": "Disponibilidade",
    "icon": "📅",
    "ordem": 40,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "panorama",
        "label": "Panorama"
      },
      {
        "id": "principal",
        "label": "Principal"
      },
      {
        "id": "faltosos",
        "label": "Faltosos"
      },
      {
        "id": "espelho",
        "label": "Espelho"
      },
      {
        "id": "relatorios",
        "label": "Relatórios"
      },
      {
        "id": "motoboys",
        "label": "Motoboys"
      },
      {
        "id": "restricoes",
        "label": "Restrições"
      },
      {
        "id": "config",
        "label": "Configurações"
      }
    ]
  },
  {
    "id": "bi",
    "label": "BI",
    "icon": "📊",
    "ordem": 50,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "home-bi",
        "label": "🏠 Home"
      },
      {
        "id": "dashboard",
        "label": "📊 Dashboard"
      },
      {
        "id": "profissionais",
        "label": "👤 Por Profissional"
      },
      {
        "id": "garantido",
        "label": "💰 Garantido"
      },
      {
        "id": "os",
        "label": "📋 Análise por OS"
      },
      {
        "id": "cliente767",
        "label": "🏢 Cliente 767"
      },
      {
        "id": "chat-ia",
        "label": "💬 Chat IA"
      },
      {
        "id": "relatorio-ia",
        "label": "🤖 Relatório IA"
      },
      {
        "id": "upload",
        "label": "📤 Upload"
      },
      {
        "id": "config",
        "label": "⚙️ Configurações"
      }
    ]
  },
  {
    "id": "bi-monitoramento",
    "label": "BI Monitoramento",
    "icon": "📡",
    "ordem": 60,
    "soAdmin": true,
    "sempreLiberado": false,
    "abas": []
  },
  {
    "id": "todo",
    "label": "TO-DO",
    "icon": "📝",
    "ordem": 70,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "tarefas",
        "label": "Tarefas"
      },
      {
        "id": "metricas",
        "label": "Métricas"
      }
    ]
  },
  {
    "id": "filas",
    "label": "Filas",
    "icon": "👥",
    "ordem": 80,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "tradicionais",
        "label": "Filas tradicionais"
      },
      {
        "id": "auto",
        "label": "🤖 Auto-gerenciáveis"
      }
    ]
  },
  {
    "id": "social",
    "label": "Social",
    "icon": "💜",
    "ordem": 90,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "perfil",
        "label": "Meu Perfil"
      },
      {
        "id": "comunidade",
        "label": "Comunidade"
      },
      {
        "id": "mensagens",
        "label": "Mensagens"
      }
    ]
  },
  {
    "id": "cs",
    "label": "Sucesso do Cliente",
    "icon": "🤝",
    "ordem": 100,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "dashboard",
        "label": "Dashboard"
      },
      {
        "id": "clientes",
        "label": "Clientes"
      },
      {
        "id": "interacoes",
        "label": "Interações"
      },
      {
        "id": "ocorrencias",
        "label": "Ocorrências"
      },
      {
        "id": "agenda",
        "label": "Agenda"
      },
      {
        "id": "emails",
        "label": "Emails"
      },
      {
        "id": "emails-automacao",
        "label": "Automação E-mail"
      }
    ]
  },
  {
    "id": "coleta",
    "label": "Consultar Endereços",
    "icon": "🗺️",
    "ordem": 110,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": []
  },
  {
    "id": "config",
    "label": "Configurações",
    "icon": "🔧",
    "ordem": 120,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "usuarios",
        "label": "Usuários"
      },
      {
        "id": "permissoes",
        "label": "Permissões ADM"
      },
      {
        "id": "clientes-api",
        "label": "Clientes API"
      },
      {
        "id": "auditoria",
        "label": "Auditoria"
      },
      {
        "id": "sistema",
        "label": "Sistema"
      },
      {
        "id": "saude-sistema",
        "label": "🏥 Saúde do Sistema"
      }
    ]
  },
  {
    "id": "crm-whatsapp",
    "label": "CRM WhatsApp",
    "icon": "💬",
    "ordem": 130,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": []
  },
  {
    "id": "agente",
    "label": "Agente RPA",
    "icon": "🤖",
    "ordem": 140,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": []
  },
  {
    "id": "rastreio-clientes",
    "label": "Rastreio Clientes",
    "icon": "📡",
    "ordem": 150,
    "soAdmin": true,
    "sempreLiberado": false,
    "abas": []
  },
  {
    "id": "antifraude",
    "label": "Anti-Fraude",
    "icon": "🛡️",
    "ordem": 160,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": []
  },
  {
    "id": "performance",
    "label": "Performance Diária",
    "icon": "📈",
    "ordem": 170,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "dashboard",
        "label": "📊 Dashboard"
      },
      {
        "id": "busca",
        "label": "🔍 Busca"
      },
      {
        "id": "config",
        "label": "⚙️ Configurações"
      },
      {
        "id": "jobs",
        "label": "🗂️ Jobs"
      }
    ]
  },
  {
    "id": "gerencial",
    "label": "Análise Gerencial",
    "icon": "📊",
    "ordem": 180,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": []
  },
  {
    "id": "uber",
    "label": "Hub Logístico",
    "icon": "🚚",
    "ordem": 190,
    "soAdmin": false,
    "sempreLiberado": false,
    "abas": [
      {
        "id": "dashboard",
        "label": "Dashboard"
      },
      {
        "id": "tracking",
        "label": "Tracking"
      },
      {
        "id": "entregas",
        "label": "Entregas"
      },
      {
        "id": "regras",
        "label": "Regras"
      },
      {
        "id": "barrados",
        "label": "🚫 Barrados"
      },
      {
        "id": "frequentes",
        "label": "👑 Frequentes"
      },
      {
        "id": "provedores",
        "label": "🔌 Provedores"
      },
      {
        "id": "chat",
        "label": "💬 Chat 99"
      }
    ]
  },
  {
    "id": "confirmafacil",
    "label": "ConfirmaFácil",
    "icon": "🔗",
    "ordem": 200,
    "soAdmin": true,
    "sempreLiberado": true,
    "abas": []
  },
  {
    "id": "roadmap",
    "label": "Desenvolvimentos",
    "icon": "⚡",
    "ordem": 210,
    "soAdmin": true,
    "sempreLiberado": true,
    "abas": []
  }
];

// Lista completa (ordenada por ordem)
function registro() {
  return MODULOS.slice().sort((a, b) => a.ordem - b.ordem);
}

// So os ids canonicos — util para validar allowed_modules
function idsCanonicos() {
  return MODULOS.map((m) => m.id);
}

// Meta publico (o que sera servido ao frontend via /modules-config na Fase 2)
function metaPublico() {
  return registro().map((m) => ({
    id: m.id,
    label: m.label,
    icon: m.icon,
    ordem: m.ordem,
    soAdmin: m.soAdmin,
    sempreLiberado: m.sempreLiberado,
    abas: m.abas,
  }));
}

// Busca um modulo pelo id
function porId(id) {
  return MODULOS.find((m) => m.id === id) || null;
}

module.exports = { MODULOS, registro, idsCanonicos, metaPublico, porId };
