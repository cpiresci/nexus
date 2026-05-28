/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║   WUZO PDF Download Engine v1.2 — HFT Timeout Leak Fix                     ║
 * ║   Cliente resiliente para consumo da rota /api/report/pdf/<id>              ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║   Corrige os 3 elos do Efeito Dominó no lado do cliente:                    ║
 * ║                                                                              ║
 * ║   [C1] Verifica Content-Type ANTES de criar o Blob — nunca salva JSON       ║
 * ║        de erro como arquivo .pdf                                             ║
 * ║                                                                              ║
 * ║   [C2] Consome o stream de forma atômica (uma única leitura de Response):   ║
 * ║        não viola o Fetch lifecycle chamando .json() após .blob()            ║
 * ║                                                                              ║
 * ║   [C3] onFinally executado SEMPRE em todos os caminhos de saída —           ║
 * ║        elimina o botão travado em loading eterno                             ║
 * ║                                                                              ║
 * ║   [C4] Diagnóstico via header X-Wuzo-Pdf-Fallback: quando o backend         ║
 * ║        entrega um PDF administrativo, o onSuccess informa o usuário         ║
 * ║        com mensagem distinta                                                 ║
 * ║                                                                              ║
 * ║   PATCH v1.1 "Session Reset + AbortController Cleanup":                     ║
 * ║     [C5] _activePdfController: aborta request anterior antes de abrir       ║
 * ║          nova conexão — garante que apenas um download esteja ativo.        ║
 * ║     [C6] resetDownloadState(): força onFinally() em caso de re-entrada —    ║
 * ║          isAnalyzing / progress / btnStates nunca ficam travados se o       ║
 * ║          usuário iniciar um segundo download antes do primeiro terminar.    ║
 * ║     [C7] Timeout via AbortController próprio (não setTimeout solto) —       ║
 * ║          clearTimeout no finally evita referências pendentes de timer.      ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * USO:
 *   await baixarRelatorioPDFJS({
 *     analysisId : 42,
 *     token      : "eyJ...",
 *     backendUrl : "https://app.wuzo.com.br",
 *     onFinally  : () => setBtns(false),
 *     onError    : (msg) => showAlert("inp-alert", "alert-err", msg),
 *     onSuccess  : (filename) => console.log("Download concluído:", filename),
 *   });
 */

(function (global) {
  "use strict";

  /**
   * Tempo máximo (ms) de espera pelo início da resposta do servidor.
   * PDFs grandes podem demorar até 90 s para serem gerados pelo ReportLab.
   */
  var PDF_TIMEOUT_MS = 90000;

  /**
   * Prefixo MIME que identifica uma resposta PDF legítima.
   * Qualquer resposta com Content-Type diferente deste é tratada como erro.
   */
  var EXPECTED_MIME = "application/pdf";

  /**
   * [C5] Mantém referência ao AbortController do request de PDF atualmente ativo.
   * Permite abortar uma conexão anterior quando uma nova é iniciada,
   * impedindo que dois downloads paralelos corrompam o estado de UI.
   */
  var _activePdfController = null;

  /**
   * Referência ao setTimeout de timeout da requisição ativa.
   * Limpo no finally para evitar timers pendentes após o término.
   */
  var _activePdfTimeoutId = null;

  /**
   * [C6] Cancela qualquer download em andamento e reseta o estado de UI.
   *
   * Deve ser chamado ANTES de iniciar um novo download para garantir que:
   *   - O AbortController anterior seja cancelado.
   *   - O callback onFinally() do request anterior seja invocado se houver
   *     um callback de UI registrado.
   *
   * @param {Function|null} prevOnFinally - onFinally() do request anterior (se disponível).
   */
  function _cancelActivePdfRequest(prevOnFinally) {
    if (_activePdfController) {
      try {
        _activePdfController.abort(
          new DOMException("Superseded by new PDF request", "AbortError")
        );
      } catch (_) {
        try { _activePdfController.abort(); } catch (_2) {}
      }
      _activePdfController = null;
    }
    if (_activePdfTimeoutId !== null) {
      clearTimeout(_activePdfTimeoutId);
      _activePdfTimeoutId = null;
    }
    // Força liberação de UI do request anterior (se ainda não foi liberada)
    if (typeof prevOnFinally === "function") {
      try { prevOnFinally(); } catch (_) {}
    }
  }

  /**
   * Decide se um erro é de abort/timeout (não deve exibir mensagem ao usuário).
   *
   * @param {any} err
   * @returns {boolean}
   */
  function _isAbort(err) {
    if (!err) return false;
    if (err.name === "AbortError") return true;
    var m = (err.message || "").toLowerCase();
    return (
      m.indexOf("abort") !== -1 ||
      m.indexOf("timeout") !== -1 ||
      m.indexOf("timed out") !== -1 ||
      m.indexOf("superseded") !== -1 ||
      m.indexOf("signal") !== -1
    );
  }

  /**
   * Lê o corpo da resposta HTTP como ArrayBuffer de forma atômica —
   * uma única operação de leitura do stream, sem chamadas subsequentes.
   *
   * @param {Response} response - Fetch Response ainda não consumida.
   * @returns {Promise<ArrayBuffer>}
   */
  function _readBodyOnce(response) {
    return response.arrayBuffer();
  }

  /**
   * Tenta extrair uma mensagem de erro a partir de bytes que podem ser JSON.
   *
   * @param {ArrayBuffer} buffer
   * @returns {string|null} - Mensagem de erro ou null se não for JSON válido.
   */
  function _parseErrorFromBuffer(buffer) {
    try {
      var text = new TextDecoder("utf-8").decode(buffer);
      var parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string" && parsed.error.length > 0) {
        return parsed.error;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Dispara o download do arquivo no navegador a partir de um ArrayBuffer.
   *
   * @param {ArrayBuffer} buffer   - Bytes do arquivo.
   * @param {string}      filename - Nome sugerido para salvar.
   */
  function _triggerDownload(buffer, filename) {
    var blob    = new Blob([buffer], { type: EXPECTED_MIME });
    var blobUrl = URL.createObjectURL(blob);
    var anchor  = document.createElement("a");
    anchor.href     = blobUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Aguarda um tick para o navegador iniciar o download antes de revogar
    setTimeout(function () {
      URL.revokeObjectURL(blobUrl);
    }, 250);
  }

  /**
   * baixarRelatorioPDFJS
   * ─────────────────────
   * Função principal de download resiliente.
   *
   * @param {Object}   opts
   * @param {number}   opts.analysisId  - ID da análise a baixar.
   * @param {string}   opts.token       - JWT do usuário autenticado.
   * @param {string}   opts.backendUrl  - URL base do backend (sem trailing slash).
   * @param {Function} opts.onFinally   - Sempre chamado ao término (libera UI).
   * @param {Function} opts.onError     - Chamado com string de mensagem de erro.
   * @param {Function} opts.onSuccess   - Chamado com o nome do arquivo baixado.
   *
   * @returns {Promise<void>}
   */
  async function baixarRelatorioPDFJS(opts) {
    var analysisId = opts.analysisId;
    var token      = opts.token      || "";
    var backendUrl = (opts.backendUrl || "").replace(/\/+$/, "");
    var onFinally  = typeof opts.onFinally === "function"  ? opts.onFinally  : function () {};
    var onError    = typeof opts.onError   === "function"  ? opts.onError    : function () {};
    var onSuccess  = typeof opts.onSuccess === "function"  ? opts.onSuccess  : function () {};

    // ── [C5/C6] Aborta request anterior e reseta estado de UI ────────────────
    // Salva referência do onFinally anterior ANTES de sobrescrever _activePdfController,
    // pois a próxima chamada pode ter um onFinally diferente para liberar sua própria UI.
    var _prevController = _activePdfController;
    // Cancela request anterior (aborta + limpa timeout + libera UI anterior se presa)
    // Nota: não passamos o onFinally anterior pois cada request gerencia seu próprio botão.
    if (_prevController) {
      try { _prevController.abort(new DOMException("Superseded by new PDF request", "AbortError")); }
      catch (_) { try { _prevController.abort(); } catch (_2) {} }
    }
    if (_activePdfTimeoutId !== null) {
      clearTimeout(_activePdfTimeoutId);
      _activePdfTimeoutId = null;
    }

    // ── [C5] Cria novo AbortController exclusivo para ESTE request ────────────
    var _ownController = new AbortController();
    _activePdfController = _ownController;

    // ── [C7] Timeout via AbortController (não setTimeout solto) ──────────────
    _activePdfTimeoutId = setTimeout(function () {
      try {
        _ownController.abort(
          new DOMException("PDF request timed out after " + PDF_TIMEOUT_MS + "ms", "AbortError")
        );
      } catch (_) {
        _ownController.abort();
      }
    }, PDF_TIMEOUT_MS);

    // ── Validações de entrada ─────────────────────────────────────────────────
    // [HFT] Limpa timeout antes de early-return — evita timer órfão que
    // continuaria referenciando _ownController após o return.
    if (!analysisId) {
      clearTimeout(_activePdfTimeoutId); _activePdfTimeoutId = null;
      _activePdfController = null;
      onError("ID da análise inválido.");
      onFinally();
      return;
    }
    if (!token) {
      clearTimeout(_activePdfTimeoutId); _activePdfTimeoutId = null;
      _activePdfController = null;
      onError("Sessão expirada. Faça login novamente.");
      onFinally();
      return;
    }

    var pdfUrl   = backendUrl + "/api/report/pdf/" + analysisId;
    var filename = "wuzo_relatorio_" + analysisId + ".pdf";

    try {
      // ── [C2] Leitura atômica — um único fetch, um único .arrayBuffer() ──────
      var response = await fetch(pdfUrl, {
        method:  "GET",
        headers: { "Authorization": "Bearer " + token },
        signal:  _ownController.signal,
      });

      // Lê o corpo UMA VEZ como ArrayBuffer independentemente do status
      var buffer = await _readBodyOnce(response);

      // ── Tratamento de erros HTTP ──────────────────────────────────────────────
      if (!response.ok) {
        var httpMsg = _parseErrorFromBuffer(buffer);
        if (!httpMsg) {
          if (response.status === 401) httpMsg = "Sessão expirada. Faça login novamente.";
          else if (response.status === 404) httpMsg = "Relatório não encontrado.";
          else httpMsg = "Erro HTTP " + response.status + " ao gerar o PDF.";
        }
        onError(httpMsg);
        return; // onFinally chamado no finally abaixo
      }

      // ── [C1] Verificação de Content-Type ANTES de criar o Blob ───────────────
      var contentType = (response.headers.get("Content-Type") || "").toLowerCase();
      if (contentType.indexOf("application/pdf") === -1) {
        // O servidor retornou 200 mas com corpo diferente de PDF
        // (ex.: JSON de erro embrulhado em status 200 por proxy)
        var mimeMsg = _parseErrorFromBuffer(buffer);
        onError(
          mimeMsg ||
          "O servidor retornou um arquivo inválido (Content-Type: " +
          contentType + "). Tente novamente."
        );
        return;
      }

      // ── [C4] Detectar PDF de fallback administrativo ──────────────────────────
      var isFallback = response.headers.get("X-Wuzo-Pdf-Fallback") === "1";

      // ── Download efetivo ──────────────────────────────────────────────────────
      _triggerDownload(buffer, filename);

      if (isFallback) {
        onSuccess(
          filename +
          " (relatório em reprocessamento — nenhum crédito debitado)"
        );
      } else {
        onSuccess(filename);
      }

    } catch (err) {
      // ── [C3] Erros de rede e timeout ──────────────────────────────────────────
      if (!_isAbort(err)) {
        onError("Erro ao baixar PDF: " + (err.message || "falha de rede."));
      }
      // Erros de abort/timeout não exibem mensagem — o usuário já sabe que cancelou
    } finally {
      // ── [C3/C7] Limpeza garantida em TODOS os caminhos de saída ──────────────

      // Cancela timeout pendente
      if (_activePdfTimeoutId !== null) {
        clearTimeout(_activePdfTimeoutId);
        _activePdfTimeoutId = null;
      }

      // Libera referência global apenas se este controller ainda for o ativo
      // (evita limpar o controller de um request mais novo que foi iniciado
      //  enquanto este estava em andamento)
      if (_activePdfController === _ownController) {
        _activePdfController = null;
      }

      // [C3] onFinally SEMPRE executado — nenhum caminho escapa deste bloco
      onFinally();
    }
  }

  // ── Exportação ────────────────────────────────────────────────────────────────
  // Compatível com módulos ES6 (import) e com script tag clássico (window global)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      baixarRelatorioPDFJS: baixarRelatorioPDFJS,
      _cancelActivePdfRequest: _cancelActivePdfRequest,
    };
  } else {
    global.baixarRelatorioPDFJS = baixarRelatorioPDFJS;
    global._cancelActivePdfRequest = _cancelActivePdfRequest;
  }

}(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this));
