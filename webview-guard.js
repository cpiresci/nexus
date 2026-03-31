/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  WUZO WebView Guard — Anti-Chrome-Escape v1.0       ║
 * ║  Injete no footer do tema WP ou no index.html       ║
 * ║  antes de </body>                                   ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * O que faz:
 *  1. Remove todos os target="_blank" dinamicamente
 *  2. Intercepta window.open() para não abrir Chrome
 *  3. Bloqueia navegação para domínios externos não autorizados
 *  4. Domínios de pagamento (Stripe) navegam dentro do WebView
 *  5. Log de diagnóstico no console para debug
 */
(function () {
  "use strict";

  // ── Domínios que pertencem ao app (navegação interna OK) ──────────
  var INTERNAL = [
    "wuzo.com.br",
    "www.wuzo.com.br",
    "app.wuzo.com.br",
    "localhost",
    "127.0.0.1",
  ];

  // ── Domínios externos permitidos (abrem no WebView, não no Chrome) ──
  var ALLOWED_EXTERNAL = [
    "checkout.stripe.com",
    "stripe.com",
    "js.stripe.com",
    "hooks.stripe.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
  ];

  // ── Detecta ambiente Capacitor ────────────────────────────────────
  function isCapacitor() {
    return (
      typeof window.Capacitor !== "undefined" ||
      window.location.protocol === "capacitor:"
    );
  }

  // ── Extrai hostname de uma URL ────────────────────────────────────
  function getHostname(url) {
    try {
      // URL relativa ou fragmento — é interno
      if (!url || url.charAt(0) === "/" || url.charAt(0) === "#" || url.startsWith("javascript:")) {
        return "__internal__";
      }
      return new URL(url, window.location.href).hostname;
    } catch (e) {
      return "__internal__";
    }
  }

  // ── Verifica se a URL é interna ao app ───────────────────────────
  function isInternal(url) {
    var host = getHostname(url);
    if (host === "__internal__") return true;
    return INTERNAL.some(function (d) {
      return host === d || host.endsWith("." + d);
    });
  }

  // ── Verifica se é domínio externo permitido (ex: Stripe) ─────────
  function isAllowedExternal(url) {
    var host = getHostname(url);
    return ALLOWED_EXTERNAL.some(function (d) {
      return host === d || host.endsWith("." + d);
    });
  }

  // ── PATCH 1: Intercepta todos os cliques em <a> ──────────────────
  document.addEventListener(
    "click",
    function (e) {
      // Sobe na árvore DOM para encontrar o <a> pai
      var el = e.target;
      while (el && el.tagName !== "A") {
        el = el.parentElement;
      }
      if (!el || !el.href) return;

      var href = el.getAttribute("href") || el.href;

      // SEMPRE remove target="_blank" — nada escapa do WebView
      if (el.target === "_blank" || el.target === "_new") {
        el.removeAttribute("target");
        el.target = "_self";
      }

      // Só age se estiver no Capacitor
      if (!isCapacitor()) return;
      if (isInternal(href)) return; // interno: deixa navegar normalmente

      e.preventDefault();
      e.stopImmediatePropagation();

      if (isAllowedExternal(href)) {
        // Stripe, fontes, etc — navega dentro do WebView
        console.log("[WuzoGuard] Externo permitido (WebView):", href);
        window.location.href = href;
      } else {
        // Bloqueia tudo que não está na lista — nem Chrome, nem nada
        console.warn("[WuzoGuard] Link externo bloqueado:", href);
      }
    },
    true // capture phase — antes de qualquer handler da página
  );

  // ── PATCH 2: Intercepta window.open() ────────────────────────────
  var _nativeOpen = window.open;
  window.open = function (url, target, features) {
    if (!isCapacitor()) {
      return _nativeOpen.apply(window, arguments);
    }
    if (!url) return null;

    if (isInternal(url)) {
      // Interno: navega na mesma aba
      window.location.href = url;
      return null;
    }
    if (isAllowedExternal(url)) {
      // Stripe checkout e similares: navega no WebView
      console.log("[WuzoGuard] window.open permitido (WebView):", url);
      window.location.href = url;
      return null;
    }
    // Externo não autorizado: bloqueia
    console.warn("[WuzoGuard] window.open bloqueado:", url);
    return null;
  };

  // ── PATCH 3: Remove target="_blank" de links já no DOM ───────────
  function sanitizeExistingLinks() {
    var links = document.querySelectorAll('a[target="_blank"], a[target="_new"]');
    links.forEach(function (a) {
      a.removeAttribute("target");
    });
    if (links.length > 0) {
      console.log("[WuzoGuard] " + links.length + " link(s) target=_blank removidos.");
    }
  }

  // ── PATCH 4: Observer para links adicionados dinamicamente ───────
  if (typeof MutationObserver !== "undefined") {
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return; // só elementos
          if (node.tagName === "A") {
            node.removeAttribute("target");
          }
          // Busca dentro de nodes filhos também
          var innerLinks = node.querySelectorAll ? node.querySelectorAll('a[target="_blank"]') : [];
          innerLinks.forEach(function (a) { a.removeAttribute("target"); });
        });
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ── Init ──────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sanitizeExistingLinks);
  } else {
    sanitizeExistingLinks();
  }

  console.log(
    "[WuzoGuard] Ativo | Capacitor:",
    isCapacitor(),
    "| Protocol:",
    window.location.protocol
  );
})();
