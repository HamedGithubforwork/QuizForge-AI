$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Local AI preview installer acceptance is restricted to disposable Windows CI runners.'
}

$product = 'Quiz From Notes Local AI Preview'
$installerRoot = Join-Path $PSScriptRoot '../dist/local-ai-preview'
$installers = @(Get-ChildItem $installerRoot -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one Local AI preview installer.' }

$protocolRoot = 'HKCU:\Software\Classes\com.quizfromnotes.desktop.preview'
$protocolCommand = Join-Path $protocolRoot 'shell\open\command'
if (Test-Path $protocolRoot) {
    throw 'Refusing to modify an existing sign-in protocol registration on the CI runner.'
}

$installDir = Join-Path $env:RUNNER_TEMP ('qfn-local-ai-preview-' + [guid]::NewGuid().ToString('N'))
$exePath = Join-Path $installDir ($product + '.exe')
$uninstaller = Join-Path $installDir ('Uninstall ' + $product + '.exe')
$previousCommand = '"C:\QFN-Installer-Test\Previous Preview.exe" "%1"'
$conflictDir = $null
$backupRoot = 'HKCU:\Software\Quiz From Notes\Local AI Preview Installer'
if (Test-Path $backupRoot) {
    throw 'Refusing to modify an existing Local AI installer backup on the CI runner.'
}

function Wait-ChildProcess($process, [int]$milliseconds, [string]$label) {
    if (-not $process.WaitForExit($milliseconds)) {
        $process.Kill($true)
        if (-not $process.WaitForExit(10000)) { throw "$label could not be terminated." }
        throw "$label timed out and was terminated."
    }
}

try {
    $install = Start-Process -FilePath $installers[0].FullName `
        -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru
    Wait-ChildProcess $install 120000 'Local AI preview installation'
    if ($install.ExitCode -ne 0) { throw "Local AI preview installation exited with code $($install.ExitCode)." }
    if (-not (Test-Path $exePath) -or -not (Test-Path $uninstaller)) {
        throw 'Local AI preview installation did not create its executable and uninstaller.'
    }
    $registeredCommand = (Get-Item $protocolCommand).GetValue('')
    if ($registeredCommand -ne ('"' + $exePath + '" "%1"')) {
        throw 'Local AI preview did not register its expected sign-in handler.'
    }

    New-Item -Path $backupRoot -Force | Out-Null
    New-ItemProperty -Path $backupRoot -Name 'PreviousProtocolCommand' `
        -Value $previousCommand -PropertyType String -Force | Out-Null
    $remove = Start-Process -FilePath $uninstaller `
        -ArgumentList @('/S', '/currentuser', "_?=$installDir") -PassThru
    Wait-ChildProcess $remove 60000 'Local AI preview uninstallation'
    if ($remove.ExitCode -ne 0) { throw "Local AI preview uninstallation exited with code $($remove.ExitCode)." }
    if ((Get-Item $protocolCommand).GetValue('') -ne $previousCommand) {
        throw 'Uninstallation did not restore the previously saved sign-in handler.'
    }
    if (Test-Path $backupRoot) { throw 'Uninstallation left its saved protocol handler behind.' }
    Remove-Item -LiteralPath $protocolRoot -Recurse -Force

    New-Item -Path $protocolCommand -Force | Out-Null
    Set-Item -Path $protocolRoot -Value 'URL:Installer test previous handler'
    New-ItemProperty -Path $protocolRoot -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    Set-Item -Path $protocolCommand -Value $previousCommand

    $conflictDir = Join-Path $env:RUNNER_TEMP ('qfn-local-ai-conflict-' + [guid]::NewGuid().ToString('N'))
    $conflictInstall = Start-Process -FilePath $installers[0].FullName `
        -ArgumentList @('/S', '/currentuser', "/D=$conflictDir") -PassThru
    Wait-ChildProcess $conflictInstall 120000 'Silent conflicting installation'
    if ($conflictInstall.ExitCode -eq 0) {
        throw 'A silent install did not stop when another installation owned the sign-in handler.'
    }
    $afterConflict = (Get-Item $protocolCommand).GetValue('')
    if ($afterConflict -ne $previousCommand) {
        throw 'A silent install changed the existing sign-in handler without asking.'
    }
    if (Test-Path $backupRoot) { throw 'A silent install changed backup state despite refusing the protocol takeover.' }
    Write-Output 'Install, uninstall cleanup, and safe refusal of silent protocol takeover passed.'
} finally {
    if (Test-Path $protocolRoot) {
        Remove-Item -LiteralPath $protocolRoot -Recurse -Force
    }
    if (Test-Path $backupRoot) { Remove-Item -LiteralPath $backupRoot -Recurse -Force }
    if (Test-Path $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
    if ($conflictDir -and (Test-Path $conflictDir)) { Remove-Item -LiteralPath $conflictDir -Recurse -Force }
}
