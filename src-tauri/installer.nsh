; Grabbit 2.x (Electron) kuruluysa yeni sürümden önce sessizce kaldırılır. İndirme listesi, ayarlar ve
; video motoru %APPDATA%\Grabbit içinde olduğu için korunur (eski kaldırıcı uygulama verisini silmez).
!define OLD_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\3f3860f4-6a28-5587-860e-12f0be52ead5"

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $0 HKCU "${OLD_UNINSTALL_KEY}" "QuietUninstallString"
  StrCmp $0 "" old_done
    DetailPrint "Grabbit 2 kaldırılıyor…"
    ExecWait '$0'
    ; Eski kaldırıcı kendini geçici klasöre kopyalayıp sürebilir: kaydı silinene kadar bekle (en fazla 30 sn)
    StrCpy $1 0
    old_wait:
      ReadRegStr $2 HKCU "${OLD_UNINSTALL_KEY}" "DisplayName"
      StrCmp $2 "" old_done
      IntOp $1 $1 + 1
      IntCmp $1 60 old_done
      Sleep 500
      Goto old_wait
  old_done:
!macroend
