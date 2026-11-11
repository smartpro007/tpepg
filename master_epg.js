
const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const xml2js = require('xml2js');

dayjs.extend(utc);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const parser = new xml2js.Parser({
    explicitArray: true,
    trim: true
});

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

// ==========================================
// 1. HELPERS
// ==========================================

function escapeXML(value) {
    return String(value ?? '').replace(/[<>&'"]/g, c => ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;'
    })[c]);
}

function normalizeName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/&amp;/g, '&')
        .replace(/[^a-z0-9]/g, '');
}

function extractArray(data) {

    const candidates = [
        data?.js?.data?.data,
        data?.js?.data,
        data?.js
    ];

    for (const item of candidates) {
        if (Array.isArray(item)) {
            return item;
        }
    }

    return [];
}

async function apiRequest(url, headers, timeout = 20000) {

    const response = await axios.get(url, {
        headers,
        timeout,
        responseType: 'text',
        transformResponse: [data => data]
    });

    if (typeof response.data === 'string') {

        try {
            return JSON.parse(response.data);
        } catch {
            throw new Error('Invalid JSON response');
        }
    }

    return response.data;
}

function loadJSON(file) {

    if (!fs.existsSync(file)) {
        throw new Error(`${file} not found!`);
    }

    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ==========================================
// 2. MAIN GENERATOR
// ==========================================

async function generateMasterEPG() {

    console.log('Starting Master EPG Generation (Samsung + MAC)...');

    // Load Configuration
    const config = loadJSON('./stalker.json');
    const channelsList = loadJSON('./channels.json');

    if (!Array.isArray(channelsList)) {
        throw new Error('Invalid channels.json format');
    }

    if (config.settings?.enabled === false) {
        console.log('EPG Generation Disabled in Configuration');
        return;
    }

    const portalBase = config.portal.base_url;

    const mac = config.device.mac;
    const sn = config.device.serial_number;
    const deviceId = config.device.device_id;
    const deviceId2 = config.device.device_id2;
    const signature = config.device.signature;

    const timeout = Number(
        config.settings?.request_timeout || 15000
    );

    const delay = Number(
        config.settings?.request_delay || 250
    );

    // Channel Groups
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

    // ==========================================
    // 3. CHANNEL XML
    // ==========================================

    for (const ch of channelsList) {

        if (!ch.channel_id || !ch.name) continue;

        const channel = {
            $: {
                id: String(ch.channel_id)
            },
            'display-name': [
                String(ch.name)
            ]
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
    // 4. SAMSUNG TV PLUS EPG
    // ==========================================

    console.log('Fetching Samsung TV Plus EPG...');

    if (samsungChannels.length > 0) {

        try {

            const samsungIds = new Set(
                samsungChannels.map(ch =>
                    String(ch.channel_id)
                )
            );

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

            const parsedSamsung =
                await parser.parseStringPromise(unzippedXml);

            const samsungProgrammes =
                parsedSamsung?.tv?.programme || [];

            let count = 0;

            for (const prog of samsungProgrammes) {

                const chId = String(
                    prog?.$?.channel || ''
                );

                if (!samsungIds.has(chId)) continue;

                newProgrammes.push(prog);
                count++;
            }

            console.log(
                `Samsung EPG extracted: ${count} programmes`
            );

        } catch (err) {

            console.log(
                'Samsung EPG Error:',
                err.message
            );
        }

    } else {
        console.log('No Samsung Channels Found');
    }

    // ==========================================
    // 5. STALKER MAC PORTAL
    // ==========================================

    console.log('Connecting to MAC Portal...');

    if (
        config.settings?.epg_enabled !== false &&
        macChannels.length > 0
    ) {

        try {

            if (!mac || !portalBase) {
                throw new Error('Portal URL or MAC missing in stalker.json');
            }

            // Headers Object
            const macHeaders = {

                'User-Agent':
                    config.headers?.user_agent || 'Mozilla/5.0',

                'X-User-Agent':
                    config.headers?.x_user_agent || 'Model: MAG250; Link: WiFi',

                'Referer':
                    config.portal.referer,

                'Cookie':
                    `mac=${mac}; stb_lang=${config.headers?.language || 'en'}; timezone=${config.headers?.timezone || 'Asia/Kolkata'}`,

                'Accept':
                    'application/json, text/javascript, */*'
            };

            // ----------------------------------
            // 5.1 HANDSHAKE
            // ----------------------------------

            const handshakeUrl =
                `${portalBase}?type=stb&action=handshake` +
                `&prehash=${encodeURIComponent(mac)}` +
                '&token=&JsHttpRequest=1-xml';

            const hsResp = await apiRequest(
                handshakeUrl,
                macHeaders,
                timeout
            );

            const token =
                hsResp?.js?.token ||
                hsResp?.token ||
                '';

            if (!token) {
                throw new Error('Handshake Token Failed');
            }

            console.log('MAC Portal Handshake Successful');

            // Authorization Headers
            const authHeaders = {
                ...macHeaders,
                'Authorization': `Bearer ${token}`
            };

            // ----------------------------------
            // 5.2 PROFILE
            // ----------------------------------

            if (sn && deviceId && deviceId2) {

                const profileUrl =
                    `${portalBase}?type=stb&action=get_profile` +
                    `&sn=${encodeURIComponent(sn)}` +
                    `&device_id=${encodeURIComponent(deviceId)}` +
                    `&device_id2=${encodeURIComponent(deviceId2)}` +
                    `&signature=${encodeURIComponent(signature || '263')}` +
                    '&JsHttpRequest=1-xml';

                try {

                    await apiRequest(
                        profileUrl,
                        authHeaders,
                        timeout
                    );

                    console.log('Profile Request Completed');

                } catch (err) {

                    console.log(
                        'Profile Warning:',
                        err.message
                    );
                }

            } else {

                console.log('Profile Configuration Incomplete');
            }

            // ----------------------------------
            // 5.3 GET ALL CHANNELS
            // ----------------------------------

            const channelsUrl =
                `${portalBase}?type=itv&action=get_all_channels` +
                '&JsHttpRequest=1-xml';

            const channelData = await apiRequest(
                channelsUrl,
                authHeaders,
                timeout
            );

            const allStalkerChannels = extractArray(channelData);

            if (!allStalkerChannels.length) {
                throw new Error('Stalker Channel List Empty');
            }

            console.log(
                `Portal Channels Found: ${allStalkerChannels.length}`
            );

            let matchedCount = 0;
            let unmatchedCount = 0;
            let programmeCount = 0;

            // ----------------------------------
            // 5.4 MATCH AND FETCH EPG
            // ----------------------------------

            for (const targetCh of macChannels) {

                const targetName = normalizeName(
                    targetCh.name
                );

                const targetId = String(
                    targetCh.channel_id
                );

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
                        timeout
                    );

                    const programmes = extractArray(epgJson);

                    let channelCount = 0;

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

                            title: [{
                                _: String(prog.name || 'Unknown'),
                                $: { lang: 'en' }
                            }]
                        };

                        if (prog.descr) {

                            programme.desc = [{
                                _: String(prog.descr),
                                $: { lang: 'en' }
                            }];
                        }

                        newProgrammes.push(programme);
                        channelCount++;
                    }

                    programmeCount += channelCount;

                    console.log(
                        `EPG Found: ${channelCount} programmes`
                    );

                } catch (err) {

                    console.log(
                        `EPG Error (${targetCh.name}): ${err.message}`
                    );
                }

                await sleep(delay);
            }

            console.log(
                `MAC Summary: Matched=${matchedCount}, ` +
                `Programmes=${programmeCount}, ` +
                `Unmatched=${unmatchedCount}`
            );

        } catch (err) {

            console.log(
                'MAC Portal Error:',
                err.message
            );
        }

    } else {

        console.log('MAC EPG Disabled or No MAC Channels');
    }

    // ==========================================
    // 6. MERGE INTO MASTER XML
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

    const master = await parser.parseStringPromise(
        existingXml
    );

    if (!master?.tv) {
        throw new Error('Invalid Master XML');
    }

    if (!Array.isArray(master.tv.channel)) {
        master.tv.channel = [];
    }

    if (!Array.isArray(master.tv.programme)) {
        master.tv.programme = [];
    }

    // Remove previous managed channels
    master.tv.channel = master.tv.channel.filter(ch => {

        const id = String(ch?.$?.id || '');

        return !managedIds.has(id);
    });

    // Remove previous managed programmes
    master.tv.programme = master.tv.programme.filter(prog => {

        const id = String(prog?.$?.channel || '');

        return !managedIds.has(id);
    });

    // Add updated channels
    master.tv.channel.push(...newChannels);

    // Add updated programmes
    master.tv.programme.push(...newProgrammes);

    // ==========================================
    // 7. BUILD AND VALIDATE XML
    // ==========================================

    const finalXml = builder.buildObject(master);

    // Validate XML before writing
    await parser.parseStringPromise(finalXml);

    fs.mkdirSync('./epg', {
        recursive: true
    });

    // ==========================================
    // 8. WRITE XML AND GZIP
    // ==========================================

    const tempXml = targetFile + '.tmp';
    const tempGzip = gzipFile + '.tmp';

    fs.writeFileSync(
        tempXml,
        finalXml,
        'utf8'
    );

    const gzipData = zlib.gzipSync(
        Buffer.from(finalXml, 'utf8')
    );

    fs.writeFileSync(
        tempGzip,
        gzipData
    );

    fs.renameSync(tempXml, targetFile);
    fs.renameSync(tempGzip, gzipFile);

    // ==========================================
    // 9. FINAL SUMMARY
    // ==========================================

    console.log('----------------------------------');
    console.log('MASTER EPG GENERATION COMPLETED');
    console.log('----------------------------------');

    console.log(`Channels Added: ${newChannels.length}`);
    console.log(`Programmes Added: ${newProgrammes.length}`);

    console.log(`Samsung Channels: ${samsungChannels.length}`);
    console.log(`MAC Channels: ${macChannels.length}`);

    console.log('XML: epg/tataplay.xml');
    console.log('GZIP: epg/tataplay.xml.gz');

    console.log('----------------------------------');
}

// ==========================================
// 10. RUN
// ==========================================

generateMasterEPG().catch(err => {

    console.error(
        'MASTER EPG FATAL ERROR:',
        err.message
    );

    process.exitCode = 1;
});
