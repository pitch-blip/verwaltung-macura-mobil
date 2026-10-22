# Kleiner statischer Webserver für die lokale Vorschau.
# Nötig, weil die Anwendung über file:// weder localStorage noch den
# Microsoft-Login nutzen kann. Nur für die Entwicklung gedacht.

param([int]$Port = 8082)

$wurzel = $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

try { $listener.Start() }
catch { Write-Error "Port $Port ist belegt oder nicht verfügbar: $_"; exit 1 }

Write-Output "Verwaltung laeuft auf http://localhost:$Port/verwaltung.html"
Write-Output "Beenden mit Strg+C"

$typen = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".ico"  = "image/x-icon"
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $pfad = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/")
    if ([string]::IsNullOrWhiteSpace($pfad)) { $pfad = "verwaltung.html" }

    $datei = Join-Path $wurzel $pfad
    $voll = [System.IO.Path]::GetFullPath($datei)

    # Kein Ausbrechen aus dem Ordner
    if (-not $voll.StartsWith([System.IO.Path]::GetFullPath($wurzel), [StringComparison]::OrdinalIgnoreCase)) {
      $ctx.Response.StatusCode = 403
      $ctx.Response.Close()
      continue
    }

    if (Test-Path $voll -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($voll).ToLower()
      $typ = $typen[$ext]
      if (-not $typ) { $typ = "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($voll)
      $ctx.Response.ContentType = $typ
      $ctx.Response.Headers.Add("Cache-Control", "no-store")
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Output ("200  " + $pfad)
    } else {
      $ctx.Response.StatusCode = 404
      $text = [System.Text.Encoding]::UTF8.GetBytes("Nicht gefunden: $pfad")
      $ctx.Response.OutputStream.Write($text, 0, $text.Length)
      Write-Output ("404  " + $pfad)
    }
    $ctx.Response.Close()
  } catch {
    Write-Output ("Fehler: " + $_.Exception.Message)
  }
}
