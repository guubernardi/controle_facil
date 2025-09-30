// js/rules.js
// Tabela de regras de devolução (configurável por plataforma)

const RULES = {
  version: 1,

  // Plataforma padrão a aplicar quando não houver override
  defaultPlatform: "default",

  // -------- Regras base (válidas para todas as plataformas) --------
  default: {
    // Políticas por motivo (impacto no prejuízo/reembolso)
    // - "no_cost"  => produto = 0, frete = 0
    // - "default"  => produto + frete (regra normal)
    motivoPolitica: {
      arrependimento: "no_cost",
      compra_errada: "no_cost",
      nao_serviu: "no_cost",
      mudou_de_ideia: "no_cost",
      endereco_errado_cliente: "no_cost",
      ausencia_receptor: "no_cost",
      cancelou_antes_envio: "no_cost"
      // demais motivos não listados caem em "default"
    },

    // Status especiais que alteram o cálculo
    statusRules: {
      // quando o status estiver nesta lista: considera só o FRETE (produto = 0)
      only_freight_status: ["recebido_cd", "em_inspecao"],
      // quando o status estiver nesta lista: prejuízo = 0 (sem reembolso)
      zero_loss_status: ["rejeitado"]
    },

    // Mapeia variações de nomes para um motivo "canônico"
    motivoAliases: {
      "arrependeu": "arrependimento",
      "desistencia": "arrependimento",
      "desistência": "arrependimento",
      "tamanho_cor_modelo": "nao_serviu",
      "comprou_errado": "compra_errada"
    },

    // Heurística textual (regex) para reconhecer motivos de cliente coberto
    // Isso casa com teu index.js (motivoClienteRegex).
    customerNoCostRegex: /(arrepend|desist|engano|compra errad|nao serviu|não serviu|tamanho|cor errad|mudou de ideia)/i,

    // Labels de UI (centraliza textos que aparecem no aviso do modal)
    ui: {
      statusHelp: {
        pendente: {
          title: "Pendente",
          desc: "Em análise. Nenhum reembolso lançado ainda."
        },
        aprovado: {
          title: "Aprovado",
          desc: "Reembolsa produto + frete conforme os campos."
        },
        rejeitado: {
          title: "Rejeitado",
          desc: "Sem reembolso para o cliente (prejuízo = R$ 0,00)."
        },
        infoNote:
          "Regra automática: se o status for 'recebido_cd' ou 'em_inspecao', o sistema considera apenas o frete (produto = R$ 0,00)."
      }
    }
  },

  // -------- Overrides por plataforma (opcional) --------
  platforms: {
    // Ex.: Amazon usa um status diferente para item que voltou ao centro
    amazon: {
      statusRules: {
        only_freight_status: ["devolvido_ao_centro", "em_inspecao"],
        zero_loss_status: ["rejeitado"] // mantém
      },
      motivoPolitica: {
        // se alguma política de motivo diferir na Amazon, coloque aqui
        // ex.: "mudou_de_ideia": "no_cost"
      }
    },

    // Ex.: Magalu pode enviar um status próprio
    magalu: {
      statusRules: {
        only_freight_status: ["recebido_magalu", "em_inspecao"]
      }
    }
  }
};

export default RULES;
