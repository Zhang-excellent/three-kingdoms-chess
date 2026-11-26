$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

function Get-JavaMajorVersion([string]$javaHome) {
    $java = Join-Path $javaHome 'bin\java.exe'
    if (-not (Test-Path -LiteralPath $java)) { return $null }
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = (& $java -version 2>&1 | Out-String) }
    finally { $ErrorActionPreference = $previousPreference }
    if ($output -match 'version "(?:1\.)?(\d+)') { return [int]$Matches[1] }
    return $null
}

$candidates = @(
    $env:JAVA_HOME,
    (Join-Path $env:USERPROFILE '.jdks\jbr-21.0.11'),
    'C:\Program Files\Android\Android Studio\jbr'
) | Where-Object { $_ } | Select-Object -Unique

$javaHome = $null
foreach ($candidate in $candidates) {
    $major = Get-JavaMajorVersion $candidate
    if ($major -ge 17 -and $major -le 24) {
        $javaHome = $candidate
        break
    }
}

if (-not $javaHome) {
    throw 'No supported JDK 17-24 found. Install JDK 21 or point JAVA_HOME to a supported JDK.'
}

$env:JAVA_HOME = $javaHome
$env:Path = "$(Join-Path $javaHome 'bin');$env:Path"
Write-Host "JAVA_HOME=$javaHome"

Push-Location (Join-Path $root 'android')
try {
    & .\gradlew.bat --no-daemon assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Android debug APK build failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

$builtApk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $builtApk)) {
    throw "Android build finished but expected APK was not found: $builtApk"
}

$rootApk = Join-Path $root 'three-chess.apk'
$apkOutputDirectory = Join-Path $root 'android\app\build\outputs\apk'
$buildApk = Join-Path $apkOutputDirectory 'three-chess.apk'
Copy-Item -LiteralPath $builtApk -Destination $rootApk -Force
Copy-Item -LiteralPath $builtApk -Destination $buildApk -Force

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($rootApk)
try {
    $hash = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
} finally {
    $stream.Dispose()
    $sha256.Dispose()
}
Write-Host "APK_FOR_SHARING=$rootApk"
Write-Host "APK_BUILD_COPY=$buildApk"
Write-Host "APK_SHA256=$hash"
