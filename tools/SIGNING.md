# 🔏 Signature du code SDM (guide de préparation)

L'installateur `SDM_Setup.exe` actuel n'est **pas signé**. Cette page explique
comment signer les futures releases pour supprimer l'avertissement SmartScreen.

## 1. Obtenir un certificat

- Option recommandée : certificat « Code Signing » (OV ou EV) auprès d'une
  autorité (Sectigo, DigiCert, SSL.com…).
- Recevoir un fichier `.pfx` (contient clé privée + certificat), protégé par
  mot de passe.
- Alternative gratuite insuffisante : un certificat auto-signé ne supprime
  PAS l'avertissement SmartScreen (il ne sert qu'aux tests internes).

## 2. Signer lors du build

`electron-builder` signe automatiquement dès que ces variables existent :

```powershell
$env:CSC_LINK = "C:\certs\sdm-code-signing.pfx"
$env:CSC_KEY_PASSWORD = "mot-de-passe-du-certificat"
npm.cmd run dist
```

Vérification après build (SDK Windows) :

```powershell
signtool verify /pa dist\SDM_Setup_*.exe
```

## 3. Réglages déjà en place dans package.json

- `win.publisherName` a été supprimé : invalide avec electron-builder 26
  (était aussi la cause de l'échec `Invalid configuration object ... win should be null`).
  L'éditeur affiché provient de `author` / `copyright` ; la signature passe
  uniquement par `CSC_LINK` + `CSC_KEY_PASSWORD`, voir §2).

## 4. Le jour où le certificat arrive

1. Placer le `.pfx` hors du dépôt (ex. `C:\certs\`), jamais commité.
2. Exporter `CSC_LINK` + `CSC_KEY_PASSWORD` (variables d'environnement ou
   secrets CI : `CSC_LINK` en base64, `CSC_KEY_PASSWORD` en secret).
3. Relancer `npm run dist` : les binaires sont signés sans changer le code.
4. Optionnel : horodatage (défaut `http://timestamp.digicert.com`) déjà géré
   par electron-builder.
