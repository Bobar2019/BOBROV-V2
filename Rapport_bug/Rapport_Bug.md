# Rapport_Bug — fonction transférable « rapports de bug »

> **En une phrase :** l'utilisateur tapote l'élément qui le gêne, décrit le
> problème en trois mots, et le développeur reçoit le rapport avec l'élément
> exactement identifié, son contexte technique complet et zéro ambiguïté.

Ce dossier est un **paquet autonome** : copié tel quel dans un nouveau projet,
il fournit la fonction entière (bouton flottant, sélection d'élément, page de
réception, stockage, exports). Aucune bibliothèque, aucun build, aucune
dépendance à l'application d'origine.

Écrit après la mise en service réelle sur ddero.ch (22.10.2026) : le dossier
contient la version **généralisée** du code, pas seulement une copie.

---

## 0. Contenu du dossier

| Fichier | Rôle | À modifier ? |
|---|---|---|
| `Rapport_Bug.md` | ce document : spécification + mode d'emploi | — |
| `bugs.php` | **page de réception + backend** (5 routes, session, CSRF, stockage JSON) | non |
| `rb_config.php` | **les réglages** (mot de passe, retour, libellés, bornes) | **oui, seul fichier à toucher** |
| `js/bug-report.js` | **le module** : bouton 🐛, modale, sélection, capture du contexte | rarement (CONFIG en tête) |
| `data/.htaccess` | interdit l'accès HTTP direct au stockage | non |

Prérequis : un serveur **PHP 7.3+** avec un dossier `data/` inscriptible, et des
pages HTML/JS quelconques. Le stockage est un simple fichier JSON — aucun SGBD.

---

## 1. Le problème que ça résout

Un utilisateur non-technique signale un bug ainsi :

> « Le champ est trop petit » / « ça déborde » / « j'aime pas la couleur »

**Quel champ ?** Où ça déborde ? Sur quelle page ? Quelle version de l'app ?
Était-il hors-ligne ? Y avait-il une erreur JavaScript ? Chaque question
manquante = un aller-retour de messages et un diagnostic à l'aveugle.

Avec le rapport interactif, le même utilisateur tapote l'élément et le
développeur reçoit : la **fiche exacte de l'élément** (id, classes, texte,
libellé, chemin dans la page), la **page**, la **version applicative**, les
**20 dernières erreurs JS**, l'état **réseau**, le **document en cours** et
l'**appareil**.

Deux cas réels, corrigés sans **une seule** question de clarification :

| Rapport | Phrase de l'utilisateur | Diagnostic obtenu |
|---|---|---|
| `bg_20261022_133818` | « cette inscription déborde sur le champ supérieur » | `p#ed-date-limite` → `.note-valide` avait un `margin-top` négatif (−8px) |
| `bg_20261022_134422` | « je voudrais cela 2x plus gros » | `header.entete > span.entete-logo > img` → LE logo du cockpit, parmi tous ceux du site |

La seconde ligne montre le point clé : l'élément n'avait **ni id ni classe** —
c'est le **chemin de parents** qui a levé l'ambiguïté. Ce chemin ne doit jamais
être retiré de la fiche.

---

## 2. La mise en page à conserver (`bugs.php`)

La page de réception se compose de **cinq zones**, dans cet ordre. C'est cette
mise en page qui est reprise telle quelle dans le nouveau projet.

```
┌──────────────────────────────────────────────────────────────────┐
│ [←]  // ADMINISTRATION · RETOURS                    Déconnexion  │  barre
│      Rapports de bug                                             │  supérieure
├──────────────────────────────────────────────────────────────────┤
│  Nouveau rapport                                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Page : devis.php      Date : 2026-10-22 15:37              │  │  carte
│  │ Version de l'app : pwa-13-…    Réseau : en ligne           │  │  contexte
│  │ Synchro : —           Document en cours : devis DEV-2026-002│  │  (grid)
│  │ ┌──────────────────────────────────────────────────────────┐│  │
│  │ │ 🎯 Élément signalé : p#ed-date-limite.note-valide        ││  │  carte
│  │ │ « VALABLE JUSQU'AU 17.11.2026 … »                         ││  │  élément
│  │ │ div.editeur-grille > div.col-editeur > form > p#ed-date-… ││  │
│  │ └──────────────────────────────────────────────────────────┘│  │
│  └────────────────────────────────────────────────────────────┘  │
│  Description du bug                                              │
│  [ zone de texte, 120 px mini, redimensionnable ]                │
│  [ Envoyer le rapport ]  [ Abandonner ]                          │
├──────────────────────────────────────────────────────────────────┤
│  Rapports enregistrés · 3                                        │
│  [⬇︎ .json] [📋 Copier le JSON] [📋 Copier TXT] [⬇︎ .txt] [Tout supprimer] │
│  ▸ 03.11 12:03  [bugs.php]  « cette tuile est trop petite »  🎯 a#tuile │
│  ▸ 03.11 11:55  [cockpit.php] « … »                          🎯 a#tuile │
├──────────────────────────────────────────────────────────────────┤
│                        (toast de confirmation, bas centre)        │
└──────────────────────────────────────────────────────────────────┘
```

**Règles de la mise en page** (elles ont une raison, pas seulement une esthétique) :

- **Barre supérieure** : bouton retour à gauche (38 px, masqué si
  `retour` est vide dans `rb_config.php`), sur-titre en monospace cyan
  (`// administration · retours`), titre 19 px, déconnexion discrète à droite.
- **Section « Nouveau rapport »** : c'est la **seule** zone qui apparaît
  au retour du bouton 🐛. Sans contexte en attente, elle affiche un message
  d'explication (« aucun rapport en cours, utilisez le bouton 🐛 ») au lieu
  d'un formulaire vide.
- **Carte de contexte** : grille `repeat(auto-fit, minmax(220px, 1fr))`,
  couples clé/valeur (`Page :`, `Date :`, `Version de l'app :`, `Réseau :`,
  `Synchro :`, `Document en cours :`). Le contexte est **affiché, jamais
  modifiable** : une valeur éditée serait un contexte falsifié.
- **Carte d'élément** : pleine largeur (`grid-column: 1 / -1`), monospace,
  fond cyan 7 %, bordure cyan 30 %, radius 10 px. Elle affiche `tag#id.classes`
  + texte visible + libellé de champ + **chemin de parents**.
- **Description** : `<textarea>` sur la page, **jamais dans la modale** — une
  modale avec textarea est étouffante sur iPad. `maxlength="4000"`.
- **Section « Rapports enregistrés »** : barre d'outils de 5 boutons discrets
  (exports + tout supprimer) puis **un `<details>` par rapport**. Le résumé
  tient sur une ligne : date mono, page en pastille, description tronquée,
  élément. Le corps est fait de blocs `<pre>` (Description, Élément, Contexte,
  Erreurs JS, Compléments) : du texte brut échappé, lisible et copiable.
- **Confirmation destructrice = double clic** (« Confirmer la suppression ? »
  pendant 4 s), jamais un `confirm()` natif : sur iPad il casse le flux et
  certains navigateurs le bloquent dans une PWA.
- **Palette** : fond `#05070a`, texte `#e8eef1`, cyan `#00D6F2` / `#50E8F5`,
  bleu `#00A3F7`, gris faibles `#8b979e` / `#6d7d8d`, alerte `#e8a06a`.
  Polices : `Space Grotesk` (titres), `Inter` (texte), `JetBrains Mono` (données).

> Toute cette mise en page est déjà écrite dans `bugs.php` — les feuilles de
> style sont **inline** pour que le fichier reste unique et transférable.

---

## 3. Le parcours utilisateur

```
N'importe quelle page surveillée
        │
        ▼
   Bouton 🐛 flottant (bas droite, z-index 900)  ──tapoté──┐
                                                           ▼
                         « Sélectionner les éléments de l'interface
                                qui posent problème ? »
                                 │        │        │
                              [Non]    [Oui]   [Annuler]
                                 │        │        │
                    rapport simple      │      rien ne se passe
                                 │        ▼
                                 │   MODE SÉLECTION
                                 │   bandeau bas « 🎯 Tapotez les éléments » (0)
                                 │   survol = cadre cyan + nom de l'élément
                                 │   tap = ajoute l'élément (liseré + compteur)
                                 │   [↩ Retirer] [✓ Terminer] [✕ Annuler] · Échap
                                 │        │
                                 ▼        ▼
              ┌──────────────────────────────────────────────┐
              │  bugs.php : contexte pré-rempli + description │
              │  [Envoyer]  → enregistré                      │
              │  hors-ligne → file locale, départ auto        │
              └──────────────────────────────────────────────┘
```

Trois décisions d'UX à conserver :

1. **Trois réponses, pas deux.** « Non » (rapport simple) et « Annuler » ne font
   PAS la même chose. Un deux-choix force l'action et génère des clics parasites.
2. **La sélection est un MODE**, pas un état caché : bandeau visible, sortie
   possible (✕ ou Échap), page **non modifiée** si on annule.
3. **Le bouton 🐛 est masqué pendant le mode sélection** — sinon on peut
   « tapoter le bouton bug avec le bouton bug ».
4. **Le bandeau est collé en bas**, pas en haut : en haut il recouvrait la
   barre de navigation (logo, badges, thème) et, comme il s'exclut de sa
   propre interception, ces éléments devenaient impossibles à désigner.

---

## 4. Le modèle de données

Tout est capté sans rien demander à l'utilisateur.

### 4.1 Le contexte (posé par le module, transporté par `localStorage`)

```json
{
  "page": "devis.php",
  "date": "2026-10-22T13:37:14.993Z",
  "version": "pwa-13-2026-10-22",
  "element": {
    "tag": "p",
    "id": "ed-date-limite",
    "classes": ["note-valide", "mono"],
    "texte": "VALABLE JUSQU'AU 17.11.2026 · ARRONDI 5CTS : ACTIVÉ",
    "label": "",
    "type": "",
    "chemin": "div.editeur-grille > div.col-editeur > form#form-devis > p#ed-date-limite"
  },
  "elements": [],
  "reseau": true,
  "attente": 0,
  "doc": { "type": "devis", "numero": "DEV-2026-002" },
  "erreurs": [],
  "agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) …"
}
```

| Champ | À quoi ça sert au diagnostic |
|---|---|
| `page` + `date` | où et quand |
| `version` | **distinguer un bug d'un cache périmé** (badge « ⚠ signalé depuis pwa-X (actuel : pwa-Y) ») |
| `element` / `elements` | LE cœur : désignation sans ambiguïté (1 élément = `element`, 2+ = `elements`) |
| `reseau` | un bug « hors-ligne » est souvent une file de synchro, pas un bug |
| `attente` | nombre de documents en attente d'envoi (facultatif) |
| `doc` | document en cours — **type + numéro SEULEMENT, jamais de données client** |
| `erreurs` | 20 dernières erreurs JS en mémoire → bug visuel (vide) ou logique (plein) |
| `agent` | appareil / navigateur — certains bugs ne sont que sur un seul |

### 4.2 Le rapport (ce que le serveur écrit)

```json
{
  "id": "bg_20261103_120354_c5fe0c",
  "ts": 1793700234,
  "page": "cockpit.php",
  "description": "cette tuile est trop petite",
  "contexte": { "…": "objet ci-dessus" },
  "complements": [ { "ts": 1793700299, "texte": "précision ajoutée plus tard" } ]
}
```

Bornes appliquées **côté serveur** (le contexte est du JSON forgé par le client) :
description ≤ 4000 car., contexte ≤ 24 Ko (au-delà : `{"tronque":true}`),
200 rapports max (les plus anciens éjectés), 20 compléments par rapport.

---

## 5. Implémentation dans un nouveau projet — 6 gestes

### 5.1 Copier le dossier

Copier `Rapport_bug/` **tel quel** à la racine web du nouveau projet (ou dans un
sous-dossier, peu importe : le module retrouve `bugs.php` tout seul).

```
nouveau-projet/
├── index.php, admin/…            ← pages existantes
└── Rapport_bug/
    ├── bugs.php
    ├── rb_config.php
    ├── js/bug-report.js
    └── data/            (inscriptible par PHP : chmod 755, fichiers 664)
```

### 5.2 Régler `rb_config.php`

```php
return [
    'mot_de_passe' => '$2y$10$…',      // vide = aucune protection (local seulement)
    'retour'       => '/admin.php',     // '' = pas de bouton ←
    'sur_titre'    => '// administration · retours',
    'titre'        => 'Rapports de bug',
    'version'      => '',               // '' = lue dans ../service-worker.js
    'fuseau'       => 'Europe/Zurich',
];
```

Empreinte du mot de passe :

```bash
php -r "echo password_hash('le-mot-de-passe', PASSWORD_DEFAULT), PHP_EOL;"
```

### 5.3 Charger le module sur les pages à surveiller

Une ligne avant les scripts de la page :

```html
<script src="/Rapport_bug/js/bug-report.js?v=1"></script>
```

Et, pour que le badge de version fonctionne, la version applicative sur le body :

```html
<body data-version="v42-2026-11-03">
```

> Sans `data-version`, tout fonctionne — le rapport indique juste « inconnue ».
> Avec elle, un rapport venant d'un cache périmé est signalé d'un coup d'œil.

### 5.4 Déclarer le document en cours (optionnel, très utile)

Dans chaque page d'édition, après le chargement du module :

```js
window.bugDocCourant = function () {
  return docEnCours
    ? { type: docEnCours.type, numero: docEnCours.numero }   // JAMAIS de données client
    : null;
};
```

Le rapport dira alors « sur quel document j'étais » (`devis DEV-2026-002`).

### 5.5 Tester (3 minutes)

1. Ouvrir une page surveillée → le 🐛 apparaît en bas à droite.
2. 🐛 → **Non** → la page de rapports s'ouvre, le formulaire est là, envoyer.
3. 🐛 → **Oui** → tapoter un bouton **destructif** (« Supprimer ») : il ne doit
   **rien** déclencher ; le bandeau compte 1 ; « ✓ Terminer » → rapport.
4. Couper le réseau → envoyer un rapport → toast « gardé » ; rétablir le réseau
   → le rapport part seul (≤ 20 s).

### 5.6 Ajouter la tuile / le badge (optionnel)

Dans un hub ou un menu d'administration, un lien vers `bugs.php` et un compteur :

```php
$nb = count(rb_lire(__DIR__ . '/Rapport_bug/data/rapports_bug.json')['rapports']);
// badge : 🐛 3 à corriger   /   ✓ aucun bug signalé
```

Le JSON est relu à la volée : aucun état à maintenir.

---

## 6. Sous le capot — les 7 briques

### 6.1 Un module autonome

`js/bug-report.js` s'auto-suffit : **styles injectés** (bouton, modale, bandeau,
voile), zéro dépendance CSS, garde anti-double-chargement (`window.RB_BUG`).
Il fonctionne donc même sur une page qui n'a pas la charte du projet.

Tout ce qui change d'un projet à l'autre est dans `CONFIG` (en tête) et peut être
surchargé par une page :

```html
<script>window.RB_BUG_CONFIG = { pageRapport: "/outils/bugs.php", cleContexte: "monapp_ctx_v1" };</script>
<script src="/Rapport_bug/js/bug-report.js?v=1"></script>
```

| Clé `CONFIG` | Défaut | Rôle |
|---|---|---|
| `pageRapport` | `…/bugs.php` du dossier du module | où atterrit le rapport |
| `cleContexte` | `rb_contexte_v1` | clé `localStorage` — **une par application sur le domaine** |
| `attributVersion` | `data-version` | attribut du `<body>` portant la version |
| `titreModale`, `questionModale`, `libelleBouton` | FR | libellés |

### 6.2 Le piège à erreurs

```js
window.addEventListener("error", function (e) {
  erreurs.push({ msg: e.message, src: e.filename, ligne: e.lineno, ts: Date.now() });
  if (erreurs.length > 20) erreurs.shift();      // les 20 dernières
});
```

En **mémoire uniquement** (jamais `localStorage`) : les erreurs jointes sont
celles de la session en cours sur la page du bug ; une page rechargée repart à zéro.

### 6.3 LE cœur : le mode sélection

Il faut que l'utilisateur « tapote » un élément **sans** que ce tapotement ne
déclenche l'élément (imaginer tapoter « Supprimer » pour signaler que ce bouton
est mal placé).

**a. Un voile qui ne bloque rien** — `pointer-events: none` : le pointeur
« traverse » le voile, c'est `document.elementFromPoint(x, y)` qui désigne
l'élément réel.

**b. Neutraliser tout, en phase capture, sur trois événements :**

```js
function intercepter(e) {
  if (e.target.closest && e.target.closest("#bug-bandeau")) return;  // ✕ du bandeau actif
  e.preventDefault();
  e.stopImmediatePropagation();          // l'élément réel ne verra JAMAIS l'événement
}
document.addEventListener("pointerdown", intercepter, true);   // true = PHASE CAPTURE
document.addEventListener("click",      intercepter, true);
```

La capture passe **avant** tout listener posé sur l'élément. On intercepte
`pointerdown` **et** `click` : sur iPad, sans le `pointerdown`, le tap « passe »
parfois malgré le `click` bloqué.

`stopImmediatePropagation` n'est pas décoratif : `preventDefault` seul laisse
les autres listeners s'exécuter. Symptôme observé sur le cockpit : un clic
**maintenu** sur une tuile armait l'appui long de la page (500 ms → mode
réorganisation des tuiles) pendant qu'on croyait simplement la désigner. Pour
la même raison `contextmenu` est intercepté (clic droit / appui long).

**c. Capturer au `pointerup` d'un tap immobile** (correctif majeur) : certains
navigateurs avalent le `click` après `preventDefault(pointerdown)`, et sur iPad
le focus d'un champ peut faire défiler la page avant le `click`. On ne capture
donc que si le doigt n'a pas bougé de plus de 12 px — un glissement reste un
défilement normal.

```js
if (dx * dx + dy * dy > 144) return;      // > 12 px = défilement, pas une capture
var el = document.elementFromPoint(e.clientX, e.clientY);
if (el) ajouter(el);                      // multi-sélection : le mode continue
```

**d. Le bandeau s'exclut de sa propre interception** — sinon impossible d'annuler.
**e. Sortie propre** — ✕ ou Échap retire voile, bandeau, liserés et listeners ;
la page redevient normale, **rien n'est envoyé**.

### 6.4 La fiche d'élément — tous ses « noms »

```js
var f = {
  tag: el.tagName.toLowerCase(),                 // type
  id: el.id || "",                               // identifiant technique
  classes: String(el.className).trim().split(/\s+/).slice(0, 6),   // max 6
  texte: String(el.innerText || el.textContent).trim().replace(/\s+/g, " ").slice(0, 120),
  label: "",                                     // champ : label[for] → closest(label) → placeholder
  type: "",                                      // input/select/textarea
  chemin: "div.editeur-grille > div.col-editeur > form#form-devis > p#ed-date-limite"
};
```

Le **chemin** (4 niveaux de parents, `tag#id` ou `tag.classe`) est
indispensable : c'est lui qui identifie un élément **sans id ni classe**
(une icône, une image…).

### 6.5 Le passage de page

On ne peut pas passer un objet à une page chargée par `location.href` :
le pont est `localStorage` (clé unique, effacée à l'envoi ou à l'abandon).

```js
localStorage.setItem(CONFIG.cleContexte, JSON.stringify(ctx));
window.location.href = CONFIG.pageRapport;
```

> **Piège de chemin** : `location.href` est résolu par rapport à la **page**,
> pas au script. Le module calcule donc son défaut depuis sa **propre URL**
> (`document.currentScript.src` → `…/Rapport_bug/bugs.php`), ce qui le rend
> juste depuis n'importe quel sous-dossier. Si vous surchargez `pageRapport`,
> donnez un chemin absolu (`/outils/bugs.php`).

### 6.6 La page de réception

- contexte pré-rempli (lecture seule) + fiche(s) d'élément(s) + description ;
- **file hors-ligne** : hors réseau, le rapport est stocké
  (`rb_attente_v1`) puis rejoué au retour — au chargement (+4 s), sur
  l'événement `online` (+3 s), puis toutes les 20 s ; les essais sont comptés
  (max 12) pour ne pas boucler sur une session expirée ;
- **exports** `.json` (brut) et `.txt` (lisible), **copie** JSON / TXT condensé
  via `navigator.clipboard` avec repli `execCommand` ;
- **compléments** : on peut ajouter une information oubliée, horodatée,
  en append-only — le rapport original n'est jamais modifié ;
- **suppression** par rapport et « tout supprimer », double clic de confirmation.

### 6.7 Côté serveur — 5 routes et de la méfiance

```
GET  ?ajax=bug_liste                  → { ok, rapports: [...] }
POST action=bug_signaler              → description + contexte (JSON string)
POST action=bug_completer             → id + texte (horodaté)
POST action=bug_supprimer | bug_vider → suppressions
POST action=rb_login | rb_logout      → session locale (si mot_de_passe défini)
```

Règles à reproduire **telles quelles** :

- **session + CSRF** sur toute écriture (`hash_equals`, jeton en session) ;
- réponse `{ ok:false, auth:true }` quand la session a expiré — le client
  **garde** alors le rapport en file au lieu de le perdre ;
- stockage dans un fichier **SÉPARÉ des données métier**
  (`data/rapports_bug.json`, `LOCK_EX`) : un rapport corrompu ne casse rien ;
- dossier `data/` protégé par `.htaccess` (`Require all denied`) ;
- **bornes** : tailles, nombre de rapports, nombre de compléments ;
- le contexte est du JSON **arbitraire** : il est reçu, borné, stocké tel quel,
  et **rendu intégralement échappé** côté page (jamais de HTML brut) ;
- aucune donnée personnelle dans le contexte : `doc` = type + numéro uniquement.

### 6.8 Portage vers un autre backend (Node, Python, .NET…)

Le contrat est minuscule : il suffit de respecter les **routes** du § 6.7 et la
forme du § 4. Le module n'appelle que :

- `POST <pageRapport>` (form-urlencoded ou multipart) avec
  `action`, `csrf`, `description`, `contexte` ;
- `GET <pageRapport>?ajax=bug_liste` renvoyant `{ ok:true, rapports:[…] }`.

Le reste (page, liste, exports, file hors-ligne) est du JavaScript côté client
déjà écrit dans `bugs.php` : on peut le réutiliser tel quel en servant les
mêmes routes depuis un autre langage.

---

## 7. Les pièges déjà résolus (et leurs leçons)

1. **`getElementById` n'existe que sur `document`.** `(racine || document).getElementById(…)`
   avec `racine` = un ÉLÉMENT → `TypeError`. Un helper DOM qui reçoit une
   « racine » doit utiliser `querySelector` (valable sur `document` **et** sur
   un élément).

2. **Un voile plein écran bloque `elementFromPoint`.** D'où `pointer-events: none` :
   le voile est visuel, PAS un obstacle.

3. **Intercepter en phase capture, sur `pointerdown` ET `click`.**
   Sinon un listener posé directement sur un bouton dangereux reçoit
   l'événement avant vous.

4. **Capturer au `pointerup` d'un tap immobile (≤ 12 px).** Le tap sur un champ
   « ne faisait rien » : après `preventDefault(pointerdown)`, le `click` n'arrive
   pas toujours, et sur iPad le focus déplace la page. Un glissement doit rester
   un défilement.

5. **Exclure le bandeau de sa propre interception** : chaque intercepteur
   commence par `if (e.target.closest("#bug-bandeau")) return;` — sinon plus
   d'annulation possible.

6. **Masquer le bouton 🐛 pendant le mode sélection** — sinon on peut le tapoter
   lui-même et rouvrir la modale.

7. **Les id sans id.** Beaucoup d'éléments utiles (icônes, images) n'ont NI id NI
   classe : sans le **chemin de parents**, le rapport est inexploitable.

8. **Le contexte est une donnée NON fiable** : borné côté serveur (taille,
   nombre) et échappé à l'affichage. Ne jamais l'insérer avec `innerHTML` brut.

9. **Cache-busting.** Si le projet a un `?v=` ou un service worker : à CHAQUE
   modification du module, incrémenter le `?v=`, la `VERSION` du service worker
   et son précachage — sinon les anciens caches servent l'ancien module et les
   rapports arrivent avec de vieux bugs.

10. **Le chemin de la page de rapport.** `location.href = "bugs.php"` est résolu
    par rapport à la page courante ; le module calcule donc son défaut depuis sa
    propre URL. En cas de surcharge, chemin absolu.

---

## 8. Checklist de tests (avant de dire « c'est fini »)

- [ ] Le 🐛 apparaît sur **toutes** les pages surveillées, au-dessus des modales.
- [ ] **Non** → formulaire pré-rempli, envoi, apparition immédiate dans la liste.
- [ ] **Oui** → tapoter un bouton destructif ne déclenche **rien** ; le compteur s'incrémente.
- [ ] Multi-sélection : 3 éléments → le rapport les liste tous les trois avec leurs chemins.
- [ ] « ↩ Retirer » enlève le dernier ; « ✕ Annuler » et Échap n'envoient rien et
      rendent la page intacte (liserés retirés).
- [ ] Ouvrir le rapport : `id`, classes, texte, libellé, chemin, contexte, appareil.
- [ ] Provoquer une erreur JS avant de signaler : elle apparaît dans « Erreurs JavaScript ».
- [ ] Couper le réseau → envoi → « gardé » ; rétablir → départ automatique.
- [ ] Version différente (`data-version` modifié) → badge « ⚠ signalé depuis … ».
- [ ] Compléter un rapport puis vérifier l'horodatage du complément.
- [ ] Export `.json` et `.txt` lisibles ; « copier TXT condensé » donne le format
      court (id, el, où, ctx, err, agent).
- [ ] `data/rapports_bug.json` **non** accessible en direct (403).
- [ ] Une session expirée ne **perd pas** le rapport (message clair + file).
- [ ] Sur iPad : tap sur un champ **capture** l'élément (pas de « ça ne fait rien »).

---

## 9. Ce que ça ne fait PAS (limites assumées)

- **pas de capture d'écran** (lourdeur, données personnelles — la fiche
  d'élément suffit presque toujours) ;
- **pas d'annotation sur image** (même raison) ;
- les erreurs JS ne couvrent que la page courante (mémoire volontairement non
  persistée) ;
- pas de notification automatique (email/Telegram) : le hub affiche le compteur,
  c'est suffisant pour un usage solo.

---

## 10. Correspondance avec l'application d'origine (ddero.ch)

Le paquet est la version **généralisée**. Pour retrouver le code d'origine,
côté ddero.ch :

| Ici | Origine ddero.ch | Écarts |
|---|---|---|
| `js/bug-report.js` | `js/bug-report.js` | `CONFIG` en tête (`pageRapport` auto, clés `rb_*`), `RB_FILE_LIRE` remplace `APP.fileLire` |
| `bugs.php` | `bugs.php` + les fonctions `ddero_api_bug_*` de `app_noyau.php` | CSS et routes réunis dans un seul fichier ; connexion par mot de passe local |
| `rb_config.php` | — | nouveau (les constantes étaient dans `app_noyau.php`) |
| `data/.htaccess` | `data/.htaccess` | identique |

Différences volontairement conservées côté ddero.ch : session « cockpit »,
tuile du hub avec badge, bouton « Bug interface client » (`index.html?bug=1`)
et précachage du module par le service worker.

---

## 11. Extension naturelle : du « bug » au « changement d'interface »

Le même formulaire sert à demander une modification (« cette tuile est trop
petite », « je voudrais cela 2× plus gros »). Deux champs suffisent à transformer
un rapport de bug en carnet de retouches :

- ajouter une colonne **statut** (`à faire` / `fait`) et ne pas la remplir par
  défaut, sinon les rapports « faits » polluent le compteur ;
- garder les rapports **après correction** : la description d'origine est la
  meilleure documentation de la décision d'interface.

C'est exactement ainsi que la tuile « Rapports de bug » du cockpit ddero.ch
fonctionne : elle compte les rapports en attente, et chaque correction laisse
une trace écrite de ce qui a été demandé, pourquoi, et par qui.

---

*Dossier constitué le 03.11.2026. Le module et la page ont été éprouvés en
production sur ddero.ch (iPad + Mac) avant généralisation. Les deux parcours
critiques ont été rejoués sur un harnais de test : le clic sur un bouton
destructif reste neutralisé en mode sélection, et le contexte JSON produit
(page, version, éléments, chemins, appareil) arrive complet sur la page cible.*
