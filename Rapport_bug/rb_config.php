<?php
// ============================================================
// rb_config.php — réglages du dossier « Rapport_bug »
// ------------------------------------------------------------
// SEUL fichier à modifier après avoir copié le dossier dans un
// nouveau projet. Une clé absente reprend sa valeur par défaut
// (déclarée en tête de bugs.php).
//
// Ce fichier est du PHP : son contenu n'est jamais servi en
// clair par le serveur (seul le tableau retourné est utilisé).
// ============================================================
return [

    /* Mot de passe de la page de rapports.
       ''  → AUCUNE protection (développement local uniquement).
       Les deux formes marchent :
         - texte en clair,        ex. 'mon-mot-de-passe'
         - empreinte password_hash(), ex. '$2y$10$…'
           (recommandé : php -r "echo password_hash('…', PASSWORD_DEFAULT);") */
    'mot_de_passe' => '',

    /* URL du bouton « ← » de l'en-tête ('' = bouton masqué).
       Ex. 'index.php', '../admin.php', '/tableau-de-bord.php'. */
    'retour' => '',

    /* Libellés de l'en-tête. */
    'sur_titre' => '// administration · retours',
    'titre'     => 'Rapports de bug',

    /* Fichier de stockage (JSON) — SÉPARÉ des données métier.
       Le dossier data/ est protégé par son propre .htaccess. */
    'stockage'  => __DIR__ . '/data/rapports_bug.json',

    /* Version applicative comparée à celle du rapport (badge
       « ⚠ signalé depuis X (actuel : Y) »). '' → lue dans
       ../service-worker.js (VERSION = "…") si le fichier existe. */
    'version'   => '',

    /* Fuseau horaire des horodatages PHP. '' → celui du serveur.
       Utile quand l'hébergeur est en UTC : 'Europe/Zurich'. */
    'fuseau'    => '',

    /* Bornes (client non digne de confiance). */
    'max_rapports'    => 200,
    'max_description' => 4000,
    'max_contexte'    => 24000,
];
