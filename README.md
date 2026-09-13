# SDM — Sekou Download Manager

Gestionnaire de téléchargement moderne pour Windows, inspiré d'Internet
Download Manager (IDM), avec une **extension navigateur** qui fonctionne sous
**Chrome, Edge, Brave et Firefox**.

![Logo](assets/app-icon.png)

## ✨ Fonctionnalités

| Fonctionnalité | Description |
| --- | --- |
| ⚡ Multi-connexions | Fichier découpé en **8 à 32 segments** téléchargés en parallèle (`Range`) |
| ⏸️ Pause / ▶️ Reprise | Reprise partielle à partir du dernier octet écrit sur le disque |
| 🔁 Reprise après coupure | Les fichiers `.part.000 … .part.031` + méta-données sont restaurés au redémarrage |
| 🗂️ Catégories | Tri automatique : `Vidéo`, `Audio`, `Documents`, `Archives`, `Images`, `Applications`, `Autres` |
| 🧭 Extension navigateur | Détection des téléchargements + notification « Télécharger avec SDM ? », clic droit, boutons sur les pages |
| 🎬 Capture vidéo | Vidéos directes et flux HLS (`.m3u8`) — uniquement si légalement autorisé |
| 📊 Interface moderne | Statistiques, vitesse, temps restant, filtres, notifications toast |

## 🚀 Démarrage rapide

```powershell
# 1. Dépendances
npm.cmd install

# 2. Icônes (PNG + ICO Windows)
npm.cmd run icons

# 3. Lancer SDM
npm.cmd start
```

Les fichiers sont enregistrés dans `Téléchargements\SDM\<Catégorie>\`.

> Si `npm` est bloqué par la stratégie PowerShell, utilisez `npm.cmd`.

## 📦 Installation (version publique)

1. Télécharger **`SDM_Setup.exe`** depuis la page des releases.
2. L'exécuter, choisir le dossier d'installation, puis lancer **SDM**
   (raccourci Bureau / menu Démarrer).
3. Les fichiers sont enregistrés dans `Téléchargements\SDM\<Catégorie>\`.

Construire l'installateur depuis les sources :

```powershell
npm.cmd install
npm.cmd run icons
npm.cmd run dist
# → dist\SDM_Setup_1.0.0.exe
```

## 🔏 Signature du code (préparation)

L'installateur et l'exécutable ne sont **pas encore signés** : Windows
SmartScreen affichera un avertissement (« éditeur inconnu ») à la première
installation. Pour signer une future release :

1. Obtenir un certificat de signature de code (fichier `.pfx`).
2. Définir les variables d'environnement avant `npm run dist` :

```powershell
$env:CSC_LINK = "C:\certs\sdm.pfx"
$env:CSC_KEY_PASSWORD = "mot-de-passe-du-certificat"
npm.cmd run dist
```

`electron-builder` signera automatiquement l'exécutable et l'installateur.
Voir `tools/SIGNING.md` pour le détail.

## 🧩 Installer l'extension

### Chrome / Edge / Brave
1. Ouvrir `chrome://extensions` (ou `edge://extensions`, `brave://extensions`).
2. Activer le **mode développeur** (en haut à droite).
3. Cliquer sur **« Charger l'extension non empaquetée »**.
4. Sélectionner le dossier `extension` de ce projet.

### Firefox
1. Ouvrir `about:debugging#/runtime/this-firefox`.
2. Cliquer sur **« Charger un module complémentaire temporaire »**.
3. Sélectionner `extension\manifest.json`.

### Utilisation de l'extension
- **Détection automatique** : à chaque téléchargement du navigateur, une
  notification demande *« Télécharger avec SDM ? Oui, avec SDM / Non, continuer »*.
- **Clic droit** 🔗 → *« Télécharger ce lien avec SDM »*.
- **Bouton « ⬇ SDM »** apparaît à côté des liens de fichiers (ZIP, PDF, vidéos…).
- **Détection vidéo** : à activer dans les Options de l'extension (case à
  cocher). ⚠️ *N'utilisez que pour des contenus que vous êtes autorisé à
  télécharger (respectez les droits d'auteur et les conditions d'utilisation).*

L'extension communique avec SDM via un serveur local `http://127.0.0.1:26545`
(l'application doit être ouverte).

## 📁 Structure du projet

```
SDM/
├── main.js                → processus principal (fenêtre, IPC, serveur HTTP)
├── download-engine.js     → moteur multi-connexions (segments 8-32, reprise)
├── local-server.js        → serveur local pour l'extension (port 26545)
├── preload.js             → pont sécurisé contextBridge / IPC
├── renderer/              → interface utilisateur (HTML/CSS/JS)
├── extension/             → extension navigateur (Manifest V3)
│   ├── manifest.json
│   ├── background.js      → détection des téléchargements, notifications
│   ├── content/           → boutons « ⬇ SDM » sur les pages
│   ├── popup/             → fenêtre de l'extension
│   └── options/           → réglages (connexions, détection vidéo…)
├── tools/                 → scripts internes (icônes, smoke-test, non distribués)
│   ├── generate-icons.js→ générateur d'icônes PNG (sans dépendance)
│   ├── generate-win-icon.js → assemble assets/app-icon.ico
│   ├── check-ico.js     → validation de l'ICO Windows
│   └── smoke-test.js    → test de fumée moteur + serveur local
└── assets/              → app-icon.png (256) + app-icon.ico (Windows)
```

## 🔌 API du serveur local

| Méthode | Point | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Vérifier que SDM est disponible |
| `GET/POST` | `/api/add?url=…&connections=16` | Démarrer un téléchargement |
| `GET` | `/api/list` | Liste des téléchargements en cours |

## ⚖️ Notes légales

Téléchargez uniquement des fichiers et des vidéos que vous avez le droit de
télécharger. La fonctionnalité de capture vidéo (HLS) est désactivée par
défaut et est destinée aux contenus libres de droits ou expressément autorisés.