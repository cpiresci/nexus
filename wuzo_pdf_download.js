/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║   WUZO PDF Download Engine v1.0                                             ║
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
   * Cria um AbortController com timeout automático.
   *
   * @param {number} ms - Milissegundos até o abort.
   * @returns {AbortSignal}
   */
  function _makeSignal(ms) {
    var ctrl = new AbortController();
    setTimeout(function () {
      try {
        ctrl.abort(new DOMException("PDF request timed out after " + ms + "ms", "AbortError"));
      } catch (_) {
        ctrl.abort();
      }
    }, ms);
    return ctrl.signal;
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
   * @param {ArrayBuffer} buffer  - Bytes do arquivo.
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

    // ── Validações de entrada ─────────────────────────────────────────────────
    if (!analysisId) {
      onError("ID da análise inválido.");
      onFinally();
      return;
    }
    if (!token) {
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
        signal:  _makeSignal(PDF_TIMEOUT_MS),
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
      // ── [C3] onFinally SEMPRE executado — nenhum caminho escapa deste bloco ───
      onFinally();
    }
  }

  // ── Exportação ────────────────────────────────────────────────────────────────
  // Compatível com módulos ES6 (import) e com script tag clássico (window global)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { baixarRelatorioPDFJS: baixarRelatorioPDFJS };
  } else {
    global.baixarRelatorioPDFJS = baixarRelatorioPDFJS;
  }

}(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this));
