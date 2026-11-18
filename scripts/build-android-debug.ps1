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
