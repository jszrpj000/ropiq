[CmdletBinding()]
param()

$node = Get-Command node -ErrorAction Stop
& $node.Source (Join-Path (Split-Path $PSScriptRoot -Parent) 'server.mjs')
