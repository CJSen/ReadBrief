; ReadBrief NSIS installer hooks
; 双保险(方案 B):Windows 手动双击升级(uninstall+reinstall)时,卸载脚本会删除
; HKCU\Software\Microsoft\Windows\CurrentVersion\Run\${PRODUCTNAME},而安装脚本不重注册,
; 导致自启动失效。这里在 POSTINSTALL 阶段,若用户配置(config.json)显示曾开启自启动,
; 则重新写入 Run 项。与 Rust 启动对账(方案 A)互补:升级后立即恢复,无需等下次启动。
;
; 仅 currentUser 安装模式适用(注册表用 HKCU)。config.json 路径对应 Rust
; dirs::config_dir()/ReadBrief/config.json,即 %APPDATA%/ReadBrief/config.json。

!macro NSIS_HOOK_POSTINSTALL
  ${If} $INSTDIR != ""
    ; config.json: %APPDATA%/ReadBrief/config.json
    StrCpy $0 "$APPDATA\ReadBrief\config.json"
    ; 文件不存在(如首次安装尚未生成)则跳过,交由 Rust 启动对账处理默认意图
    IfFileExists "$0" 0 autostart_hook_skip
    ClearErrors
    FileOpen $1 "$0" r
    StrCpy $2 ""
    autostart_read_loop:
      FileRead $1 $3
      IfErrors autostart_read_end
      ; config.json 为 serde pretty 多行格式, "launchOnStart": true 独占一行
      ${StrLoc} $4 $3 "$\"launchOnStart$\": true" ">"
      ${If} $4 != 0
        StrCpy $2 "true"
        Goto autostart_read_end
      ${EndIf}
      Goto autostart_read_loop
    autostart_read_end:
    FileClose $1
    ${If} $2 == "true"
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
      DetailPrint "ReadBrief: 已根据配置恢复开机自启动"
    ${EndIf}
  ${EndIf}
  autostart_hook_skip:
!macroend
