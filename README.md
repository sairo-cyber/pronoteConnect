# PronoteConnect

PronoteConnect relie un compte PRONOTE personnel à ChatGPT, en lecture seule. Il permet de demander ses devoirs, son emploi du temps, ses salles, ses notes, ses périodes et ses documents depuis ChatGPT sur le web, un téléphone ou un ordinateur.

Le serveur, le jeton PRONOTE et la clé du tunnel restent sur l’ordinateur de l’utilisateur. Le mot de passe EduConnect est saisi uniquement dans la fenêtre officielle ENT/EduConnect et n’est jamais lu par PronoteConnect.

## Fonctionnement

```text
ChatGPT ou Codex
       │
       ▼
plugin personnel PronoteConnect
       │
       ▼
Secure MCP Tunnel OpenAI
       │ connexion sortante chiffrée
       ▼
ordinateur de l’utilisateur
       │
       ├── serveur MCP en lecture seule
       ├── Pawnote-LTS
       └── jeton PRONOTE chiffré localement
```

Le même trajet est utilisé sur le PC, le web et le téléphone. Aucun port entrant public n’est ouvert. Le PC doit rester allumé et connecté à Internet pendant l’utilisation.

## Systèmes pris en charge

| Système | Installation | Démarrage automatique | Icône de contrôle |
| --- | --- | --- | --- |
| Windows 11 x64 ou ARM64 | `installer.cmd` | oui | oui |
| Windows 10 22H2 x64, compatibilité | `installer.cmd` | oui | oui |
| Linux x64 ou ARM64 avec systemd | `./install.sh` | oui | oui |

L’installateur télécharge ses propres versions de Node.js, Chromium, Electron et du client officiel Secure MCP Tunnel dans le dossier choisi. ChatGPT Desktop et Codex ne sont pas requis. Seuls le raccourci et le réglage de démarrage automatique sont enregistrés par le système.

Il faut seulement :

- un compte ChatGPT compatible avec le mode développeur et les plugins personnels ;
- un compte OpenAI Platform autorisé à créer un Secure MCP Tunnel ;
- un compte PRONOTE accessible par ENT/EduConnect ;
- une connexion Internet.

## Installation sur Windows

Ces instructions visent Windows 11. Windows 10 22H2 reste pris en charge par le projet, mais la version actuelle de Playwright ne le classe plus parmi ses systèmes officiellement testés. L’installateur vérifie donc réellement que Chromium démarre et s’arrête avec un message clair si ce n’est pas le cas. Ni Node.js, ni Codex, ni ChatGPT Desktop ne sont requis.

### Première installation à copier-coller

1. Ouvrez **PowerShell** depuis le menu Démarrer.
2. Installez Git avec cette commande :

```powershell
winget install --id Git.Git -e --source winget
```

3. Fermez PowerShell, puis ouvrez-le à nouveau.
4. Copiez-collez ces trois lignes :

```powershell
Set-Location "$HOME\Documents"
git clone https://github.com/sairo-cyber/pronoteConnect.git PronoteConnect
Set-Location .\PronoteConnect; .\installer.cmd
```

5. Acceptez la demande administrateur Windows.
6. Attendez le message de réussite. Le navigateur s’ouvre automatiquement sur l’assistant.

Si `winget` n’existe pas, téléchargez Git depuis [git-scm.com](https://git-scm.com/download/win), conservez les choix proposés par l’installateur, puis reprenez à l’étape 3.

### Installation sans Git

1. Sur GitHub, cliquez sur **Code**, puis **Download ZIP**.
2. Extrayez entièrement l’archive dans le dossier de votre choix.
3. Ouvrez le dossier extrait et double-cliquez sur `installer.cmd`.

Windows demande une validation administrateur afin d’enregistrer le démarrage automatique. Le serveur reste dans la session de l’utilisateur pour que la fenêtre EduConnect puisse s’afficher. Si Windows signale que le script open source n’est pas signé, vérifiez qu’il vient bien de ce dépôt avant de l’exécuter.

L’installateur crée une entrée PronoteConnect dans le menu Démarrer et une tâche de démarrage automatique. Une petite icône près de l’horloge permet ensuite d’ouvrir l’interface, démarrer, redémarrer, arrêter ou désinstaller le service.

## Installation sur Linux

Ces instructions sont entièrement automatisées sur Debian ou Ubuntu avec systemd. Node.js, Chromium, Electron et leurs bibliothèques sont installés par le projet.

1. Ouvrez un terminal.
2. Copiez-collez cette commande :

```bash
sudo apt-get update && sudo apt-get install -y git curl xz-utils ca-certificates
```

3. Copiez-collez ensuite ces quatre lignes :

```bash
mkdir -p "$HOME/Documents"
cd "$HOME/Documents"
git clone https://github.com/sairo-cyber/pronoteConnect.git PronoteConnect
cd PronoteConnect && chmod +x install.sh && ./install.sh
```

4. Saisissez votre mot de passe administrateur si Linux le demande pendant l’installation des bibliothèques Chromium.
5. Attendez le message de réussite. Le navigateur s’ouvre automatiquement sur l’assistant.

Sur une autre distribution Linux avec systemd, installez d’abord `git`, `curl`, `xz`, les bibliothèques Chromium et Electron avec le gestionnaire de paquets de la distribution, puis lancez les quatre lignes de l’étape 3.

L’installateur crée un service systemd utilisateur, l’active au démarrage de la session et ajoute l’icône PronoteConnect au menu des applications.

## Configuration guidée

Après l’installation, ouvrez <http://127.0.0.1:37421>. La page affiche une seule étape à la fois et vérifie automatiquement son état. Le bouton **continuer** apparaît lorsque l’étape est terminée. Le petit bouton **passer quand même** permet d’avancer sans la terminer. La barre de progression permet de revenir à n’importe quelle étape.

### 1. Vérifier l’application

Cette étape doit indiquer que le service est actif, que Chromium est disponible et que le démarrage automatique est activé.

### 2. Créer le tunnel privé

1. Cliquez sur **ouvrir les tunnels**.
2. Créez un tunnel nommé `PronoteConnect` sur OpenAI Platform.
3. Copiez son identifiant commençant par `tunnel_`.
4. Cliquez sur **ouvrir les clés**.
5. Créez une clé restreinte avec seulement `Tunnels Read` et `Tunnels Use`.
6. Collez l’identifiant et la clé dans PronoteConnect, puis cliquez sur **enregistrer et démarrer le tunnel**.

La clé n’est affichée qu’une fois par OpenAI. Ne la publiez pas et ne la collez jamais dans une conversation. PronoteConnect la chiffre localement.

### 3. Créer le plugin ChatGPT personnel

1. Activez le mode développeur dans les paramètres de sécurité ChatGPT.
2. Depuis l’interface PronoteConnect, cliquez sur **créer le plugin**.
3. Utilisez le nom `PronoteConnect`.
4. Choisissez **Tunnel**, puis sélectionnez le tunnel créé à l’étape précédente.
5. Choisissez **Aucune authentification**. Le tunnel est déjà privé et rattaché au compte.
6. Acceptez l’avertissement concernant le serveur MCP personnalisé.
7. Créez puis connectez le plugin.
8. Copiez l’adresse de la page du plugin et collez-la dans PronoteConnect.

Chaque utilisateur crée son propre tunnel et son propre plugin personnel. Aucun plugin partagé ne contient de jeton PRONOTE.

### 4. Connecter PRONOTE

1. Recherchez votre ville et sélectionnez votre lycée, ou utilisez directement l’URL PRONOTE fournie par l’établissement.
2. Confirmez l’établissement.
3. Cliquez sur **se connecter avec EduConnect**.
4. Saisissez vos identifiants uniquement dans la fenêtre Chromium officielle qui s’ouvre.
5. Effectuez la validation PRONOTE si elle apparaît.
6. Attendez le message **PRONOTE est connecté** avant de fermer la fenêtre.

PronoteConnect ne lit pas le formulaire EduConnect, ne remplit aucun mot de passe et ne contourne ni CAPTCHA ni double authentification.

## Utilisation

Dans une nouvelle conversation ChatGPT :

1. cliquez sur le bouton `+` du champ de message ;
2. sélectionnez `PronoteConnect` ;
3. posez votre question normalement.

Exemples :

- `quels devoirs ai-je pour demain ?`
- `fais-moi un planning pour terminer mes devoirs cette semaine`
- `dans quelle salle est mon prochain cours ?`
- `quelles sont mes dernières notes ?`
- `lis le document joint au devoir de français`

Le plugin installé sur le compte peut être utilisé sur les surfaces ChatGPT prises en charge. Sur téléphone, utilisez le même compte ChatGPT. Si le plugin vient d’être installé, fermez puis rouvrez l’application ou démarrez une nouvelle conversation.

Dans Codex, démarrez une nouvelle tâche après l’installation ou une mise à jour du plugin. Codex utilise lui aussi le plugin et le tunnel ; aucun second MCP local n’est nécessaire.

## Accès à l’interface avec Tailscale

Tailscale est facultatif et sert uniquement à ouvrir l’interface de configuration depuis un autre appareil du même tailnet.

Si Tailscale est déjà installé au moment de l’installation, ouvrez :

```text
http://ADRESSE_TAILSCALE_DU_PC:37421
```

PronoteConnect n’utilise ni Tailscale Serve ni Tailscale Funnel. Le tunnel OpenAI reste obligatoire pour les demandes provenant de ChatGPT web ou mobile.
N’activez cet accès que sur un tailnet personnel ou composé d’appareils de confiance.

## Mise à jour

PronoteConnect vérifie au maximum toutes les six heures si une nouvelle version stable est publiée sur ce dépôt GitHub. Une notification apparaît dans l’interface, mais rien n’est installé sans confirmation de l’utilisateur. Le bouton ouvre uniquement la publication officielle correspondante.

Avec Git sous Linux :

```bash
git pull
./install.sh
```

Avec Git sous Windows :

```powershell
git pull
.\installer.cmd
```

Sans Git, téléchargez la nouvelle archive, remplacez uniquement les fichiers du programme et relancez l’installateur. Conservez le dossier `.data` pour garder la connexion locale.

## Arrêt et désinstallation

L’icône PronoteConnect permet d’ouvrir, démarrer, redémarrer ou arrêter le service.

Sous Windows :

```powershell
.\installer.cmd -Uninstall
```

Sous Linux :

```bash
./install.sh --uninstall
```

Ces commandes conservent le dépôt et les données locales. Pour supprimer aussi le jeton PRONOTE, la clé du tunnel et le cache :

```powershell
.\installer.cmd -Uninstall -DeleteData
```

```bash
./install.sh --uninstall --delete-data
```

La suppression locale ne supprime pas automatiquement le plugin ni la clé sur les comptes OpenAI. Révoquez-les également dans ChatGPT et OpenAI Platform si vous abandonnez définitivement l’installation.

## Dépannage

### L’interface ne s’ouvre pas

- vérifiez <http://127.0.0.1:37421/health> ;
- relancez PronoteConnect depuis son icône ;
- relancez l’installateur si les dépendances ont été déplacées ;
- ne déplacez pas le dossier après l’installation sans relancer l’installateur.

### Le tunnel reste inactif

- vérifiez que l’identifiant commence par `tunnel_` ;
- recréez une clé possédant `Tunnels Read` et `Tunnels Use` ;
- vérifiez que la clé et le tunnel appartiennent à la même organisation OpenAI ;
- cliquez sur **redémarrer** dans l’interface.

### Le plugin n’apparaît pas

- vérifiez que le mode développeur ChatGPT est activé ;
- vérifiez que le plugin est connecté dans les paramètres ChatGPT ;
- démarrez une nouvelle conversation ;
- sur mobile, relancez l’application ChatGPT.

### PRONOTE demande une nouvelle connexion

Ouvrez l’interface locale et relancez **se connecter avec EduConnect**. Le mot de passe reste saisi sur le site officiel.

## Données et sécurité

PronoteConnect est strictement en lecture seule. Il n’envoie aucun message, ne modifie aucun devoir et ne justifie aucune absence.

Les données persistantes sont placées dans `.data/` et les dépendances autonomes dans `.runtime/`. Ces dossiers sont ignorés par Git. Sous Linux, le jeton PRONOTE et la clé du tunnel utilisent le trousseau système lorsqu’il est disponible. Sous Windows, ils sont protégés par DPAPI et ne peuvent être déchiffrés que par le compte Windows qui les a enregistrés. Si aucun stockage système n’est disponible, l’interface signale explicitement l’utilisation du coffre local chiffré.

Les pièces jointes sont limitées à 15 Mio, aux origines PRONOTE validées et aux documents déjà référencés par PRONOTE. Les URL arbitraires, les traversées de chemins et les redirections externes sont refusées. PDF, DOCX et texte sont extraits localement. Les documents sont toujours considérés comme du contenu non fiable, jamais comme des instructions.

Les éléments suivants sont ignorés par Git et ne doivent jamais être publiés :

- `.data/` ;
- `.runtime/` ;
- `.env` et `.env.*` ;
- `node_modules/` ;
- `dist/` ;
- les journaux, rapports Playwright et résultats de tests.

## Publication sur GitHub

Avant le premier envoi :

```bash
npm ci
npm run verify
git status
```

Le scan de sécurité doit afficher qu’aucun motif de secret concret n’a été détecté. Vérifiez ensuite que `.data/`, `.runtime/` et `.env` n’apparaissent pas dans `git status`.

Configurez enfin votre dépôt distant :

```bash
git remote set-url origin https://github.com/sairo-cyber/pronoteConnect.git
git branch -M main
git push -u origin main
```

La CI GitHub exécute automatiquement la vérification sur Linux et Windows. Elle n’utilise jamais de compte PRONOTE réel.

## Développement

```bash
npm ci
npm run verify
npm run start:fake
```

`npm run verify` vérifie les types, compile le projet, exécute les tests factices et recherche les motifs ressemblant à des secrets. Les tests automatisés n’utilisent jamais le compte scolaire de l’utilisateur.

Les huit outils MCP sont :

- `pronote_connection_status` ;
- `pronote_list_homework` ;
- `pronote_get_homework` ;
- `pronote_get_timetable` ;
- `pronote_list_periods` ;
- `pronote_get_grades` ;
- `pronote_list_attachments` ;
- `pronote_read_attachment`.

Le projet utilise TypeScript, Node.js 22, `@modelcontextprotocol/sdk`, Zod, Playwright et `@blockshub/pawnote-lts`. Il est distribué sous licence `GPL-3.0-or-later` et n’est affilié ni à Index Éducation, ni à EduConnect, ni à Papillon.

## Crédit et réutilisation

Copyright © 2026 sairo-cyber. Le projet peut être utilisé, étudié, modifié et redistribué en conservant le crédit, la licence et les obligations de partage du code source prévues par la GPL. Cette licence est nécessaire parce que Pawnote-LTS, utilisé par PronoteConnect, est lui-même distribué sous GPL-3.0-or-later.

Documentation officielle : [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [création des plugins](https://developers.openai.com/plugins/build/plugins), [authentification](https://developers.openai.com/plugins/build/auth) et [plugins ChatGPT](https://learn.chatgpt.com/fr-FR/docs/plugins).
