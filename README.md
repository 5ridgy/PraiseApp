# Partitions

Appli web (PWA) hors ligne pour iPad : on choisit un recueil, on tape un numéro, la partition s'ouvre.

## Installation sur l'iPad
1. Ouvrir https://5ridgy.github.io/PraiseApp/ dans **Safari**.
2. Partager › **Sur l'écran d'accueil**.
3. Lancer l'appli depuis son icône, toucher **Recueils** et importer chaque PDF depuis l'app Fichiers.

Les PDF restent stockés sur l'iPad (IndexedDB) et ne sont jamais envoyés en ligne.
Ensuite l'appli fonctionne sans connexion.

## Table des chants
`data/tables.json` contient, pour chaque recueil, numéro → titre, page de début.
Une fois une table validée (champ `pages` renseigné), l'appli ne fait plus aucune détection.

Pour la construire :
1. Sur l'iPad, importer le PDF : l'appli applique la règle du recueil
   (H&C : numéro en gros en haut à gauche ; HeC A4 : « Hymnes et cantiques » n° X ; Reflets : numéro en haut à gauche).
2. Vérifier, corriger les numéros manquants (ouvrir le chant › « Corriger »).
3. Recueils › **Exporter la table**, puis `python3 tools/freeze.py table-hc.json` et publier.

Rendu des PDF : [pdf.js](https://mozilla.github.io/pdf.js/) 3.11 (Apache-2.0), dans `vendor/`.
