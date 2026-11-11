
const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const fs = require('fs');
const zlib = require('zlib');
const xml2js = require('xml2js');

dayjs.extend(utc);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const parser = new xml2js.Parser();
const builder = new xml2js.Builder({
    xmldec: {
        version: '1.0',
        encoding: 'UTF-8'
    },
    renderOpts: {
        pretty: true,
        indent: '  ',
        newline: '\n'
    }
});

function escapeXML(value) {
    return String(value ?? '').replace(/[<>&'"]/g, c => ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;'
    })[c]);
}

function getText(value) {
    if (Array.isArray(value)) {
        return value[0] ?? '';
    }
    return value ?? '';
}

function extractArray(data) {
    const candidates = [
        data?.js?.data?.data,
        data?.js?.data,
        data?.js
    ];

    for (const item of candidates) {
        if (Array.isArray(item)) return item;
    }

    return [];
}

function normalizeName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/&amp;/g, '&')
        .replace(/[^a-z0-9]/g, '');
}

async function apiRequest(url, headers, timeout = 20000) {
    const response = await axios.get(url, {
        headers,
        timeout,
        responseType: 'text',
        transformResponse: [data => data]
    });

    if (typeof response.data !== 'string') {
        return response.data;
    }

    try {
        return JSON.parse(response.data);
    } catch {
        throw new Error('Invalid JSON response from Portal');
    }
}

async function generateMasterEPG() {

    console.log('Starting Master EPG Generation (Samsung + MAC)...');

    if (!fs.existsSync('./channels.json')) {
        throw new Error('channels.json not found!');
    }

    const channelsList = JSON.parse(
        fs.readFileSync('./channels.json', 'utf8')
    );

    if (!Array.isArray(channelsList)) {
        throw new Error('Invalid channels.json format');
    }

    const samsungChannels = channelsList.filter(
        ch => ch.source === 'samsungtvplus'
    );

    const macChannels = channelsList.filter(
        ch => ch.source === '4k.tvstb.me'
    );

    const managedIds = new Set(
        channelsList
            .map(ch => String(ch.channel_id || ''))
            .filter(Boolean)
    );

    const newChannels = [];
    const newProgrammes = [];

    const samsungIds = new Set(
        samsungChannels.map(ch => String(ch.channel_id))
    );

    // ==========================================
    // 1. CHANNEL DEFINITIONS
    // ==========================================

    for (const ch of channelsList) {

        if (!ch.channel_id || !ch.name) continue;

        const channel = {
            $: {
                id: String(ch.channel_id)
            },
            'display-name': [String(ch.name)]
        };

        if (ch.logo) {
            channel.icon = [{
                $: {
                    src: String(ch.logo)
                }
            }];
        }

        newChannels.push(channel);
    }

    // ==========================================
    // 2. SAMSUNG TV PLUS EPG
    // ==========================================

    console.log('Fetching Samsung TV Plus EPG...');

    try {

        const samsungResp = await axios.get(
            'https://i.mjh.nz/SamsungTVPlus/in.xml.gz',
            {
                responseType: 'arraybuffer',
                timeout: 30000
            }
        );

        const unzippedXml = zlib
            .gunzipSync(samsungResp.data)
            .toString('utf8');

        const parsedSamsung = await parser.parseStringPromise(
            unzippedXml
        );

        const samsungProgrammes =
            parsedSamsung?.tv?.programme || [];

        let samsungCount = 0;

        for (const prog of samsungProgrammes) {

            const chId = String(prog?.$?.channel || '');

            if (!samsungIds.has(chId)) continue;

            newProgrammes.push(prog);
            samsungCount++;
        }

        console.log(
            `Samsung EPG extracted: ${samsungCount} programmes`
        );

    } catch (err) {
        console.log('Samsung EPG Error:', err.message);
    }

    // ==========================================
    // 3. STALKER MAC PORTAL
    // ==========================================

    console.log('Connecting to MAC Portal...');

    const portalBase =
        'http://4k.tvstb.me/stalker_portal/server/load.php';

    // Use GitHub Repository Secrets
    const mac = process.env.STALKER_MAC || '';
    const sn = process.env.STALKER_SN || '';
    const deviceId = process.env.STALKER_DEVICE_ID || '';
    const deviceId2 = process.env.STALKER_DEVICE_ID2 || '';
    const signature = process.env.STALKER_SIGNATURE || '263';

    // Axios requires a key-value headers object
    const macHeaders = {
        'User-Agent':
            'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stb app ver: 2 rev: 250 Safari/533.3',

        'X-User-Agent': 'Model: MAG250; Link: WiFi',

        'Referer':
            'http://4k.tvstb.me/stalker_portal/c/',

        'Cookie':
            `mac=${mac}; stb_lang=en; timezone=Asia/Kolkata`,

        'Accept': 'application/json, text/javascript, */*'
    };

    if (macChannels.length > 0 && !mac) {
        throw new Error('STALKER_MAC GitHub Secret is missing');
    }

    if (macChannels.length > 0) {

        try {

            // 3.1 Handshake
            const handshakeUrl =
                `${portalBase}?type=stb&action=handshake` +
                `&prehash=${encodeURIComponent(mac)}` +
                '&token=&JsHttpRequest=1-xml';

            const hsResp = await apiRequest(
                handshakeUrl,
                macHeaders
            );

            const token =
                hsResp?.js?.token ||
                hsResp?.token ||
                '';

            if (!token) {
                throw new Error('Handshake Token Failed');
            }

            console.log('MAC Portal Handshake Successful');

            const authHeaders = {
                ...macHeaders,
                'Authorization': `Bearer ${token}`
            };

            // 3.2 Optional Profile Request
            if (sn && deviceId && deviceId2) {

                const profileUrl =
                    `${portalBase}?type=stb&action=get_profile` +
                    `&sn=${encodeURIComponent(sn)}` +
                    `&device_id=${encodeURIComponent(deviceId)}` +
                    `&device_id2=${encodeURIComponent(deviceId2)}` +
                    `&signature=${encodeURIComponent(signature)}` +
                    '&JsHttpRequest=1-xml';

                try {
                    await apiRequest(profileUrl, authHeaders);
                    console.log('Profile Request Completed');
                } catch (err) {
                    console.log('Profile Warning:', err.message);
                }
            }

            // 3.3 Get Channel List
            const channelsUrl =
                `${portalBase}?type=itv&action=get_all_channels` +
                '&JsHttpRequest=1-xml';

            const channelData = await apiRequest(
                channelsUrl,
                authHeaders
            );

            const allStalkerChannels = extractArray(channelData);

            if (!allStalkerChannels.length) {
                throw new Error('Stalker Channel List Empty');
            }

            console.log(
                `Portal Channels Found: ${allStalkerChannels.length}`
            );

            let matchedCount = 0;
            let programmeCount = 0;
            let unmatchedCount = 0;

            // 3.4 Match and Fetch EPG
            for (const targetCh of macChannels) {

                const targetName = normalizeName(targetCh.name);
                const targetId = String(targetCh.channel_id);

                const matched = allStalkerChannels.find(sc => {

                    if (!sc || typeof sc !== 'object') {
                        return false;
                    }

                    const portalName = normalizeName(sc.name);
                    const portalId = String(sc.id || '');

                    return (
                        (portalId && portalId === targetId) ||
                        (portalName && portalName === targetName)
                    );
                });

                if (!matched?.id) {

                    console.log(
                        `Channel Not Matched: ${targetCh.name}`
                    );

                    unmatchedCount++;
                    continue;
                }

                matchedCount++;

                console.log(
                    `Fetching EPG: ${targetCh.name} [${matched.id}]`
                );

                const epgUrl =
                    `${portalBase}?type=itv&action=get_short_epg` +
                    '&tv_genre_id=0&not_ended=1' +
                    `&ch_id=${encodeURIComponent(matched.id)}` +
                    '&JsHttpRequest=1-xml';

                try {

                    const epgJson = await apiRequest(
                        epgUrl,
                        authHeaders,
                        15000
                    );

                    const programmes = extractArray(epgJson);

                    let channelProgrammeCount = 0;

                    for (const prog of programmes) {

                        if (!prog || typeof prog !== 'object') {
                            continue;
                        }

                        const startTs = Number(
                            prog.start_timestamp || 0
                        );

                        const stopTs = Number(
                            prog.stop_timestamp || 0
                        );

                        if (
                            !Number.isFinite(startTs) ||
                            !Number.isFinite(stopTs) ||
                            startTs <= 0 ||
                            stopTs <= startTs
                        ) {
                            continue;
                        }

                        const start = dayjs
                            .unix(startTs)
                            .utc()
                            .format('YYYYMMDDHHmmss ZZ');

                        const stop = dayjs
                            .unix(stopTs)
                            .utc()
                            .format('YYYYMMDDHHmmss ZZ');

                        const programme = {
                            $: {
                                start,
                                stop,
                                channel: targetId
                            },
                            title: [
                                {
                                    _: String(prog.name || 'Unknown'),
                                    $: { lang: 'en' }
                                }
                            ]
                        };

                        if (prog.descr) {
                            programme.desc = [
                                {
                                    _: String(prog.descr),
                                    $: { lang: 'en' }
                                }
                            ];
                        }

                        newProgrammes.push(programme);
                        channelProgrammeCount++;
                    }

                    programmeCount += channelProgrammeCount;

                    console.log(
                        `EPG Found: ${channelProgrammeCount} programmes`
                    );

                } catch (err) {

                    console.log(
                        `EPG Error (${targetCh.name}): ${err.message}`
                    );
                }

                await sleep(250);
            }

            console.log(
                `MAC Summary: Matched=${matchedCount}, ` +
                `Programmes=${programmeCount}, ` +
                `Unmatched=${unmatchedCount}`
            );

        } catch (err) {

            console.log('MAC Portal Error:', err.message);
        }
    }

    // ==========================================
    // 4. MERGE INTO MASTER XML
    // ==========================================

    const targetFile = './epg/tataplay.xml';
    const gzipFile = './epg/tataplay.xml.gz';

    if (!fs.existsSync(targetFile)) {
        throw new Error('tataplay.xml not found for merging!');
    }

    console.log('Merging EPG into Master XML...');

    const existingXml = fs.readFileSync(
        targetFile,
        'utf8'
    );

    const master = await parser.parseStringPromise(existingXml);

    if (!master?.tv) {
        throw new Error('Invalid Master XML: tv root not found');
    }

    if (!Array.isArray(master.tv.channel)) {
        master.tv.channel = [];
    }

    if (!Array.isArray(master.tv.programme)) {
        master.tv.programme = [];
    }

    // Remove previously generated entries for managed IDs
    master.tv.channel = master.tv.channel.filter(ch => {
        const id = String(ch?.$?.id || '');
        return !managedIds.has(id);
    });

    master.tv.programme = master.tv.programme.filter(prog => {
        const id = String(prog?.$?.channel || '');
        return !managedIds.has(id);
    });

    // Add updated channels and programmes
    master.tv.channel.push(...newChannels);
    master.tv.programme.push(...newProgrammes);

    // Build final XML
    const finalXml = builder.buildObject(master);

    // Validate generated XML before writing
    await parser.parseStringPromise(finalXml);

    // Ensure output directory exists
    fs.mkdirSync('./epg', { recursive: true });

    // Write XML and GZIP
    const tempXml = targetFile + '.tmp';
    const tempGzip = gzipFile + '.tmp';

    fs.writeFileSync(tempXml, finalXml, 'utf8');

    fs.writeFileSync(
        tempGzip,
        zlib.gzipSync(Buffer.from(finalXml, 'utf8'))
    );

    fs.renameSync(tempXml, targetFile);
    fs.renameSync(tempGzip, gzipFile);

    console.log('----------------------------------');
    console.log('MASTER EPG GENERATION COMPLETED');
    console.log(`Channels Added: ${newChannels.length}`);
    console.log(`Programmes Added: ${newProgrammes.length}`);
    console.log('XML: epg/tataplay.xml');
    console.log('GZIP: epg/tataplay.xml.gz');
    console.log('----------------------------------');
}

generateMasterEPG().catch(err => {
    console.error('MASTER EPG FATAL ERROR:', err.message);
    process.exitCode = 1;
});
