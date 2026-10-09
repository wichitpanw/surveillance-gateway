# Setting up Surveillance Gateway Edge on Linux (Ubuntu 24)

> Current state 2026-10-07: the original Ubuntu machine is now Edge **102**, linked to the central Regional (node 100), web on **:5173**, service **gw-edge**; Gateway d645ed9 (156 cameras as of 2026-10-07). There is no inference worker; external AI results arrive through AI Sources.
> Restart it when needed with `sudo systemctl restart gw-edge` and never run pm2 by hand on this machine. The tables and install steps below are the original September 2026 method from before the Regional move; new machines use [EDGE-KIT.md](EDGE-KIT.md).

An edge on Linux runs the same code as on Windows; what differs is the machine's config (`<state>/edge.json`) and how it starts at boot (systemd).
First machine: `edge-linux-01` · VPN address `203.0.113.80` · edge `002` · connects an Axis camera (S30) on a network central cannot reach.

Updated 2026-09-24 · for the system overview see [EDGE-PLAN.md](EDGE-PLAN.md) · for the rules see [CONTRIBUTING.md](CONTRIBUTING.md)

> **For new edges (including Raspberry Pi 5) use the flash drive install kit — [EDGE-KIT.md](EDGE-KIT.md)**; no internet, apt, npm or pm2 needed.
> This document is the original manual install (the edge 002 machine) that uses `deploy-edge.sh` over SSH.
> **Later updates no longer need deploy-edge.sh** (since `c6ecab4`) — run `build-edge-kit.ps1 -Publish` and click the update button on central's Edge Nodes page.
> The edge swaps the files in `~/gw-edge` by itself, with no sudo ([EDGE-KIT.md](EDGE-KIT.md) section 5)

## What differs from an edge on Windows

| Topic | Windows (edge 001) | Linux |
|---|---|---|
| Machine config | defaults in `ecosystem.edge.config.cjs` | `/var/lib/gw-edge/edge.json` (outside git, `chmod 600` — contains a token) |
| go2rtc | `go2rtc/go2rtc.exe` in the repo | `/var/lib/gw-edge/bin/go2rtc` (setup downloads the amd64/arm64 build, 1.9.14) |
| Ports | 5273 / 1994 / 8565 / 8566 (coexists with central) | 5173 / 1984 / 8555 / 8556 |
| At boot | Scheduled Task → `start-gateway.cmd` | systemd `gw-edge.service` → `pm2-runtime` from the ecosystem file |
| backup | `backup-windows.ps1` (Scheduled Task) | `scripts/backup-edge.sh` (`/etc/cron.d/gw-edge-backup` at 2 a.m.) |
| ffmpeg | `C:\ffmpeg\bin` | `ffmpeg` from apt |

## 1. Install the basics (sudo)

```bash
sudo apt update && sudo apt install -y ffmpeg git curl build-essential
```
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```
```bash
sudo npm i -g pm2
```

**Check for port conflicts first** — this machine used to run GB28181 (a media platform on ports 18080, 18081/18554/…, MySQL 3306, Redis) · the edge uses 5173/1984/8555/8556
```bash
sudo ss -ltnp | grep -E ':(5173|1984|8555|8556)\b'
```
Conflict = set a different `port` / `go2rtcApi` / `go2rtcRtsp` in `edge.json` (step 3) before starting

## 2. Send the code to the Linux machine

The repo has no git remote and its history contains large files (git bundle ~800 MB, offline map .mbtiles ~880 MB that the edge does not use),
so we send a `git archive` of the current commit with the large files stripped (~6 MB) over SSH and build at the destination — from Git Bash on the HOST:
```bash
scripts/deploy-edge.sh deploy-user@203.0.113.80 --port 2222
```
The destination has no `.git` → the script writes the commit into a `BUILD` file so `/api/instance` can report it (central compares it with its own and warns on mismatch)
**For the next update** = the update button on central's Edge Nodes page (after `-Publish`) · deploy-edge.sh + `sudo systemctl restart gw-edge`
still works when needed (for example when the edge cannot reach central, or when the ecosystem was changed, which takes effect only on a service restart)

This machine's SSH uses port **2222** (key `edge-deploy`) — on inbound port 22 over the VPN something else (`libssh_0.11.4`) answers instead of OpenSSH,
and Ubuntu 24's `ssh.socket` listens on IPv6 only if no address is specified → you must put both `0.0.0.0:2222` and `[::]:2222`
(`/etc/systemd/system/ssh.socket.d/port2222.conf`)

## 3. Prepare state (regular user)

```bash
sudo mkdir -p /var/lib/gw-edge && sudo chown $USER: /var/lib/gw-edge
```
```bash
~/gw-edge/scripts/setup-edge.sh --node 002 --province 10 --public-host 203.0.113.80
```
Creates `edge.json`, go2rtc's RTSP account (`.rtsp-credentials.json`), `go2rtc.yaml`, and downloads go2rtc · safe to re-run, does not overwrite the existing account/yaml

## 4. Boot service + backup (sudo, once)

```bash
sudo ~/gw-edge/scripts/setup-edge.sh --install-service && sudo systemctl start gw-edge
```
Verify: `systemctl status gw-edge` · `journalctl -u gw-edge -f` · `curl -s localhost:5173/api/instance` → `"role":"edge","node":"002"`

The service's pm2 uses `PM2_HOME=/var/lib/gw-edge/pm2` — check status with `PM2_HOME=/var/lib/gw-edge/pm2 pm2 ls`
Never run `pm2 start` by hand outside the service (you would get a second set fighting for the ports — the same lesson as on Windows)

## 5. Connect to central

**link (recommended — the edge connects up by itself, no inbound port needed)**
0. (Once per central) Edge Nodes → the **"Central addresses that edges can use"** box → enter every route by which the various edges can see central
   (LAN, the organization's VPN/MPLS, NAT-mapped IPs — if that route remaps ports, enter the gateway and RTSP ports as seen from that side)
1. Add Edge → "Edge connects up by itself" → issue token → **tick only the routes this edge can reach** → copy the Linux command (the token is shown once)
2. Run that command on the edge — it looks like this (`--central-url` can be given several times, tried in order):
   ```bash
   ~/gw-edge/scripts/setup-edge.sh --central-url 'ws://203.0.113.80:5173/api/edge-link' --central-url 'ws://203.0.113.10:5173/api/edge-link' --central-token ntlink_… && sudo systemctl restart gw-edge
   ```
3. The log must contain a line saying `[Edge link]` connected to central (`<address used>`) · the Edge Nodes page shows Online with "via <address> from <edge IP>"
4. The edge must be able to reach central at `<port>` (the link) and `<rtspPort>` (video push) of that route
   Video is pushed to the host of the address that connected · if the RTSP port differs from 8555, append `?rtsp=<port>` to the URL (the web UI fills it in)

**pull (alternative)** — central connects into the edge: edge web UI → Central Access issue a key → central → Add Edge, enter `203.0.113.80:5173` + the key
Ports 5173 and 8555 of the edge must be opened to central's IP (`sudo ufw allow from 203.0.113.10 to any port 5173,8555 proto tcp`)

## 6. Add the Axis camera

1. Edge web UI `http://203.0.113.80:5173` → log in `superadmin`/`superadmin` → **change the password immediately**
2. In the Axis camera, create an **ONVIF** account (Axis OS keeps ONVIF accounts separate from web accounts — without one the ONVIF scan login fails)
3. Cameras → scan ONVIF on the Axis network → add · pin on the map · set the province
4. Sub stream: I-frame interval ≈ fps (fast video start — [CAMERA-QUIRKS.md](CAMERA-QUIRKS.md))

## 7. Tests that must pass

- Central sees edge 002's cameras · they open in the Live page and in the client
- Unplug the camera cable → central shows it down within ~20 s · `systemctl stop gw-edge` → cameras become "status unknown" · start → they recover by themselves
- No viewers for 60 s → the push stops (`ps aux | grep ffmpeg` on the edge)
- `scripts/backup-edge.sh` runs, and that round's `vms.db` passes `PRAGMA integrity_check`
- Measure CPU / network while viewing 1, 4, 9 cameras (real numbers to help choose edge hardware, e.g. Pi 5)

## Recovery

`sudo systemctl stop gw-edge` → delete `vms.db-wal`, `vms.db-shm` → put in `<backups>/<round>/vms.db` and the `.gateway-key-secret` from the **same round**
→ `sudo systemctl start gw-edge`
