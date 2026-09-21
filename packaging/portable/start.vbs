' html-anything portable launcher - runs launch.js fully hidden.
' Pure ASCII on purpose (VBScript file-encoding safety).
Dim sh, root, target
Set sh = CreateObject("WScript.Shell")
root = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
sh.CurrentDirectory = root
target = Chr(34) & root & "\runtime\node.exe" & Chr(34) & " " & Chr(34) & root & "\launch.js" & Chr(34)
sh.Run target, 0, False
