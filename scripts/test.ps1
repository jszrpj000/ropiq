[CmdletBinding()]
param()

$node = Get-Command node -ErrorAction Stop
& $node.Source --test (Join-Path (Split-Path $PSScriptRoot -Parent) 'test/*.test.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
