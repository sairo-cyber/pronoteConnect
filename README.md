# PronoteConnect

PronoteConnect relie un compte PRONOTE personnel à ChatGPT, en lecture seule. Il permet à ChatGPT de consulter les devoirs, cours, salles, notes, périodes et documents scolaires depuis le web, le téléphone ou un ordinateur.

Le mot de passe EduConnect est saisi uniquement sur le site officiel. Il n'est ni lu ni enregistré par PronoteConnect. Le jeton PRONOTE et la clé du tunnel restent chiffrés sur l'ordinateur.

## Installation

Le système actuellement pris en charge est Linux avec systemd. Une seule commande clone le dépôt puis installe les dépendances, Chromium, le client officiel Secure MCP Tunnel, l'icône et le service de démarrage automatique :

```bash
git clone <adresse-du-dépôt-github> pronoteconnect && cd pronoteconnect && ./install.sh
```

Si le dépôt est déjà cloné :

```bash
cd pronoteconnect && chmod +x install.sh && ./install.sh
```

L'installateur télécharge sa propre version de Node.js si nécessaire. Il ne demande ni ChatGPT Desktop, ni Codex, ni serveur public. L'architecture du serveur, du stockage et du tunnel est compatible avec Windows, mais l'installateur et le démarrage automatique Windows ne sont pas encore fournis.

Une fois l'installation terminée, l'interface s'ouvre sur <http://127.0.0.1:37421>. Elle guide les étapes restantes et ouvre les pages officielles utiles :

1. créer un Secure MCP Tunnel OpenAI et une clé limitée à `Tunnels Read` et `Tunnels Use` ;
2. activer le mode développeur ChatGPT et créer le plugin personnel `PronoteConnect` avec ce tunnel ;
3. choisir le lycée ou coller son URL PRONOTE ;
4. se connecter dans la fenêtre Chromium officielle ENT/EduConnect.

Les identifiants OpenAI et EduConnect sont toujours saisis par l'utilisateur sur leurs pages officielles. PronoteConnect vérifie ensuite que chaque étape fonctionne.

Le dépôt GitHub peut être public, mais chaque utilisateur crée son propre tunnel privé et son propre plugin de développement. Secure MCP Tunnel sert aux connexions privées et aux tests ; il ne permet pas de publier un unique plugin dans le catalogue public ChatGPT. Une publication dans ce catalogue demanderait un serveur MCP HTTPS public distinct, qui n'est ni créé ni exposé par PronoteConnect.

## Utilisation

Après la configuration, l'interface peut être fermée. PronoteConnect et son tunnel restent silencieusement actifs en arrière-plan et redémarrent avec la session Linux. L'icône PronoteConnect permet de rouvrir l'interface, redémarrer ou arrêter le service, et lancer la désinstallation.

Dans une nouvelle conversation ChatGPT, activez le plugin PronoteConnect puis demandez par exemple :

- `quels devoirs ai-je pour demain ?`
- `dans quelle salle est mon prochain cours ?`
- `quelles sont mes dernières notes ?`
- `lis le document joint au devoir de français`

Le même plugin personnel fonctionne sur les surfaces ChatGPT web et mobile prises en charge. Le PC doit rester allumé et connecté à Internet. Même sur ce PC, ChatGPT passe par le Secure MCP Tunnel ; aucun port entrant n'est ouvert.

Pour ouvrir uniquement l'interface de configuration depuis un appareil du même tailnet, activez un relais privé Tailscale sur le PC :

```bash
sudo tailscale serve --bg --yes --tcp=37421 tcp://127.0.0.1:37421
```

L'adresse à ouvrir est `http://<adresse-tailscale-du-pc>:37421`. Obtenez cette adresse avec `tailscale ip -4`. Cette option n'utilise pas Tailscale Funnel et ne rend pas l'interface publique.

## Ce qui tourne sur le PC

- le service PronoteConnect expose huit outils MCP strictement en lecture seule ;
- Pawnote-LTS communique avec PRONOTE et renouvelle le jeton mobile ;
- Secure MCP Tunnel maintient une connexion HTTPS sortante privée vers OpenAI ;
- le plugin personnel indique à ChatGPT quand appeler ces outils ;
- la petite interface locale sert uniquement à installer, reconnecter ou dépanner.

Les données persistantes se trouvent dans `.data/` et les dépendances autonomes dans `.runtime/`. Ces dossiers sont ignorés par Git. Le coffre utilise le keyring Linux lorsqu'il est disponible, sinon un stockage local chiffré avec permissions restrictives.

## Sécurité

PronoteConnect n'offre aucune fonction d'écriture dans PRONOTE. Il ne lit pas les formulaires EduConnect, ne conserve aucun cookie de connexion, ne produit ni capture, ni vidéo, ni trace Playwright. Les résultats MCP ne contiennent ni jeton, ni URL privée, ni identifiant interne sensible.

Les pièces jointes sont limitées à 15 Mio, à l'origine PRONOTE validée et aux fichiers déjà listés. PDF, DOCX et texte sont extraits localement. Les documents sont traités comme du contenu non fiable, jamais comme des instructions. Les images renvoient actuellement leurs métadonnées sans OCR.

Le projet est indépendant et n'est affilié ni à Index Éducation, ni à EduConnect, ni à Papillon. Il utilise `@blockshub/pawnote-lts@1.6.4` et est distribué sous licence `GPL-3.0-or-later`.

## Arrêt et suppression

La désinstallation conserve par défaut le dépôt et les données locales :

```bash
./install.sh --uninstall
```

Pour supprimer aussi le jeton, la clé du tunnel, le cache et les autres données locales :

```bash
./install.sh --uninstall --delete-data
```

L'interface permet aussi de vider uniquement le cache des documents, de déconnecter PRONOTE ou de supprimer son jeton.

## Développement et vérification

Les tests n'utilisent jamais un vrai compte PRONOTE :

```bash
npm ci
npm run verify
npm run start:fake
```

`npm run verify` vérifie les types, compile le projet, exécute les tests factices et recherche les motifs ressemblant à des secrets. Le test réel EduConnect est déclenché uniquement depuis l'interface et attend l'intervention explicite de l'utilisateur.

Références officielles : [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [création des plugins](https://developers.openai.com/plugins/build/plugins), [authentification des plugins](https://developers.openai.com/plugins/build/auth) et [surfaces ChatGPT prises en charge](https://learn.chatgpt.com/fr-FR/docs/plugins).
