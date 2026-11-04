/* ============================================================
   bug-report.js — bouton « bug » flottant + sélection d'élément
   ------------------------------------------------------------
   MODULE AUTONOME ET TRANSFÉRABLE (vanilla, zéro dépendance,
   styles injectés) : à charger sur CHAQUE page à surveiller.

   1. Piège à erreurs : les 20 dernières erreurs JavaScript
      (même invisibles) sont gardées en mémoire et jointes au
      rapport — c'est souvent elles qui disent où chercher.
   2. Bouton flottant 🐛 en bas à droite :
        « Sélectionner les éléments de l'interface qui posent
          problème ? »
        - Non      → rapport simple (description seule)
        - Oui      → mode sélection : tapoter (ou cliquer) les
                     éléments en cause — plusieurs possibles —
                     puis « ✓ Terminer » (surlignage au survol)
        - Annuler  → rien ne se passe
   3. Le contexte complet (page, date, version de l'app, éléments
      tapotés, réseau, file de synchro, document en cours,
      erreurs JS, appareil) est posé dans localStorage puis la
      page de rapports s'ouvre pour la description au clavier et
      l'envoi (gardé hors ligne, envoyé au retour du réseau).

   TOUT ce qui change d'un projet à l'autre est dans CONFIG.
   Une page peut le surcharger avant le chargement du script :
       <script>window.RB_BUG_CONFIG = { pageRapport: "/Rapport_bug/bugs.html" };</script>
   ============================================================ */
(function () {
  "use strict";

  if (window.RB_BUG) return;          /* chargé une seule fois */
  window.RB_BUG = { module: "bug-report", version: 4 };

  /* Page de réception : par défaut le bugs.html du dossier qui
     contient CE module (…/Rapport_bug/bugs.html) — la redirection
     est donc juste même depuis une page d'un autre sous-dossier.
     (location.href est résolu par rapport à la PAGE, pas au script.) */
  function urlParDefaut() {
    var s = document.currentScript;
    if (!s) {
      var liste = document.getElementsByTagName("script");
      for (var i = liste.length - 1; i >= 0; i--) {
        if (/bug-report\.js/.test(liste[i].src)) { s = liste[i]; break; }
      }
    }
    if (s && s.src) {
      /* On ignore ?v= et #…, on garde le DOSSIER du module et on
         remonte d'un cran s'il est dans un sous-dossier « js/ » :
         …/Rapport_bug/js/bug-report.js → …/Rapport_bug/bugs.html */
      var u = String(s.src).split("#")[0].split("?")[0];
      var base = u.replace(/\/[^\/]*$/, "/").replace(/\/js\/$/, "/");
      return base + "bugs.html";
    }
    return "bugs.html";
  }

  var CONFIG = {
    /* Page qui reçoit le rapport (formulaire + liste). */
    pageRapport: urlParDefaut(),
    /* Clé localStorage du contexte (UNE par application sur le domaine). */
    cleContexte: "rb_contexte_v1",
    /* Attribut du <body> portant la version applicative. */
    attributVersion: "data-version",
    /* Libellés. */
    titreModale: "\uD83D\uDC1B Signaler un bug",
    questionModale: "Sélectionner les éléments de l'interface qui posent problème ?",
    libelleBouton: "Signaler un bug"
  };
  if (window.RB_BUG_CONFIG && typeof window.RB_BUG_CONFIG === "object") {
    for (var k in window.RB_BUG_CONFIG) {
      if (Object.prototype.hasOwnProperty.call(window.RB_BUG_CONFIG, k)) {
        CONFIG[k] = window.RB_BUG_CONFIG[k];
      }
    }
  }

  var MAX_ERREURS = 20;
  var erreurs = [];

  function $(id, racine) {
    /* racine peut être un ÉLÉMENT (la mini-modale du module) : les
       éléments n'ont PAS getElementById — méthode de document
       uniquement, d'où querySelector côté racine. */
    return racine ? racine.querySelector('[id="' + id + '"]')
                  : document.getElementById(id);
  }

  /* ---------- 1. Piège à erreurs JavaScript ----------
     En mémoire seulement (jamais localStorage) : ne survit pas
     au rechargement, mais suffit à couvrir une séance de travail
     — l'essentiel est qu'elles soient JOINTES au rapport. */
  window.addEventListener("error", function (e) {
    try {
      erreurs.push({
        msg:   String(e && e.message ? e.message : "").slice(0, 300),
        src:   String(e && e.filename ? e.filename : "").split("/").pop().slice(0, 80),
        ligne: e && e.lineno ? e.lineno : 0,
        ts:    Date.now()
      });
      if (erreurs.length > MAX_ERREURS) erreurs.shift();
    } catch (err) { /* le piège ne doit jamais causer d'erreur */ }
  });

  /* ---------- Styles injectés (charte cyan / verre sombre) ---------- */
  function injecterStyle() {
    var s = document.createElement("style");
    s.textContent = [
      "#bug-btn{position:fixed;right:18px;bottom:18px;z-index:900;width:46px;height:46px;",
      "border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:21px;",
      "color:#50E8F5;background:rgba(10,16,22,0.92);border:1px solid rgba(0,214,242,0.34);",
      "-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);cursor:pointer;user-select:none;",
      "-webkit-user-select:none;text-decoration:none;box-shadow:0 4px 18px rgba(0,0,0,0.35);",
      "transition:box-shadow .18s,transform .18s;}",
      "#bug-btn:hover{box-shadow:0 0 18px rgba(0,214,242,0.32);transform:translateY(-2px);}",
      "#bug-modale-voile{position:fixed;inset:0;z-index:901;background:rgba(4,8,12,0.62);",
      "display:flex;align-items:center;justify-content:center;padding:20px;}",
      "#bug-modale{width:min(430px,100%);background:#0d1319;border:1px solid rgba(0,214,242,0.30);",
      "border-radius:18px;padding:22px;box-shadow:0 18px 50px rgba(0,0,0,0.5);}",
      "#bug-modale h3{margin:0 0 8px;font-size:17px;color:#fff;",
      "font-family:\"Space Grotesk\",\"Inter\",system-ui,sans-serif;}",
      "#bug-modale p{margin:0 0 18px;font-size:13.5px;line-height:1.55;color:#8b979e;}",
      "#bug-modale-boutons{display:flex;gap:10px;flex-wrap:wrap;}",
      "#bug-modale-boutons button{flex:1;min-width:110px;padding:11px 12px;border-radius:12px;",
      "font-size:13.5px;cursor:pointer;border:1px solid rgba(255,255,255,0.14);",
      "background:#141c24;color:#e8eef1;font-family:inherit;}",
      "#bug-modale-boutons button.primaire{background:linear-gradient(150deg,#00A3F7,#50E8F5);",
      "border:none;color:#04121a;font-weight:600;}",
      "#bug-voile{position:fixed;inset:0;z-index:2147483000;background:rgba(4,8,12,0.10);",
      "pointer-events:none;}",
      "#bug-surlign{position:fixed;z-index:2147483001;pointer-events:none;display:none;",
      "border:2px solid #50E8F5;border-radius:6px;",
      "box-shadow:0 0 0 3000px rgba(4,8,12,0.25),0 0 22px rgba(0,214,242,0.4);}",
      /* Bandeau du mode sélection collé EN BAS : en haut il recouvrait la
         barre de navigation (logo, badges, thème) et ces éléments devenaient
         impossibles à désigner — le bandeau s'exclut de sa propre capture. */
      "#bug-bandeau{position:fixed;bottom:0;left:0;right:0;z-index:2147483002;display:flex;gap:14px;",
      "align-items:center;padding:10px 14px calc(10px + env(safe-area-inset-bottom,0px));",
      "background:rgba(8,14,20,0.96);color:#e8eef1;",
      "font:500 13px/1.4 \"Inter\",system-ui,sans-serif;",
      "border-top:1px solid rgba(0,214,242,0.35);",
      "-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);}",
      "#bug-bandeau-cible{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
      "text-align:center;font-family:\"JetBrains Mono\",Consolas,monospace;",
      "font-size:11.5px;color:#7fd8e8;}",
      "#bug-bandeau button{flex:none;border:1px solid rgba(255,255,255,0.25);background:transparent;",
      "color:#e8eef1;border-radius:9px;padding:6px 12px;font-size:12.5px;cursor:pointer;",
      "font-family:inherit;}",
      "#bug-bandeau button:disabled{opacity:0.4;cursor:default;}",
      "#bug-bandeau-finir{background:linear-gradient(150deg,#00A3F7,#50E8F5);",
      "border:none;color:#04121a;font-weight:600;}",
      "#bug-bandeau-nb{color:#50E8F5;}",
      /* Le bandeau masque le bas de la page : une réserve de défilement
         permet de faire remonter le pied de page au-dessus de lui pour
         pouvoir le désigner. */
      "html.rb-selection body{padding-bottom:76px;}"
    ].join("");
    document.head.appendChild(s);
  }

  /* ---------- Contexte du rapport ---------- */
  function versionAppareil() {
    return (document.body &&
            document.body.getAttribute(CONFIG.attributVersion)) || "";
  }

  /* Nombre de documents en attente de synchronisation — facultatif :
     si l'application expose une file, elle est jointe au rapport
     (un bug « hors-ligne » est souvent une file, pas un bug). */
  function attenteSynchro() {
    try {
      if (window.RB_FILE_LIRE) {
        var file = window.RB_FILE_LIRE();
        return file && typeof file === "number" ? file : null;
      }
    } catch (e) { /* rien à rapporter */ }
    return null;
  }

  /* Document en cours d'édition : la page le déclare (type +
     numéro SEULEMENT, jamais de données client) :
       window.bugDocCourant = function () { return {type:"devis", numero:"DEV-2026-002"}; }; */
  function docCourant() {
    try { return window.bugDocCourant ? window.bugDocCourant() : null; }
    catch (e) { return null; }
  }

  /* Fiche de l'élément tapoté : tous ses « noms » — texte visible,
     identifiant technique, libellé de champ et emplacement. */
  function ficheElement(el) {
    if (!el || !el.tagName) return null;
    var f = {
      tag:     el.tagName.toLowerCase(),
      id:      el.id || "",
      classes: (typeof el.className === "string"
                  ? el.className.trim().split(/\s+/) : [])
                 .filter(Boolean).slice(0, 6),
      texte:   String(el.innerText || el.textContent || "")
                 .trim().replace(/\s+/g, " ").slice(0, 120),
      label:   "",
      type:    ""
    };
    if (/^(input|select|textarea)$/.test(f.tag)) {
      f.type = el.getAttribute("type") || f.tag;
      var lab = null;
      if (el.id) {
        try { lab = document.querySelector('label[for="' + el.id + '"]'); } catch (e) { lab = null; }
      }
      if (!lab && el.closest) lab = el.closest("label");
      if (lab) {
        f.label = String(lab.innerText || lab.textContent || "")
                    .trim().replace(/\s+/g, " ").slice(0, 80);
      }
      if (!f.label) f.label = el.getAttribute("placeholder") || "";
    }
    /* Chemin simplifié (4 niveaux) : ex. div#panneau-editeur ›
       .ed-barre-actions › button#btn-envoyer-mail — c'est lui qui
       identifie un élément SANS id ni classe. */
    var chemin = [], n = el;
    while (n && n !== document.body && chemin.length < 4) {
      var part = n.tagName ? n.tagName.toLowerCase() : "";
      if (n.id)                              part += "#" + n.id;
      else if (typeof n.className === "string" && n.className.trim())
                                             part += "." + n.className.trim().split(/\s+/)[0];
      if (part) chemin.unshift(part);
      n = n.parentElement;
    }
    f.chemin = chemin.join(" > ");
    return f;
  }

  function construireContexte(element, elements) {
    var ctx = {
      page:    (location.pathname.split("/").pop() || "page") + (location.hash || ""),
      date:    new Date().toISOString(),
      version: versionAppareil(),
      element: element || null,
      reseau:  navigator.onLine,
      attente: attenteSynchro(),
      doc:     docCourant(),
      erreurs: erreurs.slice(),
      agent:   navigator.userAgent
    };
    /* Sélection multiple : la liste complète ne rejoint le contexte
       qu'à partir de 2 éléments (1 seul = comportement d'origine). */
    if (elements && elements.length > 1) ctx.elements = elements;
    return ctx;
  }

  /* Poser le contexte puis ouvrir la page rapport (la description
     se tape là-bas). fiches = fiches des éléments tapotés
     (0 = rapport simple, 1 = un élément, N = sélection multiple). */
  function partir(fiches) {
    var liste = (Array.isArray(fiches) ? fiches : []).filter(Boolean);
    try {
      localStorage.setItem(CONFIG.cleContexte,
        JSON.stringify(construireContexte(liste[0] || null,
                                          liste.length > 1 ? liste : null)));
    } catch (e) { /* sans contexte, la page rapport reste utilisable */ }
    window.location.href = CONFIG.pageRapport;
  }

  /* ---------- Mini-modale : 3 choix ---------- */
  function modaleChoix() {
    var voile = document.createElement("div");
    voile.id = "bug-modale-voile";
    voile.innerHTML =
      "<div id=\"bug-modale\" role=\"dialog\" aria-modal=\"true\">" +
        "<h3>" + CONFIG.titreModale + "</h3>" +
        "<p>" + CONFIG.questionModale + "</p>" +
        "<div id=\"bug-modale-boutons\">" +
          "<button type=\"button\" id=\"bug-choix-non\">Non</button>" +
          "<button type=\"button\" id=\"bug-choix-oui\" class=\"primaire\">Oui</button>" +
          "<button type=\"button\" id=\"bug-choix-annuler\">Annuler</button>" +
        "</div>" +
      "</div>";
    document.body.appendChild(voile);
    var fermer = function () {
      if (voile.parentNode) voile.parentNode.removeChild(voile);
    };
    $("bug-choix-non", voile).addEventListener("click", function () { fermer(); partir([]); });
    $("bug-choix-oui", voile).addEventListener("click", function () { fermer(); activerSelection(); });
    $("bug-choix-annuler", voile).addEventListener("click", fermer);
    voile.addEventListener("click", function (e) { if (e.target === voile) fermer(); });
  }

  /* ---------- Mode sélection ----------
     Voile + bandeau + cadre cyan. Les interactions de la page sont
     neutralisées en PHASE CAPTURE (pointerdown + pointerup + click) :
     tapoter « Supprimer » pour le signaler ne déclenche RIEN. Le ✕
     du bandeau reste seul actif.
     La capture se fait au POINTERUP d'un tap immobile : robuste
     quand le navigateur avale le click (preventDefault sur
     pointerdown) ou quand le focus d'un champ décale la page.
     MULTI-SÉLECTION : chaque tap ajoute un élément à la liste
     (liseré cyan + compteur) ; « ↩ Retirer » enlève le dernier,
     « ✓ Terminer » envoie la liste au rapport, « ✕ Annuler » /
     Échap sort sans rien. */
  function activerSelection() {
    var tactile = !!(window.matchMedia
                    && window.matchMedia("(hover: none)").matches);

    var btn = $("bug-btn");
    if (btn) btn.style.display = "none";

    var voile    = document.createElement("div");
    voile.id     = "bug-voile";
    var surlign  = document.createElement("div");
    surlign.id   = "bug-surlign";
    var bandeau  = document.createElement("div");
    bandeau.id   = "bug-bandeau";
    bandeau.innerHTML =
      "<span>🎯 " + (tactile ? "Tapotez les éléments en cause" : "Cliquez sur les éléments en cause") +
      " <b id=\"bug-bandeau-nb\">(0)</b></span>" +
      "<span id=\"bug-bandeau-cible\"></span>" +
      "<button type=\"button\" id=\"bug-bandeau-retirer\" disabled>↩ Retirer</button>" +
      "<button type=\"button\" id=\"bug-bandeau-finir\" disabled>✓ Terminer</button>" +
      "<button type=\"button\" id=\"bug-bandeau-x\">✕ Annuler</button>";
    document.body.appendChild(voile);
    document.body.appendChild(surlign);
    document.body.appendChild(bandeau);
    document.documentElement.style.cursor = "crosshair";
    document.documentElement.classList.add("rb-selection");

    var cible      = $("bug-bandeau-cible");
    var compteur   = $("bug-bandeau-nb");
    var btnRetirer = $("bug-bandeau-retirer");
    var btnFinir   = $("bug-bandeau-finir");
    var selection = [];   /* [{fiche, el}] — el garde son liseré */
    /* Session close : les intercepteurs restent branchés (le click qui
       suit le dernier pointerup doit rester neutralisé) mais ne touchent
       plus au DOM — le bandeau est retiré, ses éléments n'existent plus.
       Sans ce drapeau, chaque tap pendant le chargement de la page de
       rapports levait « Cannot set properties of null » sur majBandeau. */
    var termine = false;

    function effacerCible() {
      if (cible) cible.textContent = "";
    }

    function majBandeau() {
      if (termine || !compteur) return;
      var n = selection.length;
      compteur.textContent = "(" + n + ")";
      if (btnRetirer) btnRetirer.disabled = n === 0;
      if (btnFinir) btnFinir.disabled = n === 0;
    }
    function ajouter(el) {
      if (termine) return;
      var f = ficheElement(el);
      if (!f) return;
      try {
        el.style.outline = "2px solid rgba(80,232,245,0.95)";
        el.style.outlineOffset = "2px";
      } catch (e) { /* élément sans style : la fiche suffit */ }
      selection.push({ fiche: f, el: el });
      majBandeau();
    }
    function retirerDernier() {
      var d = selection.pop();
      if (d && d.el) {
        try { d.el.style.outline = ""; d.el.style.outlineOffset = ""; } catch (e) {}
      }
      majBandeau();
    }

    function elementSous(x, y) {
      var el = document.elementFromPoint(x, y);
      if (el && el.closest && el.closest("#bug-bandeau")) return null;
      return el;
    }

    function montrer(el) {
      if (termine) return;
      if (!el) { surlign.style.display = "none"; effacerCible(); return; }
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { surlign.style.display = "none"; return; }
      surlign.style.display = "block";
      surlign.style.left   = Math.max(0, r.left - 3) + "px";
      surlign.style.top    = Math.max(0, r.top - 3) + "px";
      surlign.style.width  = Math.min(window.innerWidth, r.width + 6) + "px";
      surlign.style.height = r.height + 6 + "px";
      var f = ficheElement(el);
      if (!cible) return;
      cible.textContent = f ? (f.tag + (f.id ? "#" + f.id : "")
                           + (f.label ? " — « " + f.label + " »" : "")
                           + (f.texte ? " — « " + f.texte.slice(0, 40) + " »" : "")) : "";
    }

    function surMouvement(e) {
      if (termine) return;
      var el = elementSous(e.clientX, e.clientY);
      if (el) montrer(el); else { surlign.style.display = "none"; effacerCible(); }
    }
    var dernierBas = null;    /* {x,y} du dernier pointerdown hors bandeau */
    var captureFait = false;  /* le geste courant a déjà capturé ? */

    function surPointeurBas(e) {
      if (e.target && e.target.closest && e.target.closest("#bug-bandeau")) return; /* ✕ actif */
      e.preventDefault();
      /* STOPPÉ avant les listeners de la page : sans cela, un simple clic
         MAINTENU sur une tuile armait l'appui long de l'application
         (500 ms → réorganisation des tuiles) alors qu'on voulait seulement
         la désigner. 
         La capture sur document passe avant tout listener d'élément —
         encore faut-il couper la propagation, preventDefault ne suffit pas. */
      e.stopImmediatePropagation();
      if (termine) return;
      dernierBas = { x: e.clientX, y: e.clientY };
      captureFait = false;
    }
    function surPointeurHaut(e) {
      if (e.target && e.target.closest && e.target.closest("#bug-bandeau")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (termine) return;   /* session close : neutraliser, sans rien capturer */
      /* CAPTURE AU POINTERUP — le cœur du correctif : certains
         navigateurs avalent le click après preventDefault(pointerdown)
         (le tap sur un champ « ne faisait rien »), et sur iPad le
         focus d'un champ peut faire bouger la page avant le click.
         Un TAP immobile (≤ 12px) capture ici ; un GLISSEMENT
         (défilement) laisse la page défiler normalement. */
      if (!dernierBas || captureFait) return;
      var dx = e.clientX - dernierBas.x, dy = e.clientY - dernierBas.y;
      if (dx * dx + dy * dy > 144) return;   /* > 12px = défilement */
      captureFait = true;
      var el = elementSous(e.clientX, e.clientY);
      if (el) ajouter(el);   /* le mode continue : les taps suivants enrichissent la liste */
    }
    function surClic(e) {
      if (e.target && e.target.closest && e.target.closest("#bug-bandeau")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (termine) return;
      /* Filet : seulement si le pointerup du geste n'a pas déjà
         capturé (e.detail===0 = click clavier, jamais capturé). */
      if (captureFait || e.detail === 0) return;
      captureFait = true;
      var el = elementSous(e.clientX, e.clientY);
      if (el) ajouter(el);
    }
    function surEchap(e) {
      if (e.key === "Escape") { e.preventDefault(); annuler(); }
    }
    /* Menu contextuel (clic droit, appui long tactile) : le laisser s'ouvrir
       par-dessus la page désignée n'apporte rien et masque la cible. */
    function surContexte(e) {
      if (e.target && e.target.closest && e.target.closest("#bug-bandeau")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function finir() {
      if (!selection.length) return;
      termine = true;
      var fiches = selection.map(function (d) { return d.fiche; });
      /* On part en LAISSANT les intercepteurs branchés : le click qui
         suit le dernier pointerup (déjà en file) reste neutralisé —
         un tap sur « Supprimer » ne peut RIEN déclencher ; la
         navigation abandonne de toute façon ces écouteurs. */
      [voile, surlign, bandeau].forEach(function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      document.documentElement.style.cursor = "";
      document.documentElement.classList.remove("rb-selection");
      if (btn) btn.style.display = "";
      partir(fiches);
    }
    function annuler() {
      termine = true;
      selection.forEach(function (d) {
        if (d.el) { try { d.el.style.outline = ""; d.el.style.outlineOffset = ""; } catch (e) {} }
      });
      selection = [];
      document.removeEventListener("pointermove", surMouvement, true);
      document.removeEventListener("pointerdown", surPointeurBas, true);
      document.removeEventListener("pointerup", surPointeurHaut, true);
      document.removeEventListener("click", surClic, true);
      document.removeEventListener("keydown", surEchap, true);
      document.removeEventListener("contextmenu", surContexte, true);
      [voile, surlign, bandeau].forEach(function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      document.documentElement.style.cursor = "";
      document.documentElement.classList.remove("rb-selection");
      if (btn) btn.style.display = "";
    }

    document.addEventListener("pointermove", surMouvement, true);
    document.addEventListener("pointerdown", surPointeurBas, true);
    document.addEventListener("pointerup", surPointeurHaut, true);
    document.addEventListener("click", surClic, true);
    document.addEventListener("keydown", surEchap, true);
    document.addEventListener("contextmenu", surContexte, true);
    if (btnRetirer) btnRetirer.addEventListener("click", retirerDernier);
    if (btnFinir) btnFinir.addEventListener("click", finir);
    var btnAnnuler = $("bug-bandeau-x");
    if (btnAnnuler) btnAnnuler.addEventListener("click", annuler);
  }

  /* ---------- Bouton flottant ---------- */
  function init() {
    if (!$("bug-btn")) {
      injecterStyle();
      var b = document.createElement("a");
      b.id = "bug-btn";
      b.href = "#bug";
      b.title = CONFIG.libelleBouton;
      b.setAttribute("aria-label", CONFIG.libelleBouton);
      b.textContent = "🐛";
      b.addEventListener("click", function (e) {
        e.preventDefault();
        modaleChoix();
      });
      document.body.appendChild(b);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
