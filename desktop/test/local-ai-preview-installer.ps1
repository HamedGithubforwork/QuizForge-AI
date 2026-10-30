$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Local AI preview installer acceptance is restricted to disposable Windows CI runners.'
}

$package = Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json
$product = $package.build.productName
$displayName = "$product $($package.version)"
$downloadLaterRoot = Join-Path $PSScriptRoot '../dist/local-ai-preview'
$modelIncludedRoot = Join-Path $PSScriptRoot '../dist/local-ai-preview-model-included'
$downloadLaterInstallers = @(Get-ChildItem $downloadLaterRoot -Filter '*.exe' -File)
$modelInstallers = @(Get-ChildItem $modelIncludedRoot -Filter '*.exe' -File)
if ($downloadLaterInstallers.Count -ne 1 -or $downloadLaterInstallers[0].Name -notlike '*Download-Model-Later*' -or
    $modelInstallers.Count -ne 1 -or $modelInstallers[0].Name -notlike '*Model-Included*') {
    throw 'Expected clearly named model-included and download-later Local AI preview installers.'
}
$downloadLaterInstaller = $downloadLaterInstallers[0]
$modelInstaller = $modelInstallers[0]
$previousRoot = Join-Path $PSScriptRoot '../dist-previous'
$previousInstallers = @(Get-ChildItem $previousRoot -Filter '*.exe' -File)
if ($previousInstallers.Count -ne 1) { throw 'Expected exactly one previous-version installer.' }

$registryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$protocolRoot = 'HKCU:\Software\Classes\com.quizfromnotes.desktop.preview'
$protocolCommand = Join-Path $protocolRoot 'shell\open\command'
$backupRoot = 'HKCU:\Software\Quiz From Notes\Local AI Preview Installer'
$stateRoot = 'HKCU:\Software\Quiz From Notes\Local AI Preview Installer State'
$modelPath = Join-Path $env:APPDATA 'Quiz From Notes Preview/local-ai/models/7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5.gguf'
$installerSource = Get-Content (Join-Path $PSScriptRoot '../build/local-ai-preview-installer.nsh') -Raw
if ($installerSource -notmatch 'A version of Quiz From Notes is already installed\.' -or
    $installerSource -notmatch 'This model-included setup must be extracted' -or
    $installerSource -notmatch 'could not install the Local AI model' -or
    $installerSource -match 'MessageBox[^\r\n]*sign-in') {
    throw 'Installer replacement and model prompts must be present, friendly, and contain no sign-in-link wording.'
}
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
if (Test-Path $stateRoot) {
    throw 'Refusing to modify pre-existing installer prompt state on the CI runner.'
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

    $install = Start-Process -FilePath $downloadLaterInstaller.FullName `
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

    $installedPreview = Start-Process -FilePath $exePath -PassThru
    try {
        $launchDeadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            Start-Sleep -Milliseconds 500
            $installedPreview.Refresh()
            if ($installedPreview.HasExited) {
                throw 'Installed Local AI preview exited before displaying a window.'
            }
        } while ($installedPreview.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $launchDeadline)
        if ($installedPreview.MainWindowHandle -eq 0) {
            throw 'Installed Local AI preview did not display a window.'
        }
        if ($installedPreview.MainWindowTitle -notlike 'Quiz From Notes*Local AI*') {
            throw 'The installed Local AI renderer did not open.'
        }
        if (-not $installedPreview.CloseMainWindow() -or -not $installedPreview.WaitForExit(15000)) {
            throw 'Installed Local AI preview did not close cleanly.'
        }
    } finally {
        if (-not $installedPreview.HasExited) {
            $installedPreview.Kill($true)
            $installedPreview.WaitForExit(10000) | Out-Null
        }
    }

    $installWithModel = Start-Process -FilePath $modelInstaller.FullName `
        -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru
    Wait-ChildProcess $installWithModel 300000 'Model-included Local AI installation'
    if (-not (Test-Path $modelPath)) { throw 'Model-included installer did not install the Local AI model.' }
    $modelInfo = Get-Item $modelPath
    if ($modelInfo.Length -ne 2497280256) { throw 'Installer model size does not match the pinned model.' }
    if ((Get-FileHash $modelPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5') {
        throw 'Installer did not preserve the pinned model checksum.'
    }
    if (Test-Path (Join-Path $installDir 'resources/local-ai-model')) {
        throw 'Installer left a duplicate model copy in the application directory.'
    }

    New-Item -Path $backupRoot -Force | Out-Null
    New-ItemProperty -Path $backupRoot -Name 'PreviousProtocolCommand' `
        -Value $previousCommand -PropertyType String -Force | Out-Null
    $remove = Start-Process -FilePath $uninstaller `
        -ArgumentList @('/S', '/currentuser', "_?=$installDir") -PassThru
    Wait-ChildProcess $remove 60000 'Local AI uninstallation'
    if (Test-Path $modelPath) { throw 'Local AI uninstallation left the downloaded model in the user profile.' }
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
    $conflictInstall = Start-Process -FilePath $downloadLaterInstaller.FullName `
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
    if (Test-Path $stateRoot) { throw 'A silent install left replacement prompt state behind.' }
    Write-Output 'Friendly replacement prompt, in-place upgrade, installed app visible launch and close, app registration, uninstall restoration, and safe silent refusal passed.'
} finally {
    if (Test-Path $protocolRoot) { Remove-Item -LiteralPath $protocolRoot -Recurse -Force }
    if (Test-Path $backupRoot) { Remove-Item -LiteralPath $backupRoot -Recurse -Force }
    if (Test-Path $stateRoot) { Remove-Item -LiteralPath $stateRoot -Recurse -Force }
    if (Test-Path $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
    if ($conflictDir -and (Test-Path $conflictDir)) {
        Remove-Item -LiteralPath $conflictDir -Recurse -Force
    }
}
