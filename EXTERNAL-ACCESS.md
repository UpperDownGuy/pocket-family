# Pocket outside the home

The iPhone app should use `https://pocket.alexxweb.com` as its server address, on both Wi-Fi and cellular data. This address serves Pocket's API; opening `/` in a browser is not the app interface. `/health` is the public connection check. Account data still requires a Pocket sign-in.

## Cloudflare Tunnel

The existing **WIN-SERVER-1** tunnel publishes this route:

| Setting | Value |
| --- | --- |
| Hostname | `pocket.alexxweb.com` |
| Service URL | `https://192.168.1.236:443` |
| TLS → Origin Server Name | `pocket.alexxweb.com` |
| Disable TLS certificate verification | Off |

The previous service URL used `http://192.168.1.236` (port 80). Pocket's nginx service listens on HTTPS port 443, so the old route returned Cloudflare 502 errors. The route above was saved and verified on November 16, 2026. The origin certificate must remain valid; certificate renewal is separate from application updates.

Do not set the service URL to the public Cloudflare hostname: that can route the request back into the same tunnel. Use the private origin address and the certificate hostname in the separate TLS setting. No inbound router port forwarding is needed for this tunnel.

## Verify each connection

On a computer with a local DNS override, a successful normal request can test only the LAN route. Use a current public DNS answer to check the Cloudflare path separately:

```powershell
$publicIP = Resolve-DnsName pocket.alexxweb.com -Server 1.1.1.1 -Type A |
    Where-Object { $_.Type -eq 'A' } | Select-Object -First 1 -ExpandProperty IPAddress
if (-not $publicIP) { throw 'Public DNS returned no IPv4 address.' }
curl.exe --noproxy '*' --resolve "pocket.alexxweb.com:443:$publicIP" --connect-timeout 5 --max-time 15 --fail --show-error https://pocket.alexxweb.com/health
```

Expect HTTP 200 and JSON containing `setupRequired`. A request to `/state` without a session must return HTTP 401. On the iPhone, turn off Wi-Fi and reopen Pocket to check the complete cellular path.

If the public path returns 502 while the LAN path works, inspect the existing route in Cloudflare → Networking → Tunnels → WIN-SERVER-1 → Routes. Check the service scheme, port, certificate hostname, certificate expiry, and whether the tunnel connector can reach the origin. A healthy tunnel status alone does not prove that its origin is reachable. See [Cloudflare's HTTPS origin troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/https-origins/).

If health responds but a feature says the server needs updating, use [Repair a stale server](AUTO-UPDATE.md#repair-a-stale-server). A working tunnel does not update the Docker image.
