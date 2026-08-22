; build/installer.nsh
; -----------------------------------------------------------------------
; electron-builder's NSIS template lets you hook in custom logic at named
; points via these macros. We use it here for one thing: kill any running
; NexGrab.exe BEFORE installing or uninstalling.
;
; Why this matters: NSIS does not do this by default. If NexGrab is
; running (including minimized to the tray, which is its default close
; behavior) when the user runs a new installer or the uninstaller, the
; running process just keeps going — install can silently fail to
; overwrite locked files, and "successful" uninstall can leave a zombie
; process still running with the old code. That's exactly what happened
; during testing: uninstall reported success while the app kept running.
; -----------------------------------------------------------------------

!macro customInit
  ; Runs when the INSTALLER starts, before any files are touched — kills
  ; a running old version so this install isn't blocked by locked files.
  nsExec::Exec 'taskkill /F /IM NexGrab.exe /T'
!macroend

!macro customUnInstall
  ; Runs during uninstall — kills any running instance so the uninstall
  ; can't finish while the app is still using its own files, and so it
  ; doesn't leave a running zombie process behind afterward.
  nsExec::Exec 'taskkill /F /IM NexGrab.exe /T'
!macroend
