# Chrome Web Mağazası / Edge Eklentileri'ne yüklenecek eklenti paketini (.zip) üretir.
# Çalıştırma: pwsh scripts/pack-extension.ps1  →  dist/grabbit-extension-<sürüm>.zip
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root 'extension'
$version = (Get-Content (Join-Path $ext 'manifest.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist "grabbit-extension-$version.zip"
if (Test-Path $out) { Remove-Item $out }

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try {
  $files = Get-ChildItem $ext -Recurse -File
  foreach ($f in $files) {
    # Mağazalar zip içinde '/' ayırıcı bekler
    $rel = $f.FullName.Substring($ext.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, 'Optimal') | Out-Null
  }
} finally {
  $zip.Dispose()
}
"Eklenti paketi hazır: $out ($($files.Count) dosya)"
