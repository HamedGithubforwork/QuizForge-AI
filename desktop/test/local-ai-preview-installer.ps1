$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Local AI preview installer acceptance is restricted to disposable Windows CI runners.'
}

$package = Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json
$product = $package.build.productName
$displayName = "$product $($package.version)"
$installerRoot = Join-Path $PSScriptRoot '../dist/local-ai-preview'
$installers = @(Get-ChildItem $installerRoot -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one Local AI preview installer.' }
$previousRoot = Join-Path $PSScriptRoot '../dist-previous'
$previousInstallers = @(Get-ChildItem $previousRoot -Filter '*.exe' -File)
if ($previousInstallers.Count -ne 1) { throw 'Expected exactly one previous-version installer.' }

$registryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$protocolRoot = 'HKCU:\Software\Classes\com.quizfromnotes.desktop.preview'
$protocolCommand = Join-Path $protocolRoot 'shell\open\command'
$backupRoot = 'HKCU:\Software\Quiz From Notes\Local AI Preview Installer'
function Find-Registration {
    if (-not (Test-Path $registryRoot)) { return }
    @(Get-ChildItem $registryRoot | ForEach-Object { Get-ItemProperty $_.PSPath } |
        Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq $displayName })
}
if (@(Find-Registration).Count -ne 0) {
    throw 'Refusing to replace a pre-existing installation on the CI runner.'
}
if (Test-Path $protocolRoot) {
    throw 'Refusing to modify a pre-existing sign-in protocol registration on the CI runner.'
}
if (Test-Path $backupRoot) {
    throw 'Refusing to modify a pre-existing installer backup on the CI runner.'
}

$installDir = Join-Path $env:RUNNER_TEMP ('qfn-local-ai-preview-' + [guid]::NewGuid().ToString('N'))
$exePath = Join-Path $installDir ($product + '.exe')
$uninstaller = Join-Path $installDir ('Uninstall ' + $product + '.exe')
$previousCommand = '"C:\QFN-Installer-Test\Previous Preview.exe" "%1"'
$conflictDir = $null

function Wait-ChildProcess($process, [int]$milliseconds, [string]$label) {
    if (-not $process.WaitForExit($milliseconds)) {
        $process.Kill($true)
        if (-not $process.WaitForExit(10000)) { throw "$label could not be terminated." }
        throw "$label timed out and was terminated."
    }
    if ($process.ExitCode -ne 0) { throw "$label exited with code $($process.ExitCode)." }
}

try {
    $baseline = Start-Process -FilePath $previousInstallers[0].FullName `
        -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru
    Wait-ChildProcess $baseline 120000 'Previous-version installation'
    if (-not (Test-Path $exePath)) { throw 'Previous-version installation did not create its executable.' }
    if ((Get-Item $exePath).VersionInfo.ProductVersion -notlike '0.0.1*') {
        throw 'Previous-version installation did not install the expected baseline version.'
    }

    $install = Start-Process -FilePath $installers[0].FullName `
        -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru
    Wait-ChildProcess $install 120000 'Local AI in-place replacement'
    if (-not (Test-Path $exePath) -or -not (Test-Path $uninstaller)) {
        throw 'Local AI replacement did not retain the expected app executable and uninstaller.'
    }
    if ((Get-Item $exePath).VersionInfo.ProductVersion -notlike "$($package.version)*") {
        throw 'Local AI installer did not replace the installed app version.'
    }
    if (-not (Test-Path (Join-Path $installDir 'resources/local-ai-runtime/llama-server.exe'))) {
        throw 'In-place replacement did not install the Local AI runtime.'
    }
    if (@(Find-Registration).Count -ne 1) { throw 'Replacement did not retain a single per-user uninstall registration.' }
    $registeredCommand = (Get-Item $protocolCommand).GetValue('')
    if ($registeredCommand -ne ('"' + $exePath + '" "%1"')) {
        throw 'Replacement did not register the installed app for desktop sign-in links.'
    }

    New-Item -Path $backupRoot -Force | Out-Null
    New-ItemProperty -Path $backupRoot -Name 'PreviousProtocolCommand' `
        -Value $previousCommand -PropertyType String -Force | Out-Null
    $remove = Start-Process -FilePath $uninstaller `
        -ArgumentList @('/S', '/currentuser', "_?=$installDir") -PassThru
    Wait-ChildProcess $remove 60000 'Local AI uninstallation'
    if ((Get-Item $protocolCommand).GetValue('') -ne $previousCommand) {
        throw 'Uninstallation did not restore the saved sign-in handler.'
    }
    if (Test-Path $backupRoot) { throw 'Uninstallation left its saved handler behind.' }
    Remove-Item -LiteralPath $protocolRoot -Recurse -Force

    New-Item -Path $protocolCommand -Force | Out-Null
    Set-Item -Path $protocolRoot -Value 'URL:Installer test previous handler'
    New-ItemProperty -Path $protocolRoot -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    Set-Item -Path $protocolCommand -Value $previousCommand

    $conflictDir = Join-Path $env:RUNNER_TEMP ('qfn-local-ai-conflict-' + [guid]::NewGuid().ToString('N'))
    $conflictInstall = Start-Process -FilePath $installers[0].FullName `
        -ArgumentList @('/S', '/currentuser', "/D=$conflictDir") -PassThru
    if (-not $conflictInstall.WaitForExit(120000)) {
        $conflictInstall.Kill($true)
        throw 'Silent conflicting installation timed out.'
    }
    if ($conflictInstall.ExitCode -eq 0) {
        throw 'A silent install did not stop when another program owned the sign-in handler.'
    }
    if ((Get-Item $protocolCommand).GetValue('') -ne $previousCommand) {
        throw 'A silent install changed the existing sign-in handler without asking.'
    }
    if (Test-Path $backupRoot) { throw 'A silent install changed handler backup state after refusing takeover.' }
    Write-Output 'In-place replacement, preserved app registration, uninstall restoration, and safe silent refusal passed.'
} finally {
    if (Test-Path $protocolRoot) { Remove-Item -LiteralPath $protocolRoot -Recurse -Force }
    if (Test-Path $backupRoot) { Remove-Item -LiteralPath $backupRoot -Recurse -Force }
    if (Test-Path $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
    if ($conflictDir -and (Test-Path $conflictDir)) {
        Remove-Item -LiteralPath $conflictDir -Recurse -Force
    }
}
