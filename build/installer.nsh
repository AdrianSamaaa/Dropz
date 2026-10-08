; Extra uninstaller step for Drops (included by electron-builder).
; By now the uninstaller has closed Drops; its files are still in place.
; Unless this is just an update: put back every app Drops took off the desktop
; and remove its "start with Windows" entry.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-cleanup'
  ${endIf}
!macroend
