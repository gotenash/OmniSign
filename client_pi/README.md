# Guide d'installation du Client Raspberry Pi - OmniSign

Ce guide détaille pas à pas l'installation et la configuration du client d'affichage dynamique OmniSign sur un Raspberry Pi (recommandé : Raspberry Pi 4 ou Pi 5 sous Raspberry Pi OS (Bookworm ou Trixie) avec Desktop).

---

## Prérequis

1.  Un **Raspberry Pi** avec carte microSD installée.
2.  **Raspberry Pi OS (Bookworm / Trixie) avec bureau** (Desktop) installé et configuré (avec l'utilisateur par défaut `pi` ou un utilisateur avec droits sudo).
3.  Une connexion internet sur le Pi pour l'installation des paquets.
4.  L'**URL du serveur CMS** et la **clé API de l'écran** générée depuis l'interface d'administration d'OmniSign.

---

## Étape 1 : Préparation et copie des fichiers du client

1.  Connectez-vous sur votre Raspberry Pi (soit directement avec un clavier/écran, soit via SSH).
2.  Créez le répertoire de destination et clonez le dépôt (ou copiez-y les fichiers du répertoire `client_pi`) :
    ```bash
    mkdir -p /home/pi/omnisign
    ```
3.  Assurez-vous que les fichiers suivants sont bien présents dans le répertoire `/home/pi/omnisign/` :
    *   `installer_pi.sh` (Script interactif de configuration et d'installation)
    *   `setup_pi.sh` (Script système d'installation automatique)
    *   `sync-engine.js` (Moteur de synchronisation Node.js)
    *   `player.html` (Lecteur HTML local autonome)
    *   `start_player.sh` (Script de lancement de Chromium)
    *   Le dossier `img/` contenant `splashscreen.png`

---

## Étape 2 : Lancement de l'assistant d'installation interactif

Le client fournit un script interactif qui simplifie la configuration de l'écran et lance automatiquement l'installation système.

1.  Rendez le script d'installation exécutable :
    ```bash
    chmod +x /home/pi/omnisign/installer_pi.sh
    ```
2.  Lancez le script :
    ```bash
    /home/pi/omnisign/installer_pi.sh
    ```

### Configuration des paramètres :

Le script vous posera trois questions pour configurer votre écran :

1.  **Type de Serveur** :
    *   Choisissez `1` si votre serveur CMS est sur le réseau local (vous saisirez son adresse IP et son port, ex: `192.168.1.50:3000`).
    *   Choisissez `2` si votre serveur possède un nom de domaine internet ou local (ex: `https://omnisign.exemple.com`).
2.  **Clé API** : Saisissez la clé API d'affichage générée dans l'interface d'administration d'OmniSign.
3.  **Identifiant de l'appareil (Device ID)** : Entrez un nom unique pour identifier ce Raspberry Pi (ex: `pi-accueil-ecran1`).

*Le script génère alors un fichier `setup.txt` dans la partition de boot du Pi (`/boot/firmware/setup.txt`) contenant ces variables.*

---

## Étape 3 : Installation automatique du système

Une fois la configuration saisie, le script interactif lance en arrière-plan le script système `setup_pi.sh` avec les droits `sudo`. Ce script réalise les opérations suivantes :

1.  **Mise à jour et installation des dépendances** :
    *   Installation de **Node.js v20** (si absent).
    *   Installation de **Chromium-browser**, du serveur X11, du gestionnaire de fenêtres Openbox et de LightDM.
    *   Installation des outils de contrôle d'affichage Wayland/X11 (`grim`, `wlopm`, `wlr-randr`, `x11-xserver-utils`, `unclutter`).
2.  **Optimisation mémoire (SWAP)** : Augmentation automatique du swap à 1024 Mo pour éviter tout plantage ou manque de mémoire du navigateur.
3.  **Configuration graphique** : Activation du pilote KMS (`vc4-kms-v3d`) nécessaire à la fluidité de l'affichage.
4.  **Service de Synchronisation** : Création et activation d'un service système Systemd (`omnisign-sync.service`) pour exécuter `sync-engine.js` en arrière-plan à chaque démarrage.
5.  **Autologin et démarrage du lecteur** :
    *   Configuration de LightDM pour connecter automatiquement l'utilisateur `pi` sans mot de passe au démarrage.
    *   Configuration d'Openbox et création d'un raccourci d'autostart (`omnisign.desktop`) pour exécuter `start_player.sh` dès l'ouverture de session.
6.  **Sécurisation de la mise en veille** : Désactivation des économiseurs d'écran et de la veille automatique d'affichage (gestion assurée directement par le CMS).

---

## Étape 4 : Premier démarrage et finalisation

À la fin de l'installation, le script vous propose de redémarrer le système.

1.  Validez le redémarrage (ou tapez `sudo reboot`).
2.  **Au boot** :
    *   Le système démarre en mode graphique et ouvre automatiquement la session de l'utilisateur `pi`.
    *   Le service `omnisign-sync.service` démarre et initialise le serveur web local sur `http://127.0.0.1:8080`.
    *   Le script de démarrage `start_player.sh` attend que le serveur local soit prêt (avec une pause de sécurité de 12s intégrée en cas de reboot récent pour laisser la puce graphique s'initialiser) puis lance **Chromium en mode Kiosk plein écran**.
3.  **Sur l'interface d'administration (CMS)** :
    *   Votre écran doit apparaître comme connecté et en ligne.
    *   Associez-lui un diaporama / une playlist pour lancer l'affichage des médias.

---

## Dépannage et commandes utiles

### Vérifier le statut du moteur de synchronisation
```bash
sudo systemctl status omnisign-sync.service
```

### Consulter les logs du client
```bash
# Voir les logs en temps réel de la synchronisation locale
journalctl -u omnisign-sync.service -f -n 100
```

### Consulter les logs de Chromium (Kiosk)
Si l'écran est noir ou blanc, ou si un diaporama ne charge pas :
```bash
cat /home/pi/omnisign/chromium.log
```

### Redémarrer manuellement le lecteur ou forcer l'allumage
```bash
sudo systemctl restart omnisign-sync.service
```

---

## Problèmes connus (Troubleshooting)

### Écran noir ou résolution incorrecte sur une TV ancienne (problème d'EDID)

**Symptôme** : L'écran connecté reste noir (ou affiche "Pas de signal") alors que les captures d'écran effectuées depuis le CMS fonctionnent, ou la résolution est bloquée sur une valeur basse (ex: `1024x768`) sans possibilité de passer en 1920x1080.

**Cause** : Le Raspberry Pi ne parvient pas à lire les informations d'affichage (EDID) de la TV (câble HDMI défectueux, adaptateur micro-HDMI de faible qualité, ou protocole HDMI de la TV trop ancien).

**Solution** : Forcer la résolution 1920x1080 au niveau du noyau Linux :
1. Connectez-vous en SSH sur le Raspberry Pi.
2. Ouvrez le fichier de configuration de démarrage :
   ```bash
   sudo nano /boot/firmware/cmdline.txt
   ```
3. À la fin de la **ligne unique** existante (ne faites pas de retour à la ligne), ajoutez un espace puis le paramètre suivant :
   ```text
   video=HDMI-A-1:1920x1080@60e
   ```
   *(Si vous utilisez le deuxième port HDMI du Pi, remplacez `HDMI-A-1` par `HDMI-A-2`)*
4. Sauvegardez (`Ctrl + O`, `Entrée`) et quittez (`Ctrl + X`).
5. Redémarrez le Pi :
   ```bash
   sudo reboot
   ```
