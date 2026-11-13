import os
import json
import xml.etree.ElementTree as ET
import urllib.request
from datetime import datetime

CACHE_DIR = "Cache"
CACHE_FILE = os.path.join(CACHE_DIR, "epg.xml")
CHANNELS_FILE = "channels.json"
WORKER_EPG_URL = "https://epg.elitebeam9.workers.dev/epg.xml"

def clean_name(name):
    """नावामधील (4K), स्पेसेस आणि स्पेशलकॅरेक्टर्स काढून क्लिन करणे जेणेकरून मॅचिंग परफेक्ट होईल"""
    if not name:
        return ""
    import re
    # कंसातले (4K) किंवा इतर शब्द व एक्स्ट्रा स्पेसेस काढणे
    cleaned = re.sub(r'\(.*?\)', '', name)
    cleaned = re.sub(r'[^a-zA-Z0-9]', '', cleaned)
    return cleaned.upper()

def main():
    if not os.path.exists(CHANNELS_FILE):
        print("Error: channels.json not found!")
        return

    # 1. GitHub मधील channels.json वाचणे
    with open(CHANNELS_FILE, "r", encoding="utf-8") as f:
        channels_data = json.load(f)

    # मॅपिंग तयार करणे: { "CLEANED_NAME": {"id": "github_id", "name": "original_name"} }
    github_channels_map = {}
    for item in channels_data:
        if item.get("source", "4k.tvstb.me") != "4k.tvstb.me":
            continue
        ch_id = str(item.get("channel_id") or item.get("id") or "").strip()
        ch_name = str(item.get("name") or "").strip()
        if ch_id and ch_name:
            c_name = clean_name(ch_name)
            github_channels_map[c_name] = {
                "id": ch_id,
                "name": ch_name
            }

    if not github_channels_map:
        print("Error: No valid channels found in channels.json")
        return

    print(f"Loaded {len(github_channels_map)} channels from GitHub channels.json")

    # 2. Cloudflare Worker URL वरून EPG XML डाउनलोड करणे
    print(f"Fetching EPG data from Worker: {WORKER_EPG_URL}")
    try:
        req = urllib.request.Request(
            WORKER_EPG_URL, 
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            xml_data = response.read()
    except Exception as e:
        print(f"Error fetching EPG from Cloudflare Worker: {e}")
        return

    # 3. XML पार्स करणे
    try:
        root = ET.fromstring(xml_data)
    except Exception as e:
        print(f"Error parsing XML from Worker: {e}")
        return

    # चॅनेल आयडी मॅपिंग ट्रॅक करण्यासाठी डिक्शनरी: {worker_old_id -> github_new_id}
    id_replacement_map = {}
    matched_channels_xml = []

    # वर्करमधील चॅनेल्स तपासून GitHub च्या नावाशी मॅच करणे
    for channel in root.findall('channel'):
        old_id = channel.get('id')
        display_name_elem = channel.find('display-name')
        if display_name_elem is not None and display_name_elem.text:
            worker_name = display_name_elem.text.strip()
            c_worker_name = clean_name(worker_name)

            # GitHub च्या मॅपमध्ये शोधणे
            matched = github_channels_map.get(c_worker_name)
            
            # जर हुबेहूब नाही सापडला, तर सबस्ट्रिंग मॅच (Substring match) तपासणे
            if not matched:
                for g_cname, g_info in github_channels_map.items():
                    if g_cname in c_worker_name or c_worker_name in g_cname:
                        matched = g_info
                        break

            if matched:
                new_id = matched["id"]
                id_replacement_map[old_id] = new_id
                
                # नवीन आयडी आणि नाव सेट करणे
                channel.set('id', new_id)
                display_name_elem.text = matched["name"]
                matched_channels_xml.append(channel)
            else:
                # जर मॅच नाही झाला तर जुनाच ठेवू किंवा स्किप करू शकता
                pass

    print(f"Successfully matched and remapped {len(id_replacement_map)} channels.")

    # 4. Programme टॅग्जमधील चॅनेल आयडी अपडेट करणे
    updated_programmes = 0
    for programme in root.findall('programme'):
        old_prog_channel = programme.get('channel')
        if old_prog_channel in id_replacement_map:
            programme.set('channel', id_replacement_map[old_prog_channel])
            updated_programmes += 1

    print(f"Updated {updated_programmes} programme items with new GitHub channel IDs.")

    # फक्त्त मॅच झालेले चॅनेल्स आणि त्यांचे कार्यक्रम ठेवून नवीन XML स्ट्रक्चर बनवणे
    new_root = ET.Element('tv')
    new_root.set('generator-info-name', 'EliteBeam Smart Matched EPG')

    for ch in matched_channels_xml:
        new_root.append(ch)

    for prog in root.findall('programme'):
        # ज्या प्रोग्रामचे चॅनेल आपल्या मॅप केलेल्या યાદीत आहे, तेच ठेवणे
        if prog.get('channel') in id_replacement_map.values():
            new_root.append(prog)

    # 5. फाईल Cache फोल्डरमध्ये सेव्ह करणे
    os.makedirs(CACHE_DIR, exist_ok=True)
    
    # सुंदर आणि फॉरमॅटेड XML तयार करण्यासाठी
    tree = ET.ElementTree(new_root)
    ET.indent(tree, space="  ", level=0)
    tree.write(CACHE_FILE, encoding="utf-8", xml_declaration=True)

    print(f"EPG successfully generated and saved to {CACHE_FILE}!")

if __name__ == "__main__":
    main()
