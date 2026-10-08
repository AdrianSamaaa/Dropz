; Extra uninstaller step for Drops (included by electron-builder).
; By now the uninstaller has closed Drops; its files are still in place.
; Put back every app Drops took off the desktop, unless this is just an update.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --restore-desktop'
  ${endIf}
!macroend
