@echo off
title Assistant d'Installation - OmniSign Serveur
color 0A
cls

echo ============================================================
echo         ASSISTANT D'INSTALLATION DU SERVEUR OMNISIGN
echo ============================================================
echo.
echo  Cet assistant va installer les composants requis et configurer
echo  votre serveur de diffusion dynamique OmniSign.
echo.
echo ------------------------------------------------------------
echo  Etape 1/3 : Verification et mise a jour de Node.js
echo ------------------------------------------------------------

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Node.js n'est pas encore installe.
    where winget >nul 2>nul
    if %errorlevel% equ 0 (
        echo [INFO] Installation automatique de Node.js LTS via winget...
        call winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    ) else (
        echo [ERREUR] Node.js n'a pas ete detecte.
        echo Ouverture de la page de telechargement officielle de Node.js...
        start https://nodejs.org/
        echo Une fois Node.js installe, relancez cet assistant.
        pause
        exit /b
    )
) else (
    for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
    echo [OK] Node.js est actuellement installe (%NODE_VERSION%).
    where winget >nul 2>nul
    if %errorlevel% equ 0 (
        echo [INFO] Verification et mise a jour vers la derniere version LTS...
        call winget upgrade OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements >nul 2>nul
    )
)

echo.

echo ------------------------------------------------------------
echo  Etape 2/3 : Installation des modules et dependances
echo ------------------------------------------------------------
echo  Veuillez patienter pendant le telechargement des modules...
echo.

if exist "%~dp0server\package.json" (
    cd /d "%~dp0server"
) else (
    cd /d "%~dp0"
)

call npm install
if %errorlevel% neq 0 (
    color 0C
    echo.
    echo [ERREUR] Des erreurs sont survenues lors de l'installation npm.
    echo Veuillez verifier votre connexion internet et reessayer.
    echo.
    pause
    exit /b
)

echo.
echo [INFO] Initialisation de la base de donnees...
call node server.js --init-only >nul 2>nul

set ADMIN_PWD=
if exist "admin_password.txt" (
    set /p ADMIN_PWD=<admin_password.txt
)

echo.
echo [OK] Toutes les dependances ont ete installees avec succes.
echo.

echo ------------------------------------------------------------
echo  Etape 3/3 : Creation du raccourci sur le Bureau
echo ------------------------------------------------------------

set "LAUNCHER_SCRIPT=%~dp0Lancer_OmniSign.bat"
if not exist "%LAUNCHER_SCRIPT%" (
    set "LAUNCHER_SCRIPT=%~dp0server\Lancer_OmniSign.bat"
)

powershell -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut([System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), 'OmniSign Serveur.lnk'));$s.TargetPath='%LAUNCHER_SCRIPT%';$s.WorkingDirectory='%~dp0server';$s.IconLocation='cmd.exe,0';$s.Save()" >nul 2>nul

echo [OK] Raccourci "OmniSign Serveur" cree sur votre Bureau !
echo.

echo ============================================================
echo          INSTALLATION DU SERVEUR TERMINÉE !
echo ============================================================
echo.
if defined ADMIN_PWD (
    echo ============================================================
    echo             IDENTIFIANTS DE PREMIERE CONNEXION
    echo.
    echo   Utilisateur  : admin
    echo   Mot de passe : %ADMIN_PWD%
    echo.
    echo   Note : Ce mot de passe est enregistre dans :
    echo   %%CD%%\admin_password.txt
    echo   Veuillez le modifier immediatement apres votre connexion !
    echo ============================================================
    echo.
)
echo Vous pouvez lancer le serveur a tout moment depuis le raccourci
echo "OmniSign Serveur" presente sur votre bureau.
echo.
set /p REPO="Voulez-vous demarrer le serveur OmniSign maintenant ? (O/N) : "
if /i "%REPO%"=="O" (
    echo.
    echo Demarrage du serveur...
    start "" "%LAUNCHER_SCRIPT%"
) else (
    echo.
    echo Merci d'avoir installe OmniSign !
    pause
)
