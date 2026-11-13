import os
import json
import requests
from datetime import datetime, timezone

# STB आणि पोर्टल कॉन्फिगरेशन
PORTAL_BASE = "http://4k.tvstb.me/stalker_portal/server/load.php"
MAC = "00:1A:79:00:81:91"
SN = "CDE70A9D8058C"
DEVICE_ID = "2F419AD9E55070C6275FE0A2DAC97CF0DE14D77F32C3B8670E5A68841F713019"
SIGNATURE = "263"

CACHE_DIR = "Cache"
CACHE_FILE = os.path.join(CACHE_DIR, "epg.xml")
CHANNELS_FILE = "channels.json"

def get_headers(token=None):
    headers = {
        "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stb app ver: 2 rev: 250 Safari/533.3",
        "X-User-Agent": "Model: MAG250; Link: WiFi",
        "Referer": "http://4k.tvstb.me/stalker_portal/c/",
        "Cookie": f"mac={MAC}; stb_lang=en; timezone=Asia/Kolkata"
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers

def main():
    # इथे CHANNELS_DIR ऐवजी अचूक CHANNELS_FILE केले आहे
    if not os.path.exists(CHANNELS_FILE):
        print("Error: channels.json not found!")
        return

    with open(CHANNELS_FILE, "r", encoding="utf-8") as f:
        channels_data = json.load(f)

    allowed_channels = {}
    for item in channels_data:
        if item.get("source", "4k.tvstb.me") != "4k.tvstb.me":
            continue
        ch_id = str(item.get("channel_id") or item.get("id") or "").strip()
        if ch_id:
            allowed_channels[ch_id] = item.get("name", "Unknown")

    if not allowed_channels:
        print("Error: No valid channels found in channels.json")
        return

    session = requests.Session()
    session.verify = False

    # 1. Handshake
    hs_url = f"{PORTAL_BASE}?type=stb&action=handshake&prehash={MAC}&token=&JsHttpRequest=1-xml"
    try:
        hs_res = session.get(hs_url, headers=get_headers(), timeout=15)
        hs_json = hs_res.json()
        token = hs_json.get("js", {}).get("token") or hs_json.get("token")
        if not token:
            print("Error: Handshake Token Failed")
            return
    except Exception as e:
        print(f"Handshake Exception: {e}")
        return

    auth_headers = get_headers(token)

    # 2. Profile
    profile_url = f"{PORTAL_BASE}?type=stb&action=get_profile&sn={SN}&device_id={DEVICE_ID}&device_id2={DEVICE_ID}&signature={SIGNATURE}&JsHttpRequest=1-xml"
    session.get(profile_url, headers=auth_headers, timeout=15)

    # 3. Get All Channels from Portal
    chan_url = f"{PORTAL_BASE}?type=itv&action=get_all_channels&JsHttpRequest=1-xml"
    chan_res = session.get(chan_url, headers=auth_headers, timeout=15)
    chan_json = chan_res.json()
    
    all_channels = chan_json.get("js", [])
    if isinstance(all_channels, dict):
        all_channels = all_channels.get("data", [])

    portal_map = {}
    for ch in all_channels:
        api_id = str(ch.get("id", "")).strip()
        xml_id = str(ch.get("xmltv_id", api_id)).strip()
        name = str(ch.get("name", "")).strip().upper()
        if api_id:
            portal_map[api_id] = api_id
            portal_map[xml_id] = api_id
            portal_map[name] = api_id

    valid_channels = []
    for ch_id, ch_name in allowed_channels.items():
        api_id = portal_map.get(ch_id) or portal_map.get(ch_name.upper()) or ch_id
        valid_channels.append({"api_id": api_id, "xml_id": ch_id, "name": ch_name})

    # XML निर्माण करणे
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="EliteBeam Python EPG">\n'

    for ch in valid_channels:
        xml += f'<channel id="{ch["xml_id"]}">\n  <display-name>{ch["name"]}</display-name>\n</channel>\n'

    # EPG डेटा गोळा करणे (सध्या चालू असलेले / नाॅन-एन्डेड प्रोग्राम्स)
    for ch in valid_channels:
        epg_url = f"{PORTAL_BASE}?type=itv&action=get_short_epg&tv_genre_id=0&not_ended=1&ch_id={ch['api_id']}&JsHttpRequest=1-xml"
        try:
            res = session.get(epg_url, headers=auth_headers, timeout=10)
            data = res.json()
            programmes = data.get("js", [])
            if isinstance(programmes, dict):
                programmes = programmes.get("data", [])

            for prog in programmes:
                start_ts = int(prog.get("start_timestamp", 0))
                stop_ts = int(prog.get("stop_timestamp", 0))
                if start_ts <= 0 || stop_ts <= start_ts:
                    continue

                title = prog.get("name", "Unknown")
                descr = prog.get("descr", "")

                start_str = datetime.fromtimestamp(start_ts, timezone.utc).strftime("%Y%m%d%H%M%S +0000")
                stop_str = datetime.fromtimestamp(stop_ts, timezone.utc).strftime("%Y%m%d%H%M%S +0000")

                xml += f'<programme start="{start_str}" stop="{stop_str}" channel="{ch["xml_id"]}">\n'
                xml += f'  <title lang="en">{title}</title>\n'
                if descr:
                    xml += f'  <desc lang="en">{descr}</desc>\n'
                xml += '</programme>\n'
        except Exception:
            continue

    xml += '</tv>'

    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        f.write(xml)
    print("EPG generated successfully!")

if __name__ == "__main__":
    main()
    
