/**
 * WUZO — Integração de progresso premium (polling + fases do backend).
 * Inclua APÓS o script principal do index.html (ou mescle no inline script).
 */
(function (global) {
  "use strict";

  var PHASE_PCT = {
    pending: 8,
    agents: 50,
    senior_first: 62,
    debate: 74,
    second_analysis: 88,
    report: 96,
    done: 100,
  };

  var PHASE_I18N = {
    pt: {
      pending: "Na fila...",
      agents: "15 especialistas analisando...",
      senior_first: "Consultor sênior — primeira análise...",
      debate: "Debates entre especialistas conflitantes...",
      second_analysis: "Segunda análise — arbitragem pós-debate...",
      report: "Gerando relatório final...",
      done: "Análise concluída.",
      second_ok: "Segunda análise integrada ao veredito.",
    },
    en: {
      pending: "Queued...",
      agents: "15 specialists analyzing...",
      senior_first: "Senior consultant — first pass...",
      debate: "Debates between conflicting specialists...",
      second_analysis: "Second analysis — post-debate arbitration...",
      report: "Generating final report...",
      done: "Analysis complete.",
      second_ok: "Second analysis merged into verdict.",
    },
    es: {
      pending: "En cola...",
      agents: "15 especialistas analizando...",
      senior_first: "Consultor sénior — primer análisis...",
      debate: "Debates entre especialistas en conflicto...",
      second_analysis: "Segunda análisis — arbitraje post-debate...",
      report: "Generando informe final...",
      done: "Análisis completado.",
      second_ok: "Segunda análisis integrada al veredicto.",
    },
  };

  function phaseLabel(phase, lang) {
    var L = PHASE_I18N[lang] || PHASE_I18N.pt;
    return L[phase] || phase || "";
  }

  function applyJobProgress(phase, message, lang) {
    var el = document.getElementById("phase-status");
    var lbl = (message && String(message).trim()) || phaseLabel(phase, lang);
    if (el) el.textContent = lbl;

    if (phase && PHASE_PCT[phase] != null) {
      var fill = document.getElementById("prog-fill");
      if (fill) fill.style.width = PHASE_PCT[phase] + "%";
    }

    if (phase === "senior_first" || phase === "debate" || phase === "second_analysis") {
      var senior = document.getElementById("ac-consultor_senior");
      if (senior) {
        senior.className = "ac thinking";
        var st = senior.querySelector(".ac-st");
        if (st) st.innerHTML = "&#9675;";
      }
    }

    if (lbl && typeof global.addLog === "function") {
      global.addLog(lbl);
    }
  }

  global.WUZO_PHASE_PCT = PHASE_PCT;
  global.WUZO_PHASE_I18N = PHASE_I18N;
  global.wuzoApplyJobProgress = applyJobProgress;
  global.wuzoPhaseLabel = phaseLabel;
})(typeof window !== "undefined" ? window : globalThis);
