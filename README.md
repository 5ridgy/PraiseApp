# Partitions

Appli web (PWA) hors ligne pour iPad : on choisit un recueil, on tape un numéro, la partition s'ouvre.

## Installation sur l'iPad
1. Ouvrir https://5ridgy.github.io/PraiseApp/ dans **Safari**.
2. Partager › **Sur l'écran d'accueil**.
3. Lancer l'appli depuis son icône, toucher **Recueils** et importer chaque PDF depuis l'app Fichiers.

Les PDF restent stockés sur l'iPad (IndexedDB) et ne sont jamais envoyés en ligne.
Ensuite l'appli fonctionne sans connexion.

## Détection des numéros
À l'import, l'appli lit les signets du PDF, puis repère dans le texte les grands numéros
qui se suivent. Un numéro mal placé se corrige depuis la partition (« Corriger »).
La table peut être exportée / importée en JSON depuis l'écran Recueils.

Rendu des PDF : [pdf.js](https://mozilla.github.io/pdf.js/) 3.11 (Apache-2.0), dans `vendor/`.
