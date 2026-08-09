$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$buildRoot = Join-Path $repoRoot "build"
$distRoot = Join-Path $repoRoot "dist"
$payloadRoot = Join-Path $buildRoot "payload"
$nodeRoot = (Resolve-Path (Join-Path $repoRoot "..\tools\runtime\node-v22.23.1-win-x64")).Path
$compiler = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$version = "0.4.0-alpha.7"

if (-not $buildRoot.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Build directory escaped repository root" }
if (Test-Path $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null

$directories = @("public", "src", "skills", "plugins", "docs")
foreach ($directory in $directories) { Copy-Item -LiteralPath (Join-Path $repoRoot $directory) -Destination (Join-Path $payloadRoot $directory) -Recurse }
$files = @("server.mjs", "package.json", "README.md", "LICENSE", "NOTICE", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "ropiq-catalog.json")
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $payloadRoot $file) }

New-Item -ItemType Directory -Path (Join-Path $payloadRoot "runtime") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeRoot "node.exe") -Destination (Join-Path $payloadRoot "runtime\node.exe")
Copy-Item -LiteralPath (Join-Path $nodeRoot "LICENSE") -Destination (Join-Path $payloadRoot "runtime\NODE-LICENSE.txt")

& $compiler /nologo /target:winexe /out:"$payloadRoot\Ropiq.exe" /reference:System.dll /reference:System.Windows.Forms.dll "$PSScriptRoot\Launcher.cs"
if ($LASTEXITCODE -ne 0) { throw "Ropiq launcher compilation failed" }
& $compiler /nologo /target:winexe /out:"$payloadRoot\RopiqUninstall.exe" /reference:System.dll /reference:System.Windows.Forms.dll "$PSScriptRoot\Uninstall.cs"
if ($LASTEXITCODE -ne 0) { throw "Ropiq uninstaller compilation failed" }

$zip = Join-Path $buildRoot "RopiqPayload.zip"
Compress-Archive -Path (Join-Path $payloadRoot "*") -DestinationPath $zip -CompressionLevel Optimal
$installer = Join-Path $distRoot "Ropiq-Setup-$version.exe"
& $compiler /nologo /target:winexe /out:"$installer" /resource:"$zip,Ropiq.Payload.zip" /reference:System.dll /reference:System.Core.dll /reference:Microsoft.CSharp.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "$PSScriptRoot\Installer.cs"
if ($LASTEXITCODE -ne 0) { throw "Ropiq installer compilation failed" }

Get-FileHash -Algorithm SHA256 $installer
