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
!ifdef QFN_INSTALL_BUNDLED_MODEL
  IfFileExists "$EXEDIR\${QFN_MODEL_FILE}" qfn_install_bundled_model qfn_bundled_model_missing

  qfn_install_bundled_model:
  CreateDirectory "$APPDATA\Quiz From Notes Preview\local-ai\models"
  IfFileExists "$APPDATA\Quiz From Notes Preview\local-ai\models\${QFN_MODEL_FILE}" qfn_replace_existing_model qfn_move_bundled_model

  qfn_replace_existing_model:
  Delete "$APPDATA\Quiz From Notes Preview\local-ai\models\${QFN_MODEL_FILE}"
  IfFileExists "$APPDATA\Quiz From Notes Preview\local-ai\models\${QFN_MODEL_FILE}" qfn_bundled_model_install_failed qfn_move_bundled_model

  qfn_move_bundled_model:
  Rename "$EXEDIR\${QFN_MODEL_FILE}" "$APPDATA\Quiz From Notes Preview\local-ai\models\${QFN_MODEL_FILE}"
  IfFileExists "$APPDATA\Quiz From Notes Preview\local-ai\models\${QFN_MODEL_FILE}" qfn_remove_bundled_model_source
  CopyFiles /SILENT "$EXEDIR\${QFN_MODEL_FILE}" "$APPDATA\Quiz From Notes Preview\local-ai\models"
  IfErrors qfn_bundled_model_install_failed
  IfFileExists "$APPDATA\Quiz From Notes Preview\local-ai\models\${QFN_MODEL_FILE}" qfn_remove_bundled_model_source qfn_bundled_model_install_failed

  qfn_remove_bundled_model_source:
  Delete "$EXEDIR\${QFN_MODEL_FILE}"
  Goto qfn_model_install_done

  qfn_bundled_model_missing:
  MessageBox MB_ICONSTOP "This model-included setup must be extracted into a folder with ${QFN_MODEL_FILE}. Download and extract the full Local AI model-included package, then run setup again."
  Abort

  qfn_bundled_model_install_failed:
  MessageBox MB_ICONSTOP "Quiz From Notes could not install the Local AI model. Close Quiz From Notes, check that this computer has enough free disk space, then try again."
  Abort

  qfn_model_install_done:
!endif
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
