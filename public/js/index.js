// /public/js/index.js — Feed sem "F5": sem auto-resolve, sem auto-sync, atualiza só o card
class DevolucoesFeed {
  constructor() {
    this.items = [];
    this.filtros = { pesquisa: "", status: "todos" };
    this.RANGE_DIAS = 30;

    this.pageSize = 15;
    this.page = 1;

    // Flags de comportamento (tudo off p/ parar o F5)
    this.FEATURE = {
      AUTO_SYNC: false,           // não roda atualizarDados sozinho
      AUTO_FLOW_RESOLVE: false,   // não tenta resolver fluxo em background
      MESSAGES_SYNC: false        // não chama /api/ml/messages/sync (404 no seu back)
    };

    // "Nova"
    this.NEW_WINDOW_MS = 12 * 60 * 60 * 1000;
    this.MAX_NEW_AGE_MS = 48 * 60 * 60 * 1000;
    this.NEW_KEY_PREFIX = "rf:firstSeen:";

    // circuit breaker do claims/import (400)
    this.CLAIMS_BLOCK_MS  = 6 * 60 * 60 * 1000;
    this.CLAIMS_BLOCK_KEY = "rf:claimsImport:blockUntil";

    // cache de fluxo
    this.FLOW_TTL_MS = 30 * 60 * 1000;
    this.FLOW_CACHE_PREFIX = "rf:flowCache:";

    // bloqueios específicos de ML/shipping
    this.ML_SHIP_BLOCK_KEY  = "rf:mlShipping:blockUntil";
    this.ML_SHIP_BLOCK_MS   = 2 * 60 * 60 * 1000;
    this.ML_NOACCESS_TTL_MS = 24 * 60 * 60 * 1000;
    this._
