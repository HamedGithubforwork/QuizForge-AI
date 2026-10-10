!define QFN_PROTOCOL_KEY "Software\Classes\com.quizfromnotes.desktop.preview"
!define QFN_LOCAL_AI_BACKUP_KEY "Software\Quiz From Notes\Local AI Preview Installer"
!define QFN_INSTALL_STATE_KEY "Software\Quiz From Notes\Local AI Preview Installer State"

!macro customInit
  DeleteRegKey HKCU "${QFN_INSTALL_STATE_KEY}"
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" qfn_check_existing_handler
  Goto qfn_ask_replace

  qfn_check_existing_handler:
  ReadRegStr $0 HKCU "${QFN_PROTOCOL_KEY}\shell\open\command" ""
  StrCmp $0 "" qfn_no_existing_version
  StrCmp $0 '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"' qfn_no_existing_version

  qfn_ask_replace:
  IfSilent qfn_no_existing_version 0
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "A version of Quiz From Notes is already installed.$\r$\n$\r$\nWould you like to replace it with the Local AI version? Your saved data and settings will be kept." IDYES qfn_replace_existing_version IDNO qfn_cancel_install

  qfn_cancel_install:
  Quit

  qfn_replace_existing_version:
  WriteRegStr HKCU "${QFN_INSTALL_STATE_KEY}" "ReplacementConfirmed" "1"
  qfn_no_existing_version:
!macroend

!macro customInstall
  ReadRegStr $0 HKCU "${QFN_PROTOCOL_KEY}\shell\open\command" ""
  StrCmp $0 "" qfn_register_protocol
  StrCmp $0 '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"' qfn_register_protocol

  IfSilent qfn_silent_conflict 0
  ReadRegStr $1 HKCU "${QFN_INSTALL_STATE_KEY}" "ReplacementConfirmed"
  StrCmp $1 "1" qfn_save_previous_handler qfn_unexpected_conflict

  qfn_silent_conflict:
  Abort

  qfn_unexpected_conflict:
  Abort

  qfn_save_previous_handler:
  WriteRegStr HKCU "${QFN_LOCAL_AI_BACKUP_KEY}" "PreviousProtocolCommand" "$0"
  DeleteRegKey HKCU "${QFN_INSTALL_STATE_KEY}"

  qfn_register_protocol:
  DeleteRegKey HKCU "${QFN_INSTALL_STATE_KEY}"
  WriteRegStr HKCU "${QFN_PROTOCOL_KEY}" "" "URL:Quiz From Notes desktop sign-in"
  WriteRegStr HKCU "${QFN_PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr HKCU "${QFN_PROTOCOL_KEY}\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "${QFN_PROTOCOL_KEY}\shell\open\command" ""
  StrCmp $0 '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"' qfn_restore_previous_handler qfn_leave_handler_unchanged

  qfn_restore_previous_handler:
  ReadRegStr $1 HKCU "${QFN_LOCAL_AI_BACKUP_KEY}" "PreviousProtocolCommand"
  StrCmp $1 "" qfn_remove_local_ai_handler qfn_write_previous_handler

  qfn_write_previous_handler:
  WriteRegStr HKCU "${QFN_PROTOCOL_KEY}\shell\open\command" "" "$1"
  DeleteRegKey HKCU "${QFN_LOCAL_AI_BACKUP_KEY}"
  Goto qfn_uninstall_done

  qfn_remove_local_ai_handler:
  DeleteRegKey HKCU "${QFN_PROTOCOL_KEY}"
  DeleteRegKey HKCU "${QFN_LOCAL_AI_BACKUP_KEY}"
  Goto qfn_uninstall_done

  qfn_leave_handler_unchanged:
  DeleteRegKey HKCU "${QFN_LOCAL_AI_BACKUP_KEY}"

  qfn_uninstall_done:
  DeleteRegKey HKCU "${QFN_INSTALL_STATE_KEY}"
!macroend
