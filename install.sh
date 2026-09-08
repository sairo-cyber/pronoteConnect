#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime_dir="${root_dir}/.runtime"
data_dir="${root_dir}/.data"
service_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
autostart_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/autostart"
applications_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
service_file="${service_dir}/pronoteconnect.service"
autostart_file="${autostart_dir}/pronoteconnect-tray.desktop"
application_file="${applications_dir}/pronoteconnect.desktop"

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now pronoteconnect.service >/dev/null 2>&1 || true
  rm -f "${service_file}" "${autostart_file}" "${application_file}"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  pkill -f "${root_dir}/desktop/main.cjs" >/dev/null 2>&1 || true
  if [[ "${2:-}" == "--delete-data" && "${data_dir}" == "${root_dir}/.data" ]]; then
    rm -rf "${data_dir}"
  fi
  printf '%s\n' "PronoteConnect est désinstallé. Le dossier du dépôt est conservé."
  exit 0
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  printf '%s\n' "Cet installateur prend actuellement en charge Linux." >&2
  exit 1
fi

download() {
  local url="$1"
  local destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 20 --max-time 300 "${url}" -o "${destination}"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "${destination}" "${url}"
  else
    printf '%s\n' "curl ou wget est nécessaire pour l'installation." >&2
    exit 1
  fi
}

node_command="$(command -v node || true)"
node_major=0
if [[ -n "${node_command}" ]]; then
  node_major="$(${node_command} -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0')"
fi

if (( node_major < 22 )); then
  node_version="v22.23.2"
  case "$(uname -m)" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) printf '%s\n' "Architecture Linux non prise en charge." >&2; exit 1 ;;
  esac
  node_archive="node-${node_version}-linux-${node_arch}.tar.xz"
  node_download_dir="${runtime_dir}/node-download"
  mkdir -p "${node_download_dir}"
  download "https://nodejs.org/dist/${node_version}/${node_archive}" "${node_download_dir}/${node_archive}"
  download "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" "${node_download_dir}/SHASUMS256.txt"
  expected="$(awk -v file="${node_archive}" '$2 == file { print $1 }' "${node_download_dir}/SHASUMS256.txt")"
  actual="$(sha256sum "${node_download_dir}/${node_archive}" | awk '{ print $1 }')"
  if [[ -z "${expected}" || "${expected}" != "${actual}" ]]; then
    printf '%s\n' "La vérification de Node.js a échoué." >&2
    exit 1
  fi
  rm -rf "${runtime_dir}/node"
  mkdir -p "${runtime_dir}/node"
  tar -xJf "${node_download_dir}/${node_archive}" -C "${runtime_dir}/node" --strip-components=1
  rm -rf "${node_download_dir}"
  node_command="${runtime_dir}/node/bin/node"
fi

export PATH="$(dirname "${node_command}"):${PATH}"
cd "${root_dir}"
mkdir -p "${runtime_dir}" "${data_dir}"
chmod 700 "${runtime_dir}" "${data_dir}"

npm ci
node node_modules/electron/install.js
npm exec playwright install chromium
node scripts/install-tunnel-client.mjs
npm run verify

mkdir -p "${service_dir}" "${autostart_dir}" "${applications_dir}"

escape_unit() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '%s' "${value}"
}

escaped_root="$(escape_unit "${root_dir}")"
escaped_node="$(escape_unit "${node_command}")"
escaped_data="$(escape_unit "${data_dir}")"
escaped_tunnel="$(escape_unit "${runtime_dir}/tunnel-client/tunnel-client")"
escaped_working_dir="${escaped_root// /\\x20}"
allowed_hosts="127.0.0.1,localhost,[::1]"
if command -v tailscale >/dev/null 2>&1; then
  while IFS= read -r tailscale_ip; do
    [[ -n "${tailscale_ip}" ]] && allowed_hosts="${allowed_hosts},${tailscale_ip}"
  done < <(tailscale ip -4 2>/dev/null || true)
  tailscale_dns="$(tailscale status --json 2>/dev/null | "${node_command}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);process.stdout.write((v.Self?.DNSName||"").replace(/\.$/,""))}catch{}})' || true)"
  [[ -n "${tailscale_dns}" ]] && allowed_hosts="${allowed_hosts},${tailscale_dns}"
fi
escaped_allowed_hosts="$(escape_unit "${allowed_hosts}")"

tmp_service="$(mktemp)"
printf '%s\n' \
  '[Unit]' \
  'Description=PronoteConnect' \
  'After=network-online.target graphical-session.target' \
  'Wants=network-online.target' \
  '' \
  '[Service]' \
  'Type=simple' \
  "WorkingDirectory=${escaped_working_dir}" \
  "ExecStart=\"${escaped_node}\" \"${escaped_root}/dist/src/index.js\"" \
  "Environment=\"PRONOTECONNECT_DATA_DIR=${escaped_data}\"" \
  "Environment=\"PRONOTECONNECT_INSTALL_DIR=${escaped_root}\"" \
  "Environment=\"PRONOTECONNECT_TUNNEL_CLIENT=${escaped_tunnel}\"" \
  "Environment=\"PRONOTECONNECT_ALLOWED_HOSTS=${escaped_allowed_hosts}\"" \
  'Environment="PRONOTECONNECT_MANAGED_SERVICE=1"' \
  'Restart=on-failure' \
  'RestartSec=3' \
  'NoNewPrivileges=true' \
  'PrivateTmp=true' \
  '' \
  '[Install]' \
  'WantedBy=default.target' > "${tmp_service}"
install -m 600 "${tmp_service}" "${service_file}"
rm -f "${tmp_service}"

electron_path="${root_dir}/node_modules/.bin/electron"
tmp_desktop="$(mktemp)"
printf '%s\n' \
  '[Desktop Entry]' \
  'Type=Application' \
  'Name=PronoteConnect' \
  'Comment=Ouvrir PronoteConnect' \
  "Exec=\"${electron_path}\" \"${root_dir}/desktop/main.cjs\"" \
  'Icon=applications-education' \
  'Terminal=false' \
  'Categories=Education;Utility;' > "${tmp_desktop}"
install -m 600 "${tmp_desktop}" "${autostart_file}"
install -m 644 "${tmp_desktop}" "${application_file}"
rm -f "${tmp_desktop}"

systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now pronoteconnect.service

if ! systemctl --user is-active --quiet pronoteconnect.service; then
  printf '%s\n' "Le service PronoteConnect n'a pas démarré." >&2
  systemctl --user status pronoteconnect.service --no-pager >&2 || true
  exit 1
fi

nohup "${electron_path}" "${root_dir}/desktop/main.cjs" >/dev/null 2>&1 &
healthy=0
for _ in {1..120}; do
  if curl -fsS --max-time 1 http://127.0.0.1:37421/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 0.25
done
if [[ "${healthy}" != "1" ]]; then
  printf '%s\n' "Le service a démarré mais l'interface locale ne répond pas." >&2
  exit 1
fi
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open http://127.0.0.1:37421 >/dev/null 2>&1 || true
fi

printf '%s\n' "PronoteConnect est installé et démarré."
printf '%s\n' "Ouvrez http://127.0.0.1:37421 si le navigateur ne s'est pas ouvert."
