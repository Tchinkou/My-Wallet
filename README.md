# My Wallet — portefeuille personnel

Application mobile (PWA) de gestion financière personnelle : argent disponible, dépenses, revenus, prêts accordés, dettes et patrimoine net.

- **Aucun serveur, aucun compte, aucune synchronisation.** Les données restent dans le stockage local du téléphone (IndexedDB), chiffrées avec AES-GCM 256 bits.
- **Hors ligne** après le premier chargement (Service Worker).
- **Installable sur Android** (Chrome, Samsung Internet), pensée pour le Samsung Galaxy S23+.
- HTML, CSS et JavaScript natifs, sans framework ni étape de compilation.

## Structure

```
index.html            Page unique
manifest.json         Manifeste PWA (nom, icônes, plein écran)
service-worker.js     Cache hors ligne (incrémenter VERSION à chaque déploiement)
_headers              En-têtes de sécurité Cloudflare Pages (CSP stricte)
css/style.css         Styles (thèmes sombre et clair)
js/app.js             Démarrage, verrouillage, écrans, formulaires
js/calculations.js    Moteur de calcul centralisé (pur, testé)
js/database.js        Accès IndexedDB, état par défaut
js/security.js        PIN, chiffrement, empreinte (WebAuthn)
js/backup.js          Sauvegarde chiffrée, restauration, export CSV
js/charts.js          Graphiques SVG
js/ui.js              Formatage, icônes, fenêtres, notifications
assets/icons/         Icônes de l'application
tests/                Tests unitaires et de bout en bout
```

## Règles de calcul

Tout est recalculé à partir du **journal des opérations** et des **soldes de départ** des comptes. Aucun indicateur n'est saisi ni stocké : modifier ou supprimer une ancienne opération met tout à jour.

| Opération | Argent disponible | Créances | Dettes | Revenus / dépenses du mois |
|---|---|---|---|---|
| Dépense | − montant | | | dépense |
| Revenu | + montant | | | revenu |
| Transfert entre comptes | neutre | | | aucun |
| Prêt accordé | − montant | + montant | | aucun |
| Remboursement reçu | + montant | − montant | | aucun |
| Dette enregistrée | + montant **seulement si** l'argent a été reçu sur un compte | | + montant | aucun |
| Remboursement effectué | − montant | | − montant | aucun |

- **Argent disponible** = somme des soldes de tous les comptes (dont l'épargne). L'écran distingue l'argent *utilisable* (hors comptes de type Épargne) et l'*épargne*, qui peut être masquée.
- **Patrimoine net** = disponible + créances + autres actifs (facultatifs) − dettes.
- **Fortune totale** = disponible + créances + autres actifs (ce que vous possédez, avant dettes).
- **Épargne mensuelle** = revenus du mois − dépenses du mois ; **taux d'épargne** = épargne / revenus.
- Un remboursement ne peut pas dépasser le reste dû ; supprimer un prêt ou une dette supprime aussi ses remboursements.

Scénario de contrôle (testé automatiquement) : 50 000 DA au départ, dépense 5 000, revenu 20 000, prêt 10 000 à Ahmed, remboursement d'Ahmed 3 000, dette de 15 000 envers Karim, remboursement de 5 000 à Karim → **disponible 53 000 · créance Ahmed 7 000 · dette Karim 10 000 · patrimoine net 50 000**.

## Sécurité

- Une clé de données aléatoire (256 bits) chiffre toutes les données (AES-GCM).
- Cette clé est elle-même chiffrée par une clé dérivée du **code PIN** (PBKDF2-SHA-256, 600 000 itérations, sel aléatoire). Le PIN n'est jamais stocké, même haché.
- **Empreinte digitale** via WebAuthn (authentificateur de plateforme). Si le navigateur gère l'extension **PRF**, l'empreinte libère un secret qui déchiffre réellement la clé. Sinon, l'application passe en mode « verrou simple » (clé non exportable conservée par le navigateur) et le signale clairement.
- L'application ne lit ni l'empreinte ni le code de déverrouillage Android : c'est le système qui vérifie l'utilisateur.
- Verrouillage automatique (inactivité ou passage en arrière-plan), verrouillage manuel, mode discrétion, délai croissant après 5 PIN erronés.
- La CSP (`connect-src 'self'`) interdit techniquement tout envoi de données vers un autre site. L'application ne fait aucun appel réseau en dehors du chargement de ses propres fichiers.

**Limites** : un PIN court peut être deviné par quelqu'un qui copierait les fichiers du navigateur (préférez 6 chiffres ou plus) ; une PWA ne peut pas bloquer les captures d'écran ; effacer les données du navigateur efface le portefeuille. Sans PIN, aucune récupération n'est possible : faites des sauvegardes.

## Sauvegarde

- **Exporter** : fichier `.json` chiffré (AES-GCM, clé dérivée d'un mot de passe choisi, PBKDF2 600 000 itérations), enregistré dans *Téléchargements*.
- **Restaurer** : vérification du mot de passe, de l'intégrité (tag AES-GCM + empreinte SHA-256) et de la cohérence des opérations, puis confirmation avant remplacement.
- **CSV** : historique lisible dans Excel (séparateur `;`). Ce fichier n'est pas chiffré.
- Un bandeau rappelle de sauvegarder (fréquence réglable).

## Déploiement sur Cloudflare Pages (gratuit)

Le dépôt ne contient que des fichiers statiques : aucune commande de build.

1. Connectez-vous sur <https://dash.cloudflare.com> (compte gratuit).
2. Menu **Workers & Pages** › **Create** › onglet **Pages** › **Connect to Git**.
3. Autorisez GitHub et sélectionnez le dépôt **My-Wallet**.
4. Réglages du build :
   - *Production branch* : `main`
   - *Framework preset* : `None`
   - *Build command* : laisser **vide**
   - *Build output directory* : `/`
5. **Save and Deploy**. L'application est disponible en HTTPS sur `https://<nom-du-projet>.pages.dev`.
6. Ne pas activer *Web Analytics* : l'application n'en a pas besoin (et la CSP le bloquerait).

Chaque `git push` sur `main` redéploie automatiquement. **Pensez à incrémenter `VERSION` dans `service-worker.js`** (et `APP_VERSION` dans `js/app.js`) : l'application affichera alors « Nouvelle version disponible ».

> Important : l'adresse (domaine) fait partie de l'identité des données. Les données et l'empreinte enregistrées sur `xxx.pages.dev` ne sont pas visibles depuis une autre adresse. Si vous changez de domaine, exportez une sauvegarde avant et restaurez-la sur la nouvelle adresse.

## Installation sur le Samsung S23+

- **Chrome** : ouvrez l'adresse › menu ⋮ › *Installer l'application*.
- **Samsung Internet** : ouvrez l'adresse › menu ≡ › *Ajouter la page à* › *Écran d'accueil* (ou l'icône ⤓ dans la barre d'adresse).
- Dans l'application : Réglages › *Installer l'application* (bouton automatique quand le navigateur le propose).

## Développement et tests

```bash
# Serveur local (le chiffrement et le Service Worker exigent localhost ou HTTPS)
python3 -m http.server 8080

# Tests unitaires du moteur de calcul (Node 18+)
node --test tests/calculations.test.mjs

# Test de bout en bout du scénario complet (Playwright installé)
node tests/e2e.cjs http://localhost:8080/
```

Le test de bout en bout réalise l'initialisation, le scénario obligatoire, la modification et la suppression d'opérations (avec annulation), le verrouillage, le chiffrement du stockage, la sauvegarde/restauration, l'export CSV, le mode hors ligne, et vérifie qu'aucune requête ne part vers un tiers.
